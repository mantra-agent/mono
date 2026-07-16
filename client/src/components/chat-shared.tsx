// Use createLogger for logging ONLY
import { createLogger } from "@/lib/logger";
import { cn } from "@/lib/utils";
import {
  formatDiagnosticError,
  formatDiagnosticValue,
} from "@/lib/diagnostic-error";
import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useLayoutEffect,
  useMemo,
  memo,
  createContext,
  useContext,
} from "react";
import { Link } from "wouter";
import { formatCost, formatTokens } from "@/lib/format-utils";
import {
  Loader2,
  MapPin,
  Wrench,
  Brain,
  AlertCircle,
  Copy,
  Check,
  Crown,
  Gauge,
  Zap,
  CheckCircle2,
  Download,
  ChevronRight,
  Users,
  BookOpen,
  Compass,
  MessageSquare,
  Calendar,
  Bookmark,
  ListChecks,
  NotebookPen,
  Briefcase,
  Star,
  ScrollText,
  Cog,
  AlertTriangle,
  History,
  Database,
  FileCode,
  Eye,
  Globe,
  Activity,
  Radio,
  Timer,
  Target,
  XCircle,
  RefreshCw,
  Wifi,
  WifiOff,
  Send,
  Bot,
  Mic,
  Phone,
} from "lucide-react";
import { resolveToolIcon } from "@/lib/tool-icons";
import { resolvePersonaIcon } from "@/lib/persona-icons";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/queryClient";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  AssistantMessageState,
  ChatStreamEvent,
  ToolCallInfo,
  ChildSessionBlockMeta,
  CrossSessionMeta,
  CompactionMeta,
  PageContext,
  SystemStepRecord,
} from "@shared/models/chat";
import { SYSTEM_STEP_META } from "@shared/event-catalog";

import type {
  ExecutionStep,
  MessageSegment,
  StreamingContent,
} from "@shared/streaming-types";
import { initialStreamingContent } from "@shared/streaming-types";
import { SegmentStream } from "@/components/segment-stream";

/** Filter execution steps by visibility layer. */
export function filterStepsByLayer(
  steps: ExecutionStep[],
  layer: 1 | 2 | 3 | 4,
  isActiveSession?: boolean,
): ExecutionStep[] {
  if (layer === 4) return steps;

  return steps.filter((step) => {
    if (step.type === "compacting") {
      // Legacy compacting events are still journaled for replay/debugging, but
      // the user-facing signal is the amber working_context_compression system
      // step. Rendering both creates duplicate compression notifications.
      return false;
    }

    if (step.type === "system") {
      if (step.systemStepName === "working_context_compression")
        return layer >= 2;
      if (step.systemStepName === "compaction") return layer >= 2;
      if (
        step.systemStepName?.startsWith("voice_error") ||
        step.systemStepName === "voice_disconnect" ||
        step.systemStepName === "voice_reconnect_attempt" ||
        step.systemStepName === "voice_reconnect_result" ||
        step.systemStepName === "voice_reconnect_exhausted"
      )
        return layer >= 2;
      return layer >= 4;
    }

    if (step.type === "thinking") {
      if (layer <= 2) {
        return (
          isActiveSession && step.status === "active" && !step.thinking?.trim()
        );
      }
      return layer >= 3;
    }

    if (step.type === "tool_call") {
      // Layer 1 ("Words Only") shows non-cognitive tool calls as compact icons
      if (layer === 1) {
        return step.toolName !== "think" && step.toolName !== "observe";
      }
      return layer >= 2;
    }

    return true;
  });
}
import { useVisibilityLayer } from "@/hooks/use-visibility-layer";
import { ReferenceText } from "@/components/references/reference-text";
import type { ReferenceSurface } from "@/components/references/reference-renderer";
import { EmailDraftWidget } from "@/components/email-draft-widget";
import { PlanWidget } from "@/components/plan-widget";
import type { PlanData } from "@/components/plan-shared";
import { parseReferenceText } from "@shared/reference-parser";

const log = createLogger("ChatShared");

export type { ChatStreamEvent, ToolCallInfo };

const EXPRESSION_TAG_REGEX =
  /(?:<[a-z][a-z\s,/]*>|(?<!!)\[[a-z][a-z\s,/]*\])/gi;
const VISIBLE_EXPRESSION_TAGS = new Set([
  "excited",
  "calm",
  "sighs",
  "laughs",
  "pause",
  "cheerfully",
  "whispers",
  "curious",
  "gravitas",
]);
const LEADING_EXPRESSION_TAG_REGEX = /^\s*\[([a-z]+)\]\s*/;

export function stripExpressionTags(text: string): string {
  return text.replace(EXPRESSION_TAG_REGEX, "").replace(/  +/g, " ").trim();
}

function parseLeadingExpressionTags(text: string): {
  tags: string[];
  remaining: string;
} {
  const tags: string[] = [];
  let remaining = text;

  while (true) {
    const match = remaining.match(LEADING_EXPRESSION_TAG_REGEX);
    if (!match) break;

    const tag = match[1];
    if (!VISIBLE_EXPRESSION_TAGS.has(tag)) break;

    tags.push(tag);
    remaining = remaining.slice(match[0].length);
  }

  return { tags, remaining };
}

const MESSAGE_TIMESTAMP_REGEX =
  /^\s*\[\d{4}-\d{2}-\d{2} \d{2}:\d{2} [^\]\n]+\]\s*/;

export function stripMessageTimestamp(text: string): string {
  return text.replace(MESSAGE_TIMESTAMP_REGEX, "");
}

export type SegmentChronologyEntry =
  | { s: "system"; i: number }
  | { s: "thinking"; c: string }
  | { s: "tool"; i: number }
  | { s: "content"; c: string }
  | { s: "compacting"; i: number };

export interface VoiceMessageMeta {
  source: "elevenlabs-voice";
  voiceSessionId: string;
  turnKey: string;
  /** Canonical per-turn correlation ID minted at turn acceptance. */
  turnId?: string;
  userOrdinal?: number;
  turnNumber?: number;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  thinking: string | null;
  toolCalls: ToolCallInfo[] | null;
  systemSteps: SystemStepRecord[] | null;
  model: string | null;
  createdAt: string;
  updatedAt?: string;
  cost?: number | null;
  apiCallCount?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  segmentChronology?: SegmentChronologyEntry[] | null;
  assistantState?: AssistantMessageState;
  assistantRunId?: string;
  isError?: boolean;
  childSession?: ChildSessionBlockMeta | null;
  crossSession?: CrossSessionMeta | null;
  compaction?: CompactionMeta | null;
  pageContext?: PageContext | null;
  voice?: VoiceMessageMeta | null;
  /** Persona that produced this assistant turn. */
  persona?: { id: number; name: string; icon: string } | null;
  /** Speaker attribution for meeting transcript messages. */
  speaker?: { label: string; personId?: string } | null;
  /** Canonical per-turn correlation ID for voice turns. */
  turnId?: string;
  /** Structural visibility discriminant — 'diagnostic' messages are hidden from chat */
  visibility?: "chat" | "diagnostic";
}

export type { ChildSessionBlockMeta, CrossSessionMeta };

const TIER_ICON_MAP: Record<string, typeof Brain> = {
  max: Crown,
  high: Brain,
  balanced: Gauge,
  fast: Zap,
};

const TIER_LABEL_MAP: Record<string, string> = {
  max: "Max",
  high: "High",
  balanced: "Balanced",
  fast: "Fast",
};

function useModelToTier(): (model: string) => string | null {
  const { data } = useQuery<{ tiers: Array<{ id: string; model: string }> }>({
    queryKey: ["/api/models/tiers"],
    staleTime: 60_000,
  });

  return useCallback(
    (model: string) => {
      if (!data?.tiers) return null;
      const tier = data.tiers.find((t) => t.model === model);
      return tier?.id ?? null;
    },
    [data],
  );
}

function ModelTierBadge({ model }: { model: string | null }) {
  const resolveModelToTier = useModelToTier();
  if (!model) return null;

  const tierId = resolveModelToTier(model);
  if (!tierId) return null;

  const Icon = TIER_ICON_MAP[tierId];
  const label = TIER_LABEL_MAP[tierId];
  if (!Icon || !label) return null;

  const shortModel = model.includes("/")
    ? model.split("/").slice(1).join("/")
    : model;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex items-center"
          data-testid={`badge-model-tier-${tierId}`}
        >
          <Icon className="h-2.5 w-2.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground ml-1.5">{shortModel}</span>
      </TooltipContent>
    </Tooltip>
  );
}

export type { ExecutionStep, MessageSegment } from "@shared/streaming-types";
export type { StreamingSource } from "@shared/streaming-types";
export type { ExecutionStepType } from "@shared/streaming-types";

function getToolSummary(toolName: string, args?: Record<string, any>): string {
  const name = toolName.toLowerCase();
  if (args) {
    if (args.command) {
      const cmdStr =
        typeof args.command === "string" ? args.command : String(args.command);
      const cmd = cmdStr.slice(0, 60);
      return `Running \`${cmd}${cmdStr.length > 60 ? "..." : ""}\``;
    }
    if (args.action) {
      const action = String(args.action);
      const targetKeys = [
        "title",
        "name",
        "shortName",
        "query",
        "file",
        "path",
        "fileName",
        "filePath",
        "file_path",
        "filename",
        "summary",
        "claim",
        "key",
        "subject",
        "to",
        "id",
        "goalId",
        "actorId",
        "slug",
        "target",
        "symbol_name",
        "url",
        "content",
      ];
      let target = "";
      for (const k of targetKeys) {
        const v = args[k];
        if (
          v &&
          k !== "action" &&
          (typeof v === "string" || typeof v === "number")
        ) {
          const val = String(v);
          target = val.length > 60 ? val.slice(0, 57) + "..." : val;
          break;
        }
      }
      if (target) return `${action}: ${target}`;
      return action;
    }
    if (args.path || args.file_path || args.filename) {
      const filePath = args.path || args.file_path || args.filename;
      if (name.includes("read") || name.includes("view"))
        return `Reading ${filePath}`;
      if (name.includes("write") || name.includes("create"))
        return `Writing ${filePath}`;
      if (name.includes("edit") || name.includes("update"))
        return `Editing ${filePath}`;
      if (name.includes("delete") || name.includes("remove"))
        return `Deleting ${filePath}`;
    }
    if (args.query || args.search || args.pattern) {
      const q = args.query || args.search || args.pattern;
      return `Searching for "${typeof q === "string" ? q.slice(0, 50) : q}"`;
    }
    if (args.url) {
      return `Fetching ${args.url}`;
    }
  }
  const prettyName = toolName
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  if (args) {
    const fallbackKeys = [
      "action",
      "command",
      "query",
      "search",
      "pattern",
      "subcommand",
      "op",
      "operation",
      "mode",
      "kind",
      "type",
    ];
    for (const k of fallbackKeys) {
      const v = args[k];
      if (v && (typeof v === "string" || typeof v === "number")) {
        const val = String(v);
        const trimmed = val.length > 60 ? val.slice(0, 57) + "..." : val;
        return `${prettyName}: ${trimmed}`;
      }
    }
  }
  return prettyName;
}

function truncateResult(result: any, maxLen = 200): string {
  if (result === null || result === undefined) return "";
  try {
    const str = typeof result === "string" ? result : JSON.stringify(result);
    const oneLine = str.replace(/\n/g, " ").trim();
    if (!oneLine) return "";
    return oneLine.length > maxLen ? oneLine.slice(0, maxLen) + "..." : oneLine;
  } catch {
    return "(result)";
  }
}

function formatArgsAsKeyValue(
  args: Record<string, any>,
): { key: string; value: string }[] {
  return Object.entries(args).map(([key, value]) => ({
    key,
    value: typeof value === "string" ? value : JSON.stringify(value, null, 2),
  }));
}

function formatFullResult(result: any): string {
  return formatDiagnosticValue(result);
}

function formatToolError(error: unknown, result: unknown): string {
  return formatDiagnosticError(
    error,
    result,
    "Tool call failed without an error message.",
  );
}

function getToolErrorText(
  tool: Pick<ToolCallInfo, "error" | "result">,
): string | undefined {
  if (!tool.error) return undefined;
  return formatToolError(tool.error, tool.result);
}

function extractToolComment(
  toolName: string,
  args?: Record<string, any>,
): string | null {
  if (!args) return null;
  if (typeof args.reasoning === "string" && args.reasoning.trim()) {
    return args.reasoning.trim();
  }
  const name = toolName.toLowerCase();
  if (
    name === "shell" ||
    name === "bash" ||
    name === "exec" ||
    name === "run_command" ||
    name === "execute_command"
  ) {
    const cmd = args.command;
    if (typeof cmd === "string") {
      const match = cmd.match(/^\s*#\s*(.+)/);
      if (match) return match[1].trim();
    }
  }
  return null;
}

type PhoneConfirmationResult = {
  kind: "phone_call_confirmation";
  status: "awaiting_confirmation";
  confirmationToken: string;
  personId: string;
  personName: string;
  phoneNumber: string;
  expiresAt: string;
};

function parsePhoneConfirmation(
  result: unknown,
): PhoneConfirmationResult | null {
  try {
    const value = typeof result === "string" ? JSON.parse(result) : result;
    if (
      !value ||
      typeof value !== "object" ||
      (value as { kind?: string }).kind !== "phone_call_confirmation"
    )
      return null;
    return value as PhoneConfirmationResult;
  } catch {
    return null;
  }
}

function PhoneCallConfirmationChip({
  confirmation,
}: {
  confirmation: PhoneConfirmationResult;
}) {
  const [state, setState] = useState<"ready" | "calling" | "called" | "error">(
    "ready",
  );
  const [detail, setDetail] = useState("");
  const confirm = async () => {
    setState("calling");
    try {
      const response = await apiRequest("POST", "/api/agent/tools/phone_call", {
        arguments: {
          action: "confirm",
          confirmationToken: confirmation.confirmationToken,
          reasoning: `User confirmed calling ${confirmation.personName}`,
        },
      });
      const body = (await response.json()) as {
        result?: string;
        error?: boolean;
      };
      if (body.error) throw new Error(body.result || "Call failed");
      const result = body.result
        ? (JSON.parse(body.result) as { status?: string })
        : {};
      setDetail(result.status ? `Call ${result.status}` : "Call started");
      setState("called");
    } catch (error) {
      setDetail(error instanceof Error ? error.message : "Call failed");
      setState("error");
    }
  };
  return (
    <div
      className="ml-7 my-2 flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2"
      data-testid="phone-call-confirmation"
    >
      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-active/10">
        <Phone className="h-4 w-4 text-active" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">
          Call {confirmation.personName}?
        </div>
        <div className="text-xs text-muted-foreground">
          {confirmation.phoneNumber}
        </div>
        {detail && (
          <div
            className={`text-xs ${state === "error" ? "text-error" : "text-success"}`}
          >
            {detail}
          </div>
        )}
      </div>
      <Button
        size="sm"
        onClick={confirm}
        disabled={state !== "ready"}
        data-testid="button-confirm-phone-call"
      >
        {state === "calling" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : state === "called" ? (
          "Called"
        ) : (
          "Call"
        )}
      </Button>
    </div>
  );
}

function ToolStepRow({
  step,
  iconOverrides,
  summaryOnly,
  layer,
  children = [],
  depth = 0,
}: {
  step: ExecutionStep;
  iconOverrides?: Record<string, string>;
  summaryOnly?: boolean;
  layer?: 1 | 2 | 3 | 4;
  children?: ExecutionStep[];
  depth?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const ToolIcon = resolveToolIcon(step.toolName || "", iconOverrides);
  const isActive = step.status === "active";
  const isDone = step.status === "done";
  const isError = step.status === "error";

  const summary = getToolSummary(step.toolName || "", step.arguments);
  const resultPreview = isDone ? truncateResult(step.result) : "";
  const errorText = isError ? formatToolError(step.error, step.result) : "";
  const errorPreview = isError ? truncateResult(errorText) : "";
  const rawToolName = step.toolName || "";
  const effectiveLayer = layer ?? 4;
  const reasoning = step.arguments?.reasoning;
  const hasReasoning = typeof reasoning === "string" && reasoning.trim();
  const comment = extractToolComment(rawToolName, step.arguments);
  const toolLabel = effectiveLayer <= 3 && comment ? comment : rawToolName;
  const isDetailLayer = effectiveLayer === 2;

  const iconColor = isError
    ? "text-error"
    : isDone
      ? "text-success"
      : isActive
        ? "text-active"
        : "text-info";
  const bgColor = isError
    ? "bg-error/10"
    : isDone
      ? "bg-success/10"
      : isActive
        ? "bg-active/15"
        : "bg-info/15";
  const canExpand = !summaryOnly && (isDone || isError) && !isDetailLayer;

  const phoneConfirmation =
    rawToolName === "phone_call" && isDone
      ? parsePhoneConfirmation(step.result)
      : null;

  const filteredArgs = step.arguments
    ? Object.fromEntries(
        Object.entries(step.arguments).filter(([k]) => k !== "reasoning"),
      )
    : {};

  return (
    <div
      className="animate-in fade-in slide-in-from-bottom-1 duration-200"
      data-testid={`timeline-step-${step.id}`}
    >
      <div
        className={`flex items-center gap-2 text-xs py-1 ${canExpand ? "cursor-pointer rounded-md hover-elevate" : ""}`}
        style={{ paddingLeft: `${6 + depth * 20}px` }}
        onClick={canExpand ? () => setExpanded(!expanded) : undefined}
        data-testid={`button-expand-tool-${step.id}`}
      >
        <div
          className={`relative flex items-center justify-center h-5 w-5 rounded-full shrink-0 ${bgColor}`}
        >
          <ToolIcon className={`h-3 w-3 ${iconColor}`} />
          {isActive && (
            <span className="absolute inset-0 rounded-full animate-ping bg-active/20" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          {isDetailLayer ? (
            <>
              {hasReasoning ? (
                <span
                  className={`break-words whitespace-normal block ${isActive ? "text-foreground" : "text-muted-foreground"}`}
                >
                  {reasoning}
                </span>
              ) : (
                <span className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-xs text-muted-foreground/40 font-mono">
                    {rawToolName}
                  </span>
                  <span
                    className={`truncate ${isActive ? "text-foreground" : "text-muted-foreground"}`}
                  >
                    {summary}
                  </span>
                </span>
              )}
              {errorPreview && (
                <span
                  className="text-xs text-error/80 break-words whitespace-normal block"
                  data-testid={`tool-error-${step.id}`}
                >
                  {errorPreview}
                </span>
              )}
            </>
          ) : (
            <>
              <span className="flex items-center gap-1.5 flex-wrap">
                <span className="text-xs text-muted-foreground/40 font-mono">
                  {toolLabel}
                </span>
                <span
                  className={`truncate ${isActive ? "text-foreground" : "text-muted-foreground"}`}
                >
                  {summary}
                </span>
              </span>
              {!expanded && !summaryOnly && resultPreview && (
                <span
                  className="text-xs text-muted-foreground/50 truncate block"
                  data-testid={`tool-result-${step.id}`}
                >
                  {resultPreview}
                </span>
              )}
              {!expanded && errorPreview && (
                <span
                  className="text-xs text-error/80 break-words whitespace-normal block"
                  data-testid={`tool-error-${step.id}`}
                >
                  {errorPreview}
                </span>
              )}
            </>
          )}
        </div>
        {(isDone || isError) && step.elapsedMs != null && (
          <span className="text-xs tabular-nums font-mono text-muted-foreground/50 whitespace-nowrap">
            {formatStepElapsed(step.selfTimeMs ?? step.elapsedMs)} self ·{" "}
            {formatStepElapsed(step.elapsedMs)} total
          </span>
        )}
        {canExpand && (
          <ChevronRight
            className={`h-3 w-3 text-muted-foreground/40 shrink-0 transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
          />
        )}
      </div>
      {phoneConfirmation && (
        <PhoneCallConfirmationChip confirmation={phoneConfirmation} />
      )}
      {expanded && (
        <div
          className="ml-7 mt-1 mb-2 space-y-2 text-xs"
          data-testid={`tool-expanded-${step.id}`}
        >
          {Object.keys(filteredArgs).length > 0 && (
            <div>
              <span className="text-xs text-muted-foreground/50 font-medium uppercase tracking-wider">
                Arguments
              </span>
              <div className="mt-0.5 space-y-0.5">
                {formatArgsAsKeyValue(filteredArgs).map(({ key, value }) => (
                  <div key={key} className="flex gap-2">
                    <span className="text-muted-foreground/60 font-mono shrink-0">
                      {key}:
                    </span>
                    <span className="text-muted-foreground break-all whitespace-pre-wrap font-mono">
                      {value}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {isDone && step.result != null && (
            <div>
              <span className="text-xs text-muted-foreground/50 font-medium uppercase tracking-wider">
                Result
              </span>
              <pre className="mt-0.5 text-xs text-muted-foreground bg-muted rounded-md p-2 overflow-x-auto max-h-60 overflow-y-auto whitespace-pre-wrap break-all font-mono">
                {formatFullResult(step.result)}
              </pre>
            </div>
          )}
          {isError && errorText && (
            <div>
              <span className="text-xs text-error/70 font-medium uppercase tracking-wider">
                Error
              </span>
              <pre className="mt-0.5 text-xs text-error/70 bg-error/5 rounded-md p-2 overflow-x-auto max-h-60 overflow-y-auto whitespace-pre-wrap break-all font-mono">
                {errorText}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ThoughtBubble({ step }: { step: ExecutionStep }) {
  const args = step.arguments as Record<string, string> | undefined;
  const thoughtType = args?.type || "pattern";
  const content =
    args?.content || (typeof step.result === "string" ? step.result : "");
  const isActive = step.status === "active";

  const badgeConfig: Record<
    string,
    { label: string; color: string; bg: string }
  > = {
    pattern: {
      label: "Pattern",
      color: "text-muted-foreground",
      bg: "bg-muted/60",
    },
    gap: { label: "Gap", color: "text-muted-foreground", bg: "bg-muted/60" },
    change: {
      label: "Change",
      color: "text-muted-foreground",
      bg: "bg-muted/60",
    },
    connection: {
      label: "Connection",
      color: "text-muted-foreground",
      bg: "bg-muted/60",
    },
    opportunity: {
      label: "Opportunity",
      color: "text-muted-foreground",
      bg: "bg-muted/60",
    },
    thought: {
      label: "Thought",
      color: isActive ? "text-active" : "text-muted-foreground",
      bg: isActive ? "bg-active/15" : "bg-muted/60",
    },
  };
  const badge = badgeConfig[thoughtType] || badgeConfig.pattern;

  if (!content && isActive) {
    return (
      <div
        className="animate-in fade-in slide-in-from-bottom-1 duration-200 px-1.5 py-1"
        data-testid={`thought-bubble-${step.id}`}
      >
        <div className="flex items-center gap-1.5">
          <div className="relative flex items-center justify-center h-5 w-5 rounded-full shrink-0 bg-active/15">
            <Eye className="h-3 w-3 text-active" />
            <span className="absolute inset-0 rounded-full animate-ping bg-active/20" />
          </div>
          <span className="text-xs text-muted-foreground/40">Observing...</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className="animate-in fade-in slide-in-from-bottom-1 duration-200 px-1.5 py-1"
      data-testid={`thought-bubble-${step.id}`}
    >
      <div className={`rounded-lg ${badge.bg} border border-white/5 px-3 py-2`}>
        <div className="flex items-center gap-1.5 mb-1">
          <Eye className={`h-3 w-3 ${badge.color}`} />
          <span
            className={`text-xs font-semibold uppercase tracking-wider ${badge.color}`}
          >
            {badge.label}
          </span>
        </div>
        <p className="text-xs text-foreground leading-relaxed">{content}</p>
      </div>
    </div>
  );
}

function CompactingStep({ step }: { step: ExecutionStep }) {
  const isDone = step.status === "done";
  const isError = step.status === "error";
  return (
    <div
      className="animate-in fade-in slide-in-from-bottom-1 duration-200 px-1.5 py-1"
      data-testid={`timeline-step-${step.id}`}
    >
      <div className="flex items-center gap-1.5">
        <div
          className={`relative flex items-center justify-center h-5 w-5 rounded-full shrink-0 ${isDone ? "bg-success/10" : isError ? "bg-error/10" : "bg-warning/15"}`}
        >
          {isDone ? (
            <Check className="h-3 w-3 text-success" />
          ) : isError ? (
            <AlertTriangle className="h-3 w-3 text-error" />
          ) : (
            <>
              <Loader2 className="h-3 w-3 text-warning" />
              <span className="absolute inset-0 rounded-full animate-ping bg-warning/20" />
            </>
          )}
        </div>
        <span
          className={`text-xs italic ${isError ? "text-error/60" : "text-muted-foreground/60"}`}
        >
          {step.thinking || "Compacting context..."}
        </span>
      </div>
    </div>
  );
}

const THINKING_LABEL = "Thinking...";
function ThinkingWaveText() {
  return (
    <span
      className="text-xs italic whitespace-nowrap"
      aria-label={THINKING_LABEL}
    >
      {Array.from(THINKING_LABEL).map((char, index) => (
        <span
          key={`${char}-${index}`}
          className="inline-block animate-[thinking-wave_1.35s_ease-in-out_infinite]"
          style={{ animationDelay: `${index * 70}ms` }}
          aria-hidden="true"
        >
          {char === " " ? "\u00A0" : char}
        </span>
      ))}
    </span>
  );
}

export function ActiveThinkingStatus({
  startTime,
  testId,
  showTimer = true,
}: {
  startTime: number;
  testId?: string;
  showTimer?: boolean;
}) {
  return (
    <div
      className="flex items-center gap-1.5 text-active animate-pulse"
      data-testid={testId}
    >
      <div className="relative flex items-center justify-center h-5 w-5 rounded-full shrink-0 bg-active/15">
        <Brain className="h-3 w-3" />
        <span className="absolute inset-0 rounded-full animate-ping bg-active/20" />
      </div>
      <ThinkingWaveText />
      {showTimer && <ThinkingTimer startTime={startTime} />}
    </div>
  );
}

function isGenericThinkingContent(content: string): boolean {
  const normalized = content.trim();
  return normalized === THINKING_LABEL || normalized === "Thinking…";
}

function ThinkingNarrative({ step }: { step: ExecutionStep }) {
  const content = step.thinking || "";
  const isActive = step.status === "active";

  if (!content && !isActive) return null;

  if (isActive && isGenericThinkingContent(content)) {
    return (
      <div
        className="animate-in fade-in slide-in-from-bottom-1 duration-200 px-1.5 py-1"
        data-testid={`timeline-step-${step.id}`}
      >
        <ActiveThinkingStatus startTime={step.timestamp} />
      </div>
    );
  }

  return (
    <div
      className="animate-in fade-in slide-in-from-bottom-1 duration-200 px-1.5 py-1"
      data-testid={`timeline-step-${step.id}`}
    >
      {content ? (
        <div className="text-xs text-muted-foreground/70 italic break-words leading-relaxed prose prose-sm dark:prose-invert max-w-none [&_*]:text-muted-foreground/70 [&_p]:my-0.5 [&_ul]:my-0.5 [&_ol]:my-0.5 [&_li]:my-0 [&_pre]:bg-muted [&_pre]:rounded-md [&_pre]:p-2 [&_pre]:overflow-x-auto [&_pre]:text-xs [&_code]:text-xs [&_code]:font-mono [&_h1]:text-xs [&_h2]:text-xs [&_h3]:text-xs [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_blockquote]:border-l-muted-foreground/30 [&_a]:text-muted-foreground/70 [&_table]:text-xs">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          {isActive && (
            <span className="animate-pulse text-active ml-0.5">|</span>
          )}
        </div>
      ) : isActive ? (
        <ActiveThinkingStatus startTime={step.timestamp} />
      ) : null}
    </div>
  );
}

function ThinkingBubble({
  step,
  showTimer = true,
}: {
  step: ExecutionStep;
  showTimer?: boolean;
}) {
  const content = step.thinking || "";
  const isActive = step.status === "active";

  if (!content && !isActive) return null;

  if (isActive && isGenericThinkingContent(content)) {
    return (
      <div
        className="animate-in fade-in slide-in-from-bottom-1 duration-200 px-1.5 py-1"
        data-testid={`thinking-bubble-${step.id}`}
      >
        <ActiveThinkingStatus
          startTime={step.timestamp}
          showTimer={showTimer}
        />
      </div>
    );
  }

  if (!content && isActive) {
    return (
      <div
        className="animate-in fade-in slide-in-from-bottom-1 duration-200 px-1.5 py-1"
        data-testid={`thinking-bubble-${step.id}`}
      >
        <ActiveThinkingStatus
          startTime={step.timestamp}
          showTimer={showTimer}
        />
      </div>
    );
  }

  return (
    <div
      className="animate-in fade-in slide-in-from-bottom-1 duration-200 px-1.5 py-1"
      data-testid={`thinking-bubble-${step.id}`}
    >
      <div className="rounded-xl rounded-bl-sm border border-primary/20 bg-card/70 px-3 py-2 text-xs italic text-foreground/70 leading-relaxed prose prose-sm dark:prose-invert max-w-none [&_*]:text-foreground/70 [&_p]:my-0.5 [&_ul]:my-0.5 [&_ol]:my-0.5 [&_li]:my-0 [&_pre]:bg-muted [&_pre]:rounded-md [&_pre]:p-2 [&_pre]:overflow-x-auto [&_pre]:text-xs [&_code]:text-xs [&_code]:font-mono [&_h1]:text-xs [&_h2]:text-xs [&_h3]:text-xs [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        {isActive && (
          <span className="animate-pulse text-active/70 ml-0.5 not-italic">
            |
          </span>
        )}
      </div>
    </div>
  );
}

function formatStepElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function SystemStepTimer({ startTime }: { startTime: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(interval);
  }, []);
  return (
    <span
      className="text-xs tabular-nums font-mono text-muted-foreground/40"
      data-testid="text-system-step-timer"
    >
      {formatStepElapsed(now - startTime)}
    </span>
  );
}

const SYSTEM_STEP_ICONS: Record<string, typeof Brain> = {
  orientation: Compass,
  orientation_llm_call: Send,
  model_selection: Gauge,
  context_assembly: Brain,
  ctx_history: History,
  ctx_history_load: Database,
  ctx_history_tokens: Gauge,
  ctx_history_repair: Wrench,
  ctx_history_compact: Cog,
  ctx_wm_identity: Compass,
  ctx_wm_people: Users,
  ctx_pri_goals: Target,
  ctx_pri_today: ListChecks,
  ctx_pri_week: Calendar,
  ctx_pri_month: Bookmark,

  ctx_pri_principles: Star,
  ctx_pri_rules: ScrollText,
  ctx_pri_journal: NotebookPen,
  ctx_wm_work: Briefcase,
  ctx_wm_calendar: Calendar,
  ctx_wm_beliefs: BookOpen,
  ctx_wm_session: History,
  ctx_memory: Database,
  ctx_skills_tools: Wrench,
  ctx_render: FileCode,
  contextAssembly: Brain,
  llm_call: Send,
  llm_request_sent: Send,
  llm_wait_provider: Radio,
  llm_wait_first_token: Timer,
  llm_receive_stream: Activity,
  llm_connected: Wifi,
  llm_headers: Radio,
  compaction: Cog,
  working_context_compression: AlertTriangle,
  first_token: Zap,
  greeting: MessageSquare,
  signedUrl: Globe,
  voice_turn_boundary: Radio,
  voice_context_assembly: Brain,
  voice_filler_sent: Timer,
  voice_llm_first_delta: Zap,
  voice_llm_timeout: AlertTriangle,
  voice_turn_complete: CheckCircle2,
  voice_turn_aborted: XCircle,
  voice_circuit_breaker: AlertTriangle,
  voice_backpressure: Activity,
  voice_session_health: Activity,
  voice_duplicate_message: RefreshCw,
  voice_error: AlertCircle,
  voice_disconnect: WifiOff,
  voice_reconnect_attempt: RefreshCw,
  voice_reconnect_result: Wifi,
  voice_reconnect_exhausted: WifiOff,
  voice_grace_window: Timer,
  voice_prefix_continuation: RefreshCw,
};

function getChildren(
  step: ExecutionStep,
  allSteps: ExecutionStep[],
): ExecutionStep[] {
  return allSteps.filter((candidate) => candidate.parentId === step.id);
}

function getStepDuration(step: ExecutionStep): number | undefined {
  if (step.timingKind === "milestone") return undefined;
  if (step.startedAt != null && step.endedAt != null)
    return Math.max(0, step.endedAt - step.startedAt);
  return step.elapsedMs;
}

function coveredChildDuration(
  step: ExecutionStep,
  children: ExecutionStep[],
): number {
  if (step.startedAt == null || step.endedAt == null) return 0;
  const intervals = children
    .filter(
      (child) =>
        child.timingKind !== "milestone" &&
        child.startedAt != null &&
        child.endedAt != null,
    )
    .map(
      (child) =>
        [
          Math.max(step.startedAt!, child.startedAt!),
          Math.min(step.endedAt!, child.endedAt!),
        ] as const,
    )
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
  if (intervals.length === 0) return 0;
  let covered = 0;
  let [start, end] = intervals[0];
  for (const [nextStart, nextEnd] of intervals.slice(1)) {
    if (nextStart <= end) end = Math.max(end, nextEnd);
    else {
      covered += end - start;
      start = nextStart;
      end = nextEnd;
    }
  }
  return covered + end - start;
}

function getStepUnattributedTime(
  step: ExecutionStep,
  children: ExecutionStep[],
): number | undefined {
  const duration = getStepDuration(step);
  if (duration == null || children.length === 0) return undefined;
  if (step.startedAt == null || step.endedAt == null) return step.selfTimeMs;
  return Math.max(0, duration - coveredChildDuration(step, children));
}

function hasOverlappingChildren(children: ExecutionStep[]): boolean {
  const intervals = children
    .filter(
      (child) =>
        child.timingKind !== "milestone" &&
        child.startedAt != null &&
        child.endedAt != null,
    )
    .map((child) => [child.startedAt!, child.endedAt!] as const)
    .sort((a, b) => a[0] - b[0]);
  let latestEnd = Number.NEGATIVE_INFINITY;
  for (const [start, end] of intervals) {
    if (start < latestEnd) return true;
    latestEnd = Math.max(latestEnd, end);
  }
  return false;
}

function SystemStepRow({
  step,
  layer = 4,
  children = [],
  parentStartedAt,
  depth = 0,
}: {
  step: ExecutionStep;
  layer?: 1 | 2 | 3 | 4;
  children?: ExecutionStep[];
  parentStartedAt?: number;
  depth?: number;
}) {
  const name = step.systemStepName || "unknown";
  const meta = SYSTEM_STEP_META[name];
  const Icon = SYSTEM_STEP_ICONS[name] || Cog;
  const isActive = step.status === "active";
  const isDone = step.status === "done";
  const isError = step.status === "error";
  const isVoiceDiag = name.startsWith("voice_");
  const isWorkingCompression =
    name === "working_context_compression" || step.type === "compacting";
  const label =
    isWorkingCompression && layer === 2
      ? "Context Compressed"
      : meta?.label || name;
  const showSystemDetail =
    !!step.systemStepDetail && (!isWorkingCompression || layer >= 3);
  const duration = getStepDuration(step);
  const unattributed = getStepUnattributedTime(step, children);
  const isParallel =
    step.childMode === "parallel" ||
    (step.childMode == null && hasOverlappingChildren(children));
  const displayedUnattributed =
    unattributed != null && unattributed >= 10
      ? Math.min(unattributed, duration ?? unattributed)
      : undefined;
  const milestoneOffset =
    step.timingKind === "milestone" &&
    step.occurredAt != null &&
    parentStartedAt != null
      ? Math.max(0, step.occurredAt - parentStartedAt)
      : undefined;

  const bgColor = isError
    ? "bg-error/10"
    : isWorkingCompression
      ? "bg-warning/15"
      : isVoiceDiag
        ? isDone
          ? "bg-info/10"
          : "bg-info/15"
        : isDone
          ? "bg-success/10"
          : "bg-primary/15";

  const iconColor = isError
    ? "text-error"
    : isWorkingCompression
      ? "text-warning"
      : isVoiceDiag
        ? "text-info"
        : isDone
          ? "text-success"
          : "text-primary";

  return (
    <div
      className="animate-in fade-in slide-in-from-bottom-1 duration-200 flex items-center gap-2 py-1"
      style={{ paddingLeft: `${6 + depth * 20}px` }}
      data-testid={`system-step-${name}`}
    >
      <div
        className={`relative flex h-5 w-5 items-center justify-center rounded-full shrink-0 ${bgColor}`}
      >
        {isActive ? (
          <>
            <Icon className={`h-3 w-3 ${iconColor}`} />
            <span
              className={cn(
                "absolute inset-0 rounded-full animate-ping",
                isWorkingCompression ? "bg-warning/25" : "bg-info/20",
              )}
            />
          </>
        ) : isError ? (
          <AlertCircle className="h-3 w-3 text-error" />
        ) : isWorkingCompression ? (
          <AlertTriangle className={`h-3 w-3 ${iconColor}`} />
        ) : isDone && !isVoiceDiag ? (
          <CheckCircle2 className="h-3 w-3 text-success" />
        ) : (
          <Icon className={`h-3 w-3 ${iconColor}`} />
        )}
      </div>
      <span
        className={`text-xs flex-1 ${
          isWorkingCompression
            ? "text-warning"
            : isActive
              ? "text-foreground"
              : isDone
                ? isVoiceDiag
                  ? "text-info/70"
                  : "text-muted-foreground"
                : isError
                  ? "text-destructive"
                  : "text-muted-foreground/60"
        }`}
      >
        {label}
      </span>
      {showSystemDetail && (
        <span
          className={cn(
            "text-xs font-mono",
            isWorkingCompression
              ? "text-warning/80"
              : "text-muted-foreground/50",
          )}
        >
          {step.systemStepDetail}
        </span>
      )}
      {isActive && <SystemStepTimer startTime={step.timestamp} />}
      {(isDone || isError) && !isWorkingCompression && (
        <span
          className="text-xs tabular-nums font-mono text-muted-foreground/50 whitespace-nowrap"
          data-testid={`text-step-time-${name}`}
        >
          {step.timingKind === "milestone"
            ? `at +${formatStepElapsed(milestoneOffset ?? 0)}`
            : duration != null
              ? `${formatStepElapsed(duration)}${children.length > 0 ? " wall" : ""}${isParallel ? " · parallel" : ""}${displayedUnattributed != null ? ` · ${formatStepElapsed(displayedUnattributed)} unattributed` : ""}`
              : ""}
        </span>
      )}
    </div>
  );
}

/** Compact horizontal icon strip for tool calls in "Words Only" mode (layer 1). */
function ToolIconStrip({
  steps,
  iconOverrides,
  showThinking = false,
}: {
  steps: ExecutionStep[];
  iconOverrides?: Record<string, string>;
  showThinking?: boolean;
}) {
  const toolSteps = steps.filter((s) => s.type === "tool_call");
  const thinkingStartTime =
    steps.find((s) => s.type === "thinking" && s.status === "active")
      ?.timestamp ?? Date.now();
  if (toolSteps.length === 0 && !showThinking) return null;

  return (
    <div
      className="flex items-center gap-1.5 px-1.5 py-1 flex-wrap"
      data-testid="tool-icon-strip"
    >
      {toolSteps.map((step) => {
        const ToolIcon = resolveToolIcon(step.toolName || "", iconOverrides);
        const isActive = step.status === "active";
        const isDone = step.status === "done";
        const isError = step.status === "error";
        const iconColor = isError
          ? "text-error"
          : isDone
            ? "text-success"
            : isActive
              ? "text-active"
              : "text-info";
        const bgColor = isError
          ? "bg-error/10"
          : isDone
            ? "bg-success/10"
            : isActive
              ? "bg-active/15"
              : "bg-info/15";
        const reasoning =
          typeof step.arguments?.reasoning === "string" &&
          step.arguments.reasoning.trim()
            ? step.arguments.reasoning
            : step.toolName || "tool call";

        return (
          <Tooltip key={step.id}>
            <TooltipTrigger asChild>
              <div
                className={`relative flex items-center justify-center h-5 w-5 rounded-full shrink-0 ${bgColor} animate-in fade-in duration-200`}
                data-testid={`tool-icon-${step.id}`}
              >
                <ToolIcon className={`h-3 w-3 ${iconColor}`} />
                {isActive && (
                  <span className="absolute inset-0 rounded-full animate-ping bg-active/20" />
                )}
              </div>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs max-w-xs">
              {reasoning}
            </TooltipContent>
          </Tooltip>
        );
      })}
      {showThinking && (
        <ActiveThinkingStatus
          startTime={thinkingStartTime}
          testId="tool-strip-thinking"
          showTimer={false}
        />
      )}
    </div>
  );
}

function DiagnosticStepTree({
  step,
  allSteps,
  visibleSteps,
  layer,
  iconOverrides,
  summaryOnly,
  depth = 0,
}: {
  step: ExecutionStep;
  allSteps: ExecutionStep[];
  visibleSteps: ExecutionStep[];
  layer: 1 | 2 | 3 | 4;
  iconOverrides?: Record<string, string>;
  summaryOnly?: boolean;
  depth?: number;
}) {
  const children = getChildren(step, allSteps);
  const visibleChildren = getChildren(step, visibleSteps);
  return (
    <>
      {step.type === "system" ? (
        <SystemStepRow
          step={step}
          layer={layer}
          children={children}
          parentStartedAt={
            allSteps.find((candidate) => candidate.id === step.parentId)
              ?.startedAt
          }
          depth={depth}
        />
      ) : step.type === "tool_call" ? (
        <ToolStepRow
          step={step}
          iconOverrides={iconOverrides}
          summaryOnly={summaryOnly}
          layer={layer}
          children={children}
          depth={depth}
        />
      ) : null}
      {visibleChildren.map((child) => (
        <DiagnosticStepTree
          key={child.id}
          step={child}
          allSteps={allSteps}
          visibleSteps={visibleSteps}
          layer={layer}
          iconOverrides={iconOverrides}
          summaryOnly={summaryOnly}
          depth={depth + 1}
        />
      ))}
    </>
  );
}

export function ExecutionTimeline({
  steps,
  isStreaming,
  layer = 4,
}: {
  steps: ExecutionStep[];
  isStreaming: boolean;
  autoCollapse?: boolean;
  model?: string | null;
  layer?: 1 | 2 | 3 | 4;
}) {
  const { data: iconOverrides } = useQuery<Record<string, string>>({
    queryKey: ["/api/tool-icons"],
    staleTime: 60_000,
  });

  const layerSteps = filterStepsByLayer(steps, layer, isStreaming);
  const filteredSteps = layerSteps.filter(
    (step) =>
      step.diagnosticVisibility !== "hidden" &&
      step.diagnosticVisibility !== "raw",
  );

  log.verbose(
    () =>
      `RENDER:TIMELINE steps=${steps.length} filtered=${filteredSteps.length} streaming=${isStreaming} layer=${layer}`,
  );

  if (filteredSteps.length === 0) return null;

  const summaryOnly = layer === 2;
  const statusOnly = layer <= 1;

  // Layer 1 ("Words Only"): render tool calls as a compact icon strip,
  // with the active thinking indicator appended to the same row.
  if (statusOnly) {
    const hasThinking = filteredSteps.some((s) => s.type === "thinking");
    const hasToolCalls = filteredSteps.some((s) => s.type === "tool_call");
    const hasOther = filteredSteps.some(
      (s) => s.type !== "thinking" && s.type !== "tool_call",
    );
    const showThinking = filteredSteps.some(
      (s) => s.type === "thinking" && s.status === "active",
    );
    if (!hasThinking && !hasToolCalls && !hasOther) return null;

    return (
      <div className="mb-3 space-y-0.5" data-testid="execution-timeline">
        {filteredSteps.some((s) => s.type === "system") &&
          filteredSteps
            .filter((s) => s.type === "system")
            .map((s) => <SystemStepRow key={s.id} step={s} layer={layer} />)}
        {filteredSteps.some((s) => s.type === "compacting") &&
          filteredSteps
            .filter((s) => s.type === "compacting")
            .map((s) => <CompactingStep key={s.id} step={s} />)}
        <ToolIconStrip
          steps={filteredSteps}
          iconOverrides={iconOverrides}
          showThinking={showThinking}
        />
      </div>
    );
  }

  return (
    <div className="mb-3 space-y-0.5" data-testid="execution-timeline">
      {filteredSteps.map((step) => {
        if (
          step.parentId &&
          filteredSteps.some((candidate) => candidate.id === step.parentId)
        )
          return null;
        if (step.type === "system")
          return (
            <DiagnosticStepTree
              key={step.id}
              step={step}
              allSteps={steps}
              visibleSteps={filteredSteps}
              layer={layer}
              iconOverrides={iconOverrides}
              summaryOnly={summaryOnly}
            />
          );
        if (step.type === "thinking") {
          return (
            <ThinkingBubble key={step.id} step={step} showTimer={layer >= 3} />
          );
        }
        if (step.type === "compacting") {
          return <CompactingStep key={step.id} step={step} />;
        }
        if (
          step.type === "tool_call" &&
          (step.toolName === "think" || step.toolName === "observe")
        ) {
          return <ThoughtBubble key={step.id} step={step} />;
        }
        if (step.type === "tool_call")
          return (
            <DiagnosticStepTree
              key={step.id}
              step={step}
              allSteps={steps}
              visibleSteps={filteredSteps}
              layer={layer}
              iconOverrides={iconOverrides}
              summaryOnly={summaryOnly}
            />
          );
        return null;
      })}
    </div>
  );
}

// task-923 step 6: voice "setup" phase chips (engine_setup, signed_url)
// are ephemeral connection-handshake diagnostics. They show up live during
// the streaming greeting bubble for "I'm doing things" feedback. Once the
// greeting message persists, these chips have no narrative value and were
// collapsing visually onto the greeting bubble (looking like the greeting
// itself was a row of pills). Suppress from saved-message timelines while
// keeping them in storage so /api/voice/diagnostic logs and bug reports
// retain the data. Reconnect/disconnect/turn_boundary chips still render
// because those carry lasting context for the conversation.
const SUPPRESSED_TIMELINE_STEPS = new Set([
  "tool_use",
  "thinking",
  "engine_setup",
  "signed_url",
]);

export function stepsFromSavedMessage(message: ChatMessage): ExecutionStep[] {
  const steps: ExecutionStep[] = [];
  if (message.systemSteps && Array.isArray(message.systemSteps)) {
    message.systemSteps.forEach((step: SystemStepRecord, i: number) => {
      steps.push({
        id: step.id || `system-${step.name}-${message.id}-${i}`,
        type: "system",
        timestamp: Date.now(),
        systemStepName: step.name,
        systemStepDetail: step.detail,
        systemStepMetadata: step.metadata,
        elapsedMs: step.elapsedMs,
        parentId:
          step.parentId || (step.metadata?.parentId as string | undefined),
        selfTimeMs:
          step.selfTimeMs ||
          (typeof step.metadata?.selfTimeMs === "number"
            ? step.metadata.selfTimeMs
            : undefined),
        startedAt: step.startedAt,
        endedAt: step.endedAt,
        timingKind: step.timingKind,
        diagnosticVisibility:
          step.diagnosticVisibility ??
          (SUPPRESSED_TIMELINE_STEPS.has(step.name) ? "hidden" : undefined),
        childMode: step.childMode,
        occurredAt: step.occurredAt,
        status: step.status === "error" ? "error" : "done",
      });
    });
  }

  if (message.thinking) {
    steps.push({
      id: `thinking-${message.id}`,
      type: "thinking",
      timestamp: Date.now(),
      thinking: message.thinking,
      status: "done",
    });
  }

  if (message.toolCalls && Array.isArray(message.toolCalls)) {
    message.toolCalls.forEach((tool: ToolCallInfo, i: number) => {
      const isError = !!tool.error || tool.status === "error";
      const errorStr = getToolErrorText(tool);
      steps.push({
        id: tool.toolCallId
          ? `tool-${tool.toolCallId}`
          : `tool-${message.id}-${i}`,
        type: "tool_call",
        timestamp: Date.now(),
        toolName: tool.toolName,
        toolCallId: tool.toolCallId,
        arguments: tool.arguments,
        result: tool.result,
        error: errorStr,
        status: isError ? "error" : "done",
      });
    });
  }

  return steps;
}

/**
 * Extracts email draft reference IDs from message segments — both from assistant
 * prose content and from persisted gmail draft/update_draft tool results.
 * Shared by ChatTurn (rendering) and the message list (cross-message dedup).
 */
export function emailDraftIdsFromSegments(segments: MessageSegment[]): {
  fromContent: string[];
  fromToolResults: string[];
} {
  const fromContent = segments.flatMap((segment) =>
    segment.type === "content"
      ? parseReferenceText(segment.content)
          .filter(
            (part) =>
              part.kind === "reference" && part.ref.type === "email_draft",
          )
          .map((part) => part.ref.id)
      : [],
  );
  const fromToolResults = [
    ...new Set(
      segments.flatMap((segment) => {
        if (segment.type !== "timeline") return [];
        return segment.steps.flatMap((tool) => {
          const action =
            typeof tool.arguments?.action === "string"
              ? tool.arguments.action
              : null;
          if (
            tool.type !== "tool_call" ||
            tool.toolName !== "gmail" ||
            (action !== "draft" && action !== "update_draft")
          )
            return [];
          if (typeof tool.result !== "string") return [];
          return parseReferenceText(tool.result)
            .filter(
              (part) =>
                part.kind === "reference" && part.ref.type === "email_draft",
            )
            .map((part) => part.ref.id);
        });
      }),
    ),
  ];
  return { fromContent, fromToolResults };
}

/**
 * Draft IDs whose inline widgets are superseded by a later occurrence in the
 * same chat. Latest occurrence wins; earlier inline widgets are hidden.
 */
export const SuppressedEmailDraftsContext = createContext<ReadonlySet<string>>(
  new Set(),
);

export function segmentsFromSavedMessage(
  message: ChatMessage,
): MessageSegment[] {
  if (message.segmentChronology && message.segmentChronology.length > 0) {
    return segmentsFromChronology(message);
  }
  const steps = stepsFromSavedMessage(message);
  const segments: MessageSegment[] = [];
  if (steps.length > 0) {
    segments.push({ type: "timeline", steps });
  }
  if (message.content) {
    segments.push({ type: "content", content: message.content });
  }
  return segments;
}

function segmentsFromChronology(message: ChatMessage): MessageSegment[] {
  const chronology = message.segmentChronology!;
  const segments: MessageSegment[] = [];
  let currentTimelineSteps: ExecutionStep[] = [];

  const flushTimeline = () => {
    if (currentTimelineSteps.length > 0) {
      segments.push({ type: "timeline", steps: currentTimelineSteps });
      currentTimelineSteps = [];
    }
  };

  let chronologyContentLength = 0;
  for (const entry of chronology) {
    if (entry.s === "content" && entry.c) {
      chronologyContentLength += entry.c.length;
    }
  }

  let thinkingBlockIndex = 0;
  const contentEntries = chronology.filter((e) => e.s === "content") as Array<{
    s: "content";
    c: string;
  }>;
  const finalizedContent = contentEntries
    .map((entry) => entry.c || "")
    .join("");

  for (const entry of chronology) {
    switch (entry.s) {
      case "system": {
        const step = message.systemSteps?.[entry.i];
        if (step) {
          currentTimelineSteps.push({
            id: step.id || `system-${step.name}-${message.id}-${entry.i}`,
            type: "system",
            timestamp: step.startedAt || Date.now(),
            systemStepName: step.name,
            systemStepDetail: step.detail,
            systemStepMetadata: step.metadata,
            elapsedMs: step.elapsedMs,
            parentId:
              step.parentId || (step.metadata?.parentId as string | undefined),
            selfTimeMs:
              step.selfTimeMs ||
              (typeof step.metadata?.selfTimeMs === "number"
                ? step.metadata.selfTimeMs
                : undefined),
            startedAt: step.startedAt,
            endedAt: step.endedAt,
            timingKind: step.timingKind,
            diagnosticVisibility:
              step.diagnosticVisibility ??
              (SUPPRESSED_TIMELINE_STEPS.has(step.name) ? "hidden" : undefined),
            childMode: step.childMode,
            occurredAt: step.occurredAt,
            status: step.status === "error" ? "error" : "done",
          });
        }
        break;
      }
      case "thinking": {
        const thinkingText = entry.c || message.thinking;
        if (thinkingText) {
          currentTimelineSteps.push({
            id: `thinking-${message.id}-${thinkingBlockIndex}`,
            type: "thinking",
            timestamp: Date.now(),
            thinking: thinkingText,
            status: "done",
          });
          thinkingBlockIndex++;
        }
        break;
      }
      case "tool": {
        const tool = message.toolCalls?.[entry.i];
        if (tool) {
          const isError = !!tool.error || tool.status === "error";
          const errorStr = getToolErrorText(tool);
          currentTimelineSteps.push({
            id: tool.toolCallId
              ? `tool-${tool.toolCallId}`
              : `tool-${message.id}-${entry.i}`,
            type: "tool_call",
            timestamp: Date.now(),
            toolName: tool.toolName,
            toolCallId: tool.toolCallId,
            arguments: tool.arguments,
            result: tool.result,
            error: errorStr,
            status: isError ? "error" : "done",
            parentId: tool.parentId,
          });
        }
        break;
      }
      case "content": {
        // Keep the finalized Diagnostic trace in one timeline. Splitting at content
        // boundaries strands response parents and children in different arrays.
        break;
      }
    }
  }

  flushTimeline();

  let content = finalizedContent;
  if (message.content && message.content.length > chronologyContentLength) {
    content += message.content.slice(chronologyContentLength);
  }
  if (!content) content = message.content || "";
  if (content) segments.push({ type: "content", content });

  return segments;
}

const IMAGE_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".bmp",
]);
const ATTACHED_FILE_REGEX =
  /\n*\[Attached file: (.+?) \(workspace: (.+?)(?:,\s*[\d.]+KB)?\)\]/g;

function parseAttachments(content: string) {
  const images: { name: string; path: string }[] = [];
  const nonImageFiles: { name: string; path: string }[] = [];
  let match;
  const regex = new RegExp(ATTACHED_FILE_REGEX.source, "g");
  while ((match = regex.exec(content)) !== null) {
    const name = match[1];
    const wsPath = match[2];
    const ext = name.toLowerCase().slice(name.lastIndexOf("."));
    if (IMAGE_EXTS.has(ext)) {
      images.push({ name, path: wsPath });
    } else {
      nonImageFiles.push({ name, path: wsPath });
    }
  }
  const cleanedContent = content
    .replace(new RegExp(ATTACHED_FILE_REGEX.source, "g"), "")
    .trim();
  return { images, nonImageFiles, cleanedContent };
}

const markdownComponents = {
  a: ({ href, children, ...props }: any) => {
    if (href && href.startsWith("/objects/")) {
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-cta transition-colors hover:text-active hover:underline"
          data-testid="link-download-file"
          {...props}
        >
          <Download className="h-3 w-3 shrink-0" />
          {children}
        </a>
      );
    }
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
        {children}
      </a>
    );
  },
  img: ({ src, alt, ...props }: any) => {
    if (src && src.startsWith("/objects/")) {
      return (
        <a
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          className="block my-2"
        >
          <img
            src={src}
            alt={alt || "Generated image"}
            className="max-w-full max-h-[400px] rounded-md border border-border object-contain"
            loading="lazy"
            {...props}
          />
        </a>
      );
    }
    return (
      <img
        src={src}
        alt={alt}
        className="max-w-full rounded-md"
        loading="lazy"
        {...props}
      />
    );
  },
};

export function MarkdownContent({
  content,
  stripTags = false,
  compact = false,
  referenceSurface = "chat-inline",
}: {
  content: string;
  stripTags?: boolean;
  compact?: boolean;
  referenceSurface?: ReferenceSurface;
}) {
  const timestampStripped = stripMessageTimestamp(content);
  const strippedContent = stripTags
    ? stripExpressionTags(timestampStripped)
    : timestampStripped;
  const { tags, remaining } = stripTags
    ? { tags: [], remaining: strippedContent }
    : parseLeadingExpressionTags(strippedContent);

  // Extract references that promote into block-level widgets.
  const suppressedDrafts = useContext(SuppressedEmailDraftsContext);
  const parts = parseReferenceText(remaining);
  const draftIds: string[] = [];
  const planIds: string[] = [];
  const textWithoutWidgets = parts
    .map((part) => {
      if (part.kind === "reference" && part.ref.type === "email_draft") {
        draftIds.push(part.ref.id);
        return ""; // Strip from inline text — rendered as block widget below.
      }
      if (part.kind === "reference" && part.ref.type === "plan") {
        planIds.push(part.ref.id);
        return ""; // Strip from inline text — rendered as block widget below.
      }
      return part.kind === "text"
        ? part.text
        : `@${part.ref.type}:${part.ref.id}`;
    })
    .join("")
    .trim();

  return (
    <>
      {textWithoutWidgets && (
        <div
          className={cn(
            "prose prose-sm dark:prose-invert max-w-none break-words overflow-hidden [&_pre]:bg-card/70 [&_pre]:rounded-md [&_pre]:border [&_pre]:border-primary/20 [&_pre]:p-3 [&_pre]:overflow-x-auto [&_pre]:text-xs [&_code]:text-xs [&_code]:font-mono [&_code]:break-all [&_h1]:text-lg [&_h2]:text-base [&_h3]:text-sm [&_blockquote]:bg-card/70 [&_blockquote]:rounded-md [&_blockquote]:border-l-primary/20 [&_blockquote]:px-3 [&_blockquote]:py-2 [&_a]:text-cta [&_a]:break-all [&_a]:transition-colors [&_a:hover]:text-active",
            compact
              ? "[&_p]:my-2 [&_ul]:my-0 [&_ol]:my-0 [&_li]:my-0 [&>:first-child]:mt-0 [&>:last-child]:mb-0"
              : "[&_p]:my-2 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0",
            tags.length > 0 &&
              "[&>p:first-of-type]:inline [&>p:first-of-type]:my-0",
          )}
        >
          {tags.length > 0 && (
            <span className="not-prose mr-1.5 inline-flex flex-wrap items-baseline gap-1 align-baseline text-muted-foreground/80">
              {tags.map((tag, index) => (
                <span
                  key={`${tag}-${index}`}
                  className="inline-flex whitespace-nowrap italic"
                >
                  [{tag}]
                </span>
              ))}
            </span>
          )}
          <ReferenceText
            content={textWithoutWidgets}
            markdownComponents={markdownComponents}
            referenceSurface={referenceSurface}
          />
        </div>
      )}
      {draftIds
        .filter((id) => !suppressedDrafts.has(id))
        .map((id) => (
          <EmailDraftWidget key={id} draftId={id} />
        ))}
      {[...new Set(planIds)].map((id) => (
        <InlinePlanWidget key={id} planId={id} />
      ))}
    </>
  );
}

function InlinePlanWidget({ planId }: { planId: string }) {
  const {
    data: plan,
    isLoading,
    error,
  } = useQuery<PlanData>({
    queryKey: ["/api/plans", planId],
    queryFn: async () => {
      const res = await apiRequest(
        "GET",
        `/api/plans/${encodeURIComponent(planId)}`,
      );
      if (!res.ok) throw new Error("Plan not found");
      return res.json();
    },
    staleTime: 10_000,
  });

  if (isLoading) {
    return (
      <div className="my-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        Loading plan…
      </div>
    );
  }

  if (error || !plan) {
    return (
      <div className="my-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        @plan:{planId}
      </div>
    );
  }

  return <PlanWidget plan={plan} variant="card" className="my-2" />;
}

function formatLocalTime(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function StreamingTierBadge({
  model,
  autoTier,
}: {
  model?: string | null;
  autoTier?: string | null;
}) {
  const resolveModelToTier = useModelToTier();
  if (!model) return null;

  const tierId = resolveModelToTier(model);
  if (!tierId) return null;

  const Icon = TIER_ICON_MAP[tierId];
  const label = TIER_LABEL_MAP[tierId];
  if (!Icon || !label) return null;

  const shortModel = model.includes("/")
    ? model.split("/").slice(1).join("/")
    : model;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex items-center gap-1"
          data-testid={`badge-streaming-tier-${tierId}`}
        >
          <span className="relative flex items-center justify-center h-5 w-5 rounded-full shrink-0 bg-muted-foreground/10">
            <Icon className="h-3 w-3 text-muted-foreground/70" />
          </span>
          {autoTier && (
            <span className="text-xs text-muted-foreground/50 font-medium uppercase tracking-wider">
              Auto
            </span>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {autoTier && (
          <span className="text-muted-foreground mr-1">Auto &rarr;</span>
        )}
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground ml-1.5">{shortModel}</span>
      </TooltipContent>
    </Tooltip>
  );
}

export function findThinkingStartTime(segments: MessageSegment[]): number {
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (seg.type !== "timeline") continue;
    for (let j = seg.steps.length - 1; j >= 0; j--) {
      const step = seg.steps[j];
      if (step.type === "thinking" && step.status === "active")
        return step.timestamp;
    }
  }
  return Date.now();
}

export function ThinkingTimer({ startTime }: { startTime: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(interval);
  }, []);
  const seconds = Math.max(0, (now - startTime) / 1000).toFixed(1);
  return (
    <span
      className="text-xs tabular-nums font-mono text-muted-foreground/30"
      data-testid="text-thinking-timer"
    >
      {seconds}s
    </span>
  );
}

function cleanCompactionSummary(content: string): string {
  return content
    .replace(/^\[Session Compaction\]\s*/i, "")
    .replace(/Summary of \d+ earlier messages:\s*/i, "")
    .replace(/\n\n\[Full original messages archived[\s\S]*?\]\s*$/i, "")
    .trim();
}

function CompactionBoundary({
  message,
  stripTags,
}: {
  message: ChatMessage;
  stripTags: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const meta = message.compaction;
  const replaced = meta?.replacedMessageCount;
  const kept = meta?.keptMessageCount;
  const summary = meta?.summary || cleanCompactionSummary(message.content);
  const tokensSaved = meta?.tokensSaved;

  return (
    <div
      className="flex justify-center"
      data-testid={`message-compaction-marker-${message.id}`}
    >
      <div className="w-full max-w-3xl rounded-xl border border-border/70 bg-muted/30 px-4 py-3 text-sm shadow-sm">
        <button
          type="button"
          className="flex w-full items-center gap-2 text-left"
          onClick={() => setExpanded(!expanded)}
          data-testid={`button-toggle-compaction-${message.id}`}
        >
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10">
            <Database className="h-3.5 w-3.5 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-medium text-foreground">
              Earlier conversation compacted
            </div>
            <div className="text-xs text-muted-foreground">
              {typeof replaced === "number"
                ? `${replaced} messages summarized`
                : "Earlier turns summarized"}
              {typeof kept === "number"
                ? ` · ${kept} recent messages kept live`
                : ""}
              {typeof tokensSaved === "number" && tokensSaved > 0
                ? ` · ~${tokensSaved.toLocaleString()} tokens saved`
                : ""}
              {meta?.archiveRefId ? " · original archived" : ""}
            </div>
          </div>
          <ChevronRight
            className={cn(
              "h-4 w-4 text-muted-foreground transition-transform",
              expanded && "rotate-90",
            )}
          />
        </button>
        {expanded && (
          <div className="mt-3 border-t border-border/60 pt-3">
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Compaction summary
            </div>
            <div className="prose prose-sm dark:prose-invert max-w-none text-sm">
              <MarkdownContent content={summary} stripTags={stripTags} />
            </div>
            {meta?.archiveRefId && (
              <div className="mt-2 text-xs text-muted-foreground/70 font-mono">
                archive ref: {meta.archiveRefId}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export const ChatTurn = memo(function ChatTurn({
  message,
  isLast,
  streaming,
  sessionKey,
  compactReferences = false,
  suppressedEmailDraftIds,
}: {
  message: ChatMessage;
  isLast: boolean;
  streaming?: StreamingContent;
  sessionKey?: string | null;
  compactReferences?: boolean;
  suppressedEmailDraftIds?: string;
}) {
  const isUser = message.role === "user";
  const isSystemPrompt = message.role === "system_prompt";
  const isVoiceMessage = message.voice?.source === "elevenlabs-voice";
  const effectiveApiCallCount =
    message.apiCallCount ?? streaming?.apiCallCount ?? null;
  const effectiveCost = message.cost ?? streaming?.cost ?? null;
  const effectiveInputTokens =
    message.inputTokens ?? streaming?.inputTokens ?? null;
  const effectiveOutputTokens =
    message.outputTokens ?? streaming?.outputTokens ?? null;
  const effectiveTotalTokens =
    message.totalTokens ??
    streaming?.totalTokens ??
    (effectiveInputTokens != null || effectiveOutputTokens != null
      ? (effectiveInputTokens ?? 0) + (effectiveOutputTokens ?? 0)
      : null);
  const effectiveTokenSummary =
    effectiveTotalTokens != null
      ? `${formatTokens(effectiveTotalTokens)} tokens total${effectiveInputTokens != null || effectiveOutputTokens != null ? ` · ${formatTokens(effectiveInputTokens ?? 0)} in / ${formatTokens(effectiveOutputTokens ?? 0)} out` : ""}`
      : null;
  const hasFinalizedUsage =
    effectiveApiCallCount != null && effectiveApiCallCount > 0;
  const isActiveStreaming = !!streaming?.source && !hasFinalizedUsage;
  // After completion the held segments must keep rendering until the refetched
  // persisted message replaces the draft placeholder. Without this, the bubble
  // briefly falls back to the empty draft and goes blank between `done` and
  // `saved`-poll completion.
  const messageHasNoVisibleContent =
    (!message.content || message.content.trim() === "") &&
    (!message.segmentChronology || message.segmentChronology.length === 0);
  const hasStreamingSegments =
    !isUser &&
    !isSystemPrompt &&
    !!streaming &&
    streaming.segments.length > 0 &&
    (streaming.source !== null || messageHasNoVisibleContent);
  const [copied, setCopied] = useState(false);
  const turnRootRef = useRef<HTMLDivElement>(null);
  const previousTurnTraceRef = useRef<{
    messageId: string;
    top: number;
    height: number;
    segmentCount: number;
    contentLen: number;
    hasStreamingSegments: boolean;
  } | null>(null);

  const { layer } = useVisibilityLayer();

  const { data: tagPref } = useQuery<{ showExpressionTags: boolean }>({
    queryKey: ["/api/elevenlabs/agent/show-expression-tags"],
    staleTime: 60_000,
  });
  const shouldStripTags =
    !isUser && !isSystemPrompt && (layer === 1 || !tagPref?.showExpressionTags);
  const segments: MessageSegment[] =
    hasStreamingSegments && streaming
      ? streaming.segments
      : segmentsFromSavedMessage(message);

  if (!isUser && !isSystemPrompt) {
    log.verbose(
      () =>
        `TURN:RENDER id=${message.id} segments=${segments.length} streaming=${isActiveStreaming} contentLen=${message.content?.length ?? 0}`,
    );
  }

  const hasContent = segments.some((s) => s.type === "content" && s.content);
  const {
    fromContent: draftIdsFromContent,
    fromToolResults: draftIdsFromToolResults,
  } = emailDraftIdsFromSegments(segments);
  const visibleEmailDraftIds = [
    ...new Set([...draftIdsFromContent, ...draftIdsFromToolResults]),
  ];
  const suppressedDraftIds = useMemo(
    () =>
      new Set<string>(
        suppressedEmailDraftIds ? suppressedEmailDraftIds.split("|") : [],
      ),
    [suppressedEmailDraftIds],
  );
  const unpromotedDraftIds = draftIdsFromToolResults.filter(
    (id) => !draftIdsFromContent.includes(id) && !suppressedDraftIds.has(id),
  );
  const hasUnpromotedDraftWidget = unpromotedDraftIds.length > 0;

  useEffect(() => {
    if (visibleEmailDraftIds.length === 0) return;
    log.debug("EMAIL_DRAFT_WIDGET:DERIVED", {
      messageId: message.id,
      draftIds: visibleEmailDraftIds,
      contentDraftCount: draftIdsFromContent.length,
      toolResultDraftCount: draftIdsFromToolResults.length,
      promotedFromToolResult: hasUnpromotedDraftWidget,
      suppressedDraftCount: suppressedDraftIds.size,
      isStreaming: isActiveStreaming,
    });
  }, [
    message.id,
    visibleEmailDraftIds.join("|"),
    draftIdsFromContent.length,
    draftIdsFromToolResults.length,
    hasUnpromotedDraftWidget,
    suppressedDraftIds.size,
    isActiveStreaming,
  ]);

  const handleCopy = useCallback(() => {
    const allContent = segments
      .filter(
        (s): s is MessageSegment & { type: "content" } => s.type === "content",
      )
      .map((s) => s.content)
      .join("\n\n");
    const rawText = allContent || message.content || "";
    const textToCopy = shouldStripTags ? stripExpressionTags(rawText) : rawText;
    navigator.clipboard.writeText(textToCopy).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [message.content, segments, shouldStripTags]);

  useLayoutEffect(() => {
    if (isUser || isSystemPrompt) return;
    const el = turnRootRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const prev =
      previousTurnTraceRef.current?.messageId === message.id
        ? previousTurnTraceRef.current
        : null;
    const heightChanged = prev ? Math.abs(prev.height - rect.height) > 1 : true;
    const topChanged = prev ? Math.abs(prev.top - rect.top) > 1 : true;
    const contentLen = message.content?.length ?? 0;
    const shouldLog =
      isActiveStreaming ||
      hasStreamingSegments ||
      heightChanged ||
      topChanged ||
      prev?.segmentCount !== segments.length ||
      prev?.contentLen !== contentLen ||
      prev?.hasStreamingSegments !== hasStreamingSegments;
    if (shouldLog) {
      log.verbose(
        () =>
          `TURN_LAYOUT id=${message.id} h=${Math.round(rect.height)} segments=${segments.length} streaming=${isActiveStreaming}`,
      );
    }
    previousTurnTraceRef.current = {
      messageId: message.id,
      top: rect.top,
      height: rect.height,
      segmentCount: segments.length,
      contentLen,
      hasStreamingSegments,
    };
  });

  if (message.model === "compaction-marker") {
    return <CompactionBoundary message={message} stripTags={shouldStripTags} />;
  }

  if (isSystemPrompt) {
    return (
      <div
        className="flex gap-3 items-start"
        data-testid={`message-system-prompt-${message.id}`}
      >
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-cat-system/15 mt-0.5">
          <ScrollText className="h-4 w-4 text-cat-system" />
        </div>
        <div className="min-w-0 flex-1 group">
          <div
            className="text-xs font-medium text-cat-system mb-1"
            data-testid="text-system-prompt-label"
          >
            Skill Instructions
          </div>
          <div className="rounded-lg border border-cat-system/20 bg-cat-system/5 px-4 py-3">
            <MarkdownContent
              content={message.content}
              stripTags={shouldStripTags}
            />
          </div>
          <div
            className="mt-1 text-xs text-muted-foreground/50"
            data-testid={`text-message-time-${message.id}`}
          >
            {formatLocalTime(message.updatedAt ?? message.createdAt)}
          </div>
        </div>
      </div>
    );
  }

  if (isUser) {
    const { cleanedContent, images } = parseAttachments(message.content);
    const displayUserContent = stripMessageTimestamp(cleanedContent);
    return (
      <div
        className="flex justify-end"
        data-testid={`message-user-${message.id}`}
      >
        <div className="max-w-[75%]">
          {message.speaker && (
            <div
              className="mb-0.5 text-xs font-medium text-muted-foreground text-right"
              data-testid={`text-speaker-${message.id}`}
            >
              {message.speaker.personId ? (
                <MarkdownContent
                  content={`@person:${message.speaker.personId}`}
                  stripTags
                  compact
                  referenceSurface="simple-chip"
                />
              ) : (
                message.speaker.label
              )}
            </div>
          )}
          <div className="bg-muted text-foreground rounded-2xl rounded-br-sm px-4 py-2.5">
            {displayUserContent && (
              <div className="text-sm" data-testid="text-user-message">
                <MarkdownContent
                  content={displayUserContent}
                  stripTags
                  compact
                  referenceSurface={
                    compactReferences ? "simple-chip" : "chat-inline"
                  }
                />
              </div>
            )}
            {images.length > 0 && (
              <div
                className={`flex flex-wrap gap-2 ${displayUserContent ? "mt-2" : ""}`}
              >
                {images.map((img, i) => {
                  const src = img.path.startsWith("/objects/")
                    ? img.path
                    : `/api/workspace/raw?path=${encodeURIComponent(img.path)}`;
                  return (
                    <a
                      key={i}
                      href={src}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block h-36 w-36 overflow-hidden rounded-md border border-border bg-card transition-colors hover:border-cta hover:ring-1 hover:ring-cta/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cta"
                      aria-label={`Open full-size attachment: ${img.name}`}
                      data-testid={`link-attached-image-${i}`}
                    >
                      <img
                        src={src}
                        alt={img.name}
                        className="h-full w-full object-cover"
                        loading="lazy"
                        data-testid={`img-attached-${i}`}
                      />
                    </a>
                  );
                })}
              </div>
            )}
          </div>
          <div
            className="mt-1 flex min-h-9 items-center justify-end gap-1 text-xs text-muted-foreground/50 text-right"
            data-testid={`text-message-time-${message.id}`}
          >
            {isVoiceMessage && (
              <>
                <Mic className="h-2.5 w-2.5" />
                <span>Voice</span>
                <span>·</span>
              </>
            )}
            {formatLocalTime(message.updatedAt ?? message.createdAt)}
            {layer > 1 && message.pageContext?.route && (
              <span
                className="flex items-center gap-0.5"
                title={`Sent from: ${message.pageContext.pageTitle || message.pageContext.route}${message.pageContext.tab ? ` > ${message.pageContext.tab}` : ""}`}
                data-testid={`badge-msg-context-${message.id}`}
              >
                <MapPin className="h-2.5 w-2.5" />
                <span className="truncate max-w-[80px]">
                  {message.pageContext.pageTitle || message.pageContext.route}
                </span>
              </span>
            )}
          </div>
        </div>
      </div>
    );
  }

  const isErrorMessage = !isUser && !isSystemPrompt && !!message.isError;
  const PersonaIcon = resolvePersonaIcon(message.persona?.icon);
  const personaLabel = message.persona?.name || "Legacy persona unknown";

  return (
    <div
      ref={turnRootRef}
      className="flex gap-3 items-start"
      data-testid={`message-assistant-${message.id}`}
    >
      {isErrorMessage ? (
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-destructive/15">
          <AlertCircle className="h-4 w-4 text-destructive" />
        </div>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10"
              aria-label={`Persona: ${personaLabel}`}
              data-testid={`icon-agent-persona-${message.id}`}
            >
              <PersonaIcon className="h-4 w-4 text-primary" />
            </div>
          </TooltipTrigger>
          <TooltipContent side="right" className="text-xs">
            {personaLabel}
          </TooltipContent>
        </Tooltip>
      )}
      <div className="min-w-0 flex-1 group">
        {isErrorMessage && (
          <div className="flex items-center gap-1.5 text-destructive text-xs font-medium mb-1">
            <span>Error</span>
          </div>
        )}
        <div className="space-y-2">
          <SuppressedEmailDraftsContext.Provider value={suppressedDraftIds}>
            {segments.length > 0 || isActiveStreaming ? (
              <SegmentStream
                segments={segments}
                isStreaming={isActiveStreaming}
                layer={layer}
                stripTags={shouldStripTags}
                contentCompact
              />
            ) : (
              message.content && (
                <div
                  className={cn(
                    isErrorMessage &&
                      "rounded-2xl rounded-bl-sm border border-destructive/30 bg-destructive/5 px-4 py-2.5",
                  )}
                >
                  <MarkdownContent
                    content={message.content}
                    stripTags={shouldStripTags}
                    compact
                  />
                </div>
              )
            )}
            {unpromotedDraftIds.map((id) => (
              <EmailDraftWidget key={`tool-draft-${id}`} draftId={id} />
            ))}
          </SuppressedEmailDraftsContext.Provider>
        </div>
        <div
          className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground/50 text-left"
          data-testid={`text-message-time-${message.id}`}
        >
          {layer >= 3 &&
            (isActiveStreaming ? (
              <StreamingTierBadge
                model={streaming?.model}
                autoTier={streaming?.autoTier}
              />
            ) : (
              message.model && <ModelTierBadge model={message.model} />
            ))}
          {layer >= 3 && !isErrorMessage && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className="inline-flex items-center"
                  data-testid={`badge-agent-persona-${message.id}`}
                >
                  <PersonaIcon className="h-2.5 w-2.5" />
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">
                {personaLabel}
              </TooltipContent>
            </Tooltip>
          )}
          {formatLocalTime(message.updatedAt ?? message.createdAt)}
          {layer >= 3 &&
            !isActiveStreaming &&
            effectiveApiCallCount != null &&
            effectiveApiCallCount > 0 &&
            sessionKey && (
              <Link
                href={`/system?tab=inference&session=${encodeURIComponent(sessionKey)}`}
                className="text-cta underline transition-colors hover:text-active"
                data-testid={`link-api-calls-${message.id}`}
              >
                {effectiveApiCallCount}{" "}
                {effectiveApiCallCount === 1 ? "call" : "calls"}
                {effectiveTokenSummary != null
                  ? ` · ${effectiveTokenSummary}`
                  : ""}
                {effectiveCost != null ? ` · ${formatCost(effectiveCost)}` : ""}
              </Link>
            )}
          {layer >= 3 &&
            !isActiveStreaming &&
            effectiveApiCallCount != null &&
            effectiveApiCallCount > 0 &&
            !sessionKey && (
              <span data-testid={`text-api-calls-${message.id}`}>
                {effectiveApiCallCount}{" "}
                {effectiveApiCallCount === 1 ? "call" : "calls"}
                {effectiveTokenSummary != null
                  ? ` · ${effectiveTokenSummary}`
                  : ""}
                {effectiveCost != null ? ` · ${formatCost(effectiveCost)}` : ""}
              </span>
            )}
          {layer >= 3 &&
            !isActiveStreaming &&
            (effectiveApiCallCount == null || effectiveApiCallCount === 0) &&
            effectiveCost != null &&
            effectiveCost > 0 && (
              <span data-testid={`text-message-cost-${message.id}`}>
                {effectiveTokenSummary != null
                  ? `${effectiveTokenSummary} · `
                  : ""}
                {formatCost(effectiveCost)}
              </span>
            )}
          {!isActiveStreaming && (hasContent || message.content) && (
            <Button
              className="invisible group-hover:visible"
              size="icon"
              variant="ghost"
              onClick={handleCopy}
              data-testid={`button-copy-message-${message.id}`}
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-success" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
});
