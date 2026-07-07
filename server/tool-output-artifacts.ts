import { createLogger } from "./log";
import type { IndexSection } from "@shared/models/indexed-content";

const log = createLogger("ToolOutputArtifacts");

export type ToolOutputContentType = "text" | "json" | "table" | "log" | "html" | "binary" | "unknown";
export type ToolOutputAffordance = "read_section" | "search" | "paginate" | "download" | "fetch_full_if_user_approved";

export interface ToolOutputRef {
  kind: "tool_output_ref";
  refId: string;
  toolName: string;
  action?: string;
  createdAt: string;
  contentType: ToolOutputContentType;
  size: {
    chars: number;
    estimatedTokens: number;
    bytes?: number;
    itemCount?: number;
  };
  preview: string;
  affordances: ToolOutputAffordance[];
  sections?: Array<{
    index: number;
    title?: string;
    charStart: number;
    charEnd: number;
  }>;
}

export interface ToolOutputPolicy {
  maxInlineTokens: number;
  maxInlineChars: number;
  maxPreviewChars: number;
  forceArtifactTokens: number;
}

export interface ToolOutputSize {
  chars: number;
  estimatedTokens: number;
  bytes: number;
  itemCount?: number;
  contentType: ToolOutputContentType;
}

export const DEFAULT_TOOL_OUTPUT_POLICY: ToolOutputPolicy = {
  maxInlineTokens: Number(process.env.TOOL_OUTPUT_INLINE_TOKEN_BUDGET || 8_000),
  maxInlineChars: Number(process.env.TOOL_OUTPUT_MAX_INLINE_CHARS || 32_000),
  maxPreviewChars: Number(process.env.TOOL_OUTPUT_PREVIEW_CHAR_BUDGET || 4_000),
  forceArtifactTokens: Number(process.env.TOOL_OUTPUT_FORCE_ARTIFACT_TOKEN_BUDGET || 20_000),
};

export function isToolOutputRef(value: unknown): value is ToolOutputRef {
  return !!value && typeof value === "object" && (value as { kind?: unknown }).kind === "tool_output_ref";
}

export function estimateToolOutputSize(value: unknown): ToolOutputSize {
  const content = serializeToolOutput(value);
  const contentType = inferContentType(value, content);
  const itemCount = Array.isArray(value) ? value.length : undefined;
  return {
    chars: content.length,
    estimatedTokens: Math.ceil(content.length / 3.5),
    bytes: value instanceof Uint8Array || Buffer.isBuffer(value)
      ? value.byteLength
      : Buffer.byteLength(content, "utf-8"),
    itemCount,
    contentType,
  };
}

export function serializeToolOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) return `[binary output: ${value.byteLength} bytes]`;
  try {
    return stableStringify(value);
  } catch {
    return String(value);
  }
}

function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, nestedValue: unknown) => {
    if (!nestedValue || typeof nestedValue !== "object") return nestedValue;
    if (nestedValue instanceof Date) return nestedValue.toISOString();
    if (nestedValue instanceof Uint8Array || Buffer.isBuffer(nestedValue)) {
      return `[binary output: ${nestedValue.byteLength} bytes]`;
    }
    if (seen.has(nestedValue)) return "[Circular]";
    seen.add(nestedValue);
    if (Array.isArray(nestedValue)) return nestedValue;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(nestedValue).sort()) {
      sorted[key] = (nestedValue as Record<string, unknown>)[key];
    }
    return sorted;
  }, 2);
}

export function createToolOutputPreview(value: unknown, contentType: ToolOutputContentType, maxChars = DEFAULT_TOOL_OUTPUT_POLICY.maxPreviewChars): string {
  const content = serializeToolOutput(value);
  const sanitized = contentType === "html" ? content.replace(/<script[\s\S]*?<\/script>/gi, "") : content;
  if (sanitized.length <= maxChars) return sanitized;

  const headBudget = Math.max(0, Math.floor(maxChars * 0.75));
  const tailBudget = Math.max(0, maxChars - headBudget - 120);
  const head = sanitized.slice(0, headBudget).trimEnd();
  const tail = tailBudget > 0 ? sanitized.slice(-tailBudget).trimStart() : "";
  const omitted = sanitized.length - head.length - tail.length;
  return tail
    ? `${head}\n\n[... ${omitted.toLocaleString()} chars omitted from archived tool output ...]\n\n${tail}`
    : `${head}\n\n[... ${omitted.toLocaleString()} chars omitted from archived tool output ...]`;
}

export function formatToolOutputRef(ref: ToolOutputRef): string {
  const lines: string[] = [];
  lines.push(`📎 **Tool Output Archived** [ref:${ref.refId}]`);
  lines.push(`Tool: ${ref.toolName}${ref.action ? ` action=${ref.action}` : ""}`);
  lines.push(`Size: ${ref.size.chars.toLocaleString()} chars (~${ref.size.estimatedTokens.toLocaleString()} tokens) | Type: ${ref.contentType}`);
  if (ref.sections?.length) {
    lines.push(`Sections: ${ref.sections.length}`);
  }
  lines.push(`\n**Preview:**\n${ref.preview}`);
  lines.push(`\n_Use \`indexed_content\` with action="read_section" and id="${ref.refId}" to inspect the full output._`);
  return lines.join("\n");
}

export async function maybeOffloadToolOutput(args: {
  toolName: string;
  action?: string;
  sessionId?: string;
  runId?: string;
  result: string;
  error?: boolean;
  policy?: Partial<ToolOutputPolicy>;
}): Promise<string> {
  if (process.env.TOOL_OUTPUT_ARTIFACTS_ENABLED === "false") return args.result;
  if (args.error) return args.result;
  if (isToolOutputRefString(args.result)) return args.result;

  const policy = { ...DEFAULT_TOOL_OUTPUT_POLICY, ...(args.policy || {}) };
  const size = estimateToolOutputSize(args.result);
  const shouldOffload = size.contentType === "binary" || size.estimatedTokens > policy.maxInlineTokens || size.chars > policy.maxInlineChars;
  if (!shouldOffload) return args.result;

  const preview = createToolOutputPreview(args.result, size.contentType, policy.maxPreviewChars);
  const sourceLabel = [args.toolName, args.action, args.sessionId, args.runId].filter(Boolean).join("/") || args.toolName;

  try {
    const { indexAndArchiveHeuristic } = await import("./content-indexer");
    const ref = await indexAndArchiveHeuristic({
      content: args.result,
      sourceType: "tool_output",
      sourceLabel,
    });

    if (!ref) {
      log.error(`tool output archival failed tool=${args.toolName} action=${args.action || ""} sessionId=${args.sessionId || ""} runId=${args.runId || ""} chars=${size.chars}; returning bounded preview with full content unavailable`);
      return `${preview}\n\n[Tool output exceeded inline budget (${size.chars.toLocaleString()} chars) but archival failed; full content unavailable in transcript.]`;
    }

    const toolRef: ToolOutputRef = {
      kind: "tool_output_ref",
      refId: ref.id,
      toolName: args.toolName,
      action: args.action,
      createdAt: new Date().toISOString(),
      contentType: size.contentType,
      size: {
        chars: size.chars,
        estimatedTokens: size.estimatedTokens,
        bytes: size.bytes,
        itemCount: size.itemCount,
      },
      preview,
      affordances: ["read_section", "paginate", "download"],
      sections: mapSections(ref.index.sections) || sectionToolOutput(args.result, size.contentType),
    };

    log.log(`tool_output.offloaded tool=${args.toolName} action=${args.action || ""} refId=${ref.id} chars=${size.chars} estimatedTokens=${size.estimatedTokens} sessionId=${args.sessionId || ""} runId=${args.runId || ""}`);
    return formatToolOutputRef(toolRef);
  } catch (err) {
    log.error(`tool output archival exception tool=${args.toolName} action=${args.action || ""} sessionId=${args.sessionId || ""} runId=${args.runId || ""} chars=${size.chars}: ${err instanceof Error ? err.message : String(err)}`);
    return `${preview}\n\n[Tool output exceeded inline budget (${size.chars.toLocaleString()} chars) but archival failed; full content unavailable in transcript.]`;
  }
}

export function sectionToolOutput(value: unknown, contentType: ToolOutputContentType): ToolOutputRef["sections"] {
  const content = serializeToolOutput(value);
  if (!content) return undefined;
  if (contentType === "binary") return [{ index: 0, title: "Binary metadata", charStart: 0, charEnd: content.length }];

  const sections: NonNullable<ToolOutputRef["sections"]> = [];
  const lines = content.split("\n");
  let offset = 0;
  let start = 0;
  let title = "Introduction";

  for (const line of lines) {
    const heading = line.match(/^#{1,3}\s+(.+)/);
    if (heading && offset > start + 100) {
      sections.push({ index: sections.length, title, charStart: start, charEnd: offset });
      title = heading[1].trim();
      start = offset;
    }
    offset += line.length + 1;
  }

  sections.push({ index: sections.length, title, charStart: start, charEnd: content.length });

  if (sections.length === 1 && content.length > 2_000) {
    const chunkSize = Math.ceil(content.length / 4);
    return Array.from({ length: 4 }, (_, index) => {
      const charStart = index * chunkSize;
      const charEnd = Math.min(content.length, charStart + chunkSize);
      return { index, title: `Part ${index + 1}`, charStart, charEnd };
    }).filter(section => section.charStart < section.charEnd);
  }

  return sections;
}

function inferContentType(value: unknown, content: string): ToolOutputContentType {
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) return "binary";
  if (typeof value !== "string") return Array.isArray(value) ? "table" : "json";
  const trimmed = content.trim();
  if (/^</.test(trimmed) && /<\/?[a-z][\s\S]*>/i.test(trimmed)) return "html";
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) return "json";
  if (/\b(error|warn|info|debug)\b/i.test(content) && content.split("\n").length > 5) return "log";
  return "text";
}

function mapSections(sections: IndexSection[] | undefined): ToolOutputRef["sections"] {
  if (!sections) return undefined;
  return sections.map((section, index) => ({
    index,
    title: section.title,
    charStart: section.byteOffset,
    charEnd: section.byteOffset + section.byteLength,
  }));
}

function isToolOutputRefString(value: string): boolean {
  return value.includes("**Tool Output Archived**") && value.includes("[ref:");
}
