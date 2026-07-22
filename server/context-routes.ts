// Use createLogger for logging ONLY
import type { Express } from "express";
import { contextBuilder, estimateTokens, estimateTokensFromChars } from "./context-builder";
import { getSectionsForCallType, SPINE_SECTIONS, getAllSectionIds } from "./context-spine-config";
import { getToolSchemas, TOOL_ALIASES } from "./tool-registry";
import { getCurrentPrincipal } from "./principal-context";
import { getWireBoundaryCapture } from "./context-wire-capture";
import type {
  ContextCallType,
  LlmMode,
  ContextRequest,
  ContextWirePayload,
  WireToolSchemaEntry,
  WireBoundaryCaptureView,
} from "../shared/context-spine";
import { createLogger } from "./log";

const log = createLogger("ContextRoutes");

function parseCommaSeparated(value: unknown): string[] | undefined {
  if (!value || typeof value !== "string") return undefined;
  const items = value.split(",").map(s => s.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

const VALID_CALL_TYPES: ContextCallType[] = ["full", "world", "internal", "none"];
const VALID_LLM_MODES: LlmMode[] = ["text", "voice"];

/**
 * Compose the truthful wire-payload breakdown: the rendered spine plus the tool
 * schema block (reusing the exact `getToolSchemas` the chat path sends) plus the
 * latest real model-boundary capture for the requesting user. The SDK harness and
 * system-reminder envelopes are SDK-injected, so their cost surfaces as the gap
 * between provider-measured input tokens and Mantra's attributable estimate.
 */
function buildWirePayload(spineTokens: number, renderedChars: number): ContextWirePayload {
  const schemas = getToolSchemas();
  const aliasNames = new Set(Object.keys(TOOL_ALIASES));
  const fullJson = JSON.stringify(schemas);

  const tools: WireToolSchemaEntry[] = schemas
    .map(schema => {
      const json = JSON.stringify(schema);
      return {
        name: schema.name,
        category: schema.category,
        chars: json.length,
        tokens: estimateTokens(json),
        isAlias: aliasNames.has(schema.name),
      };
    })
    .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));

  const toolTotalTokens = estimateTokens(fullJson);
  const aliasCount = tools.reduce((n, t) => (t.isAlias ? n + 1 : n), 0);

  const principal = getCurrentPrincipal();
  const raw = getWireBoundaryCapture(
    principal && principal.actorType === "user" ? principal.userId : null,
  );

  let capture: WireBoundaryCaptureView | null = null;
  if (raw) {
    const systemPromptTokens = estimateTokensFromChars(raw.systemPromptChars);
    const toolSchemaTokens = estimateTokensFromChars(raw.toolSchemaChars);
    const conversationTokens = estimateTokensFromChars(raw.conversationChars);
    const attributableTokens = systemPromptTokens + toolSchemaTokens + conversationTokens;
    const harnessAndRemindersTokens =
      raw.providerInputTokens != null
        ? Math.max(0, raw.providerInputTokens - attributableTokens)
        : null;
    capture = {
      capturedAt: raw.capturedAt,
      provider: raw.provider,
      model: raw.model,
      activity: raw.activity,
      systemPromptTokens,
      toolSchemaTokens,
      conversationTokens,
      attributableTokens,
      providerInputTokens: raw.providerInputTokens,
      providerCacheReadTokens: raw.providerCacheReadTokens,
      harnessAndRemindersTokens,
      providerTokensMayBeCumulative: raw.providerTokensMayBeCumulative,
      systemPromptExcerpt: raw.systemPromptExcerpt,
      systemPromptExcerptTruncated: raw.systemPromptExcerptTruncated,
    };
  }

  return {
    estimator: "chars/3.5",
    spine: { tokens: spineTokens, chars: renderedChars },
    toolSchemas: {
      count: schemas.length,
      aliasCount,
      totalTokens: toolTotalTokens,
      totalChars: fullJson.length,
      tools,
    },
    estimatedAttributableTokens: spineTokens + toolTotalTokens,
    capture,
    sdkInjectedNote:
      "System-reminder envelopes and the Claude Agent SDK harness are injected at the model boundary by the SDK, not authored in Mantra code. Their real cost appears in the captured call as the gap between provider-measured input tokens and Mantra's attributable estimate.",
  };
}

export function registerContextRoutes(app: Express) {
  app.get("/api/context/preview", async (req, res) => {
    try {
      const callType = (req.query.callType as ContextCallType) || "full";
      const llmMode = (req.query.llmMode as LlmMode) || "text";

      if (!VALID_CALL_TYPES.includes(callType)) {
        return res.status(400).json({ error: `Invalid callType. Must be one of: ${VALID_CALL_TYPES.join(", ")}` });
      }
      if (!VALID_LLM_MODES.includes(llmMode)) {
        return res.status(400).json({ error: `Invalid llmMode. Must be one of: ${VALID_LLM_MODES.join(", ")}` });
      }

      const includeSections = parseCommaSeparated(req.query.includeSections);
      const excludeSections = parseCommaSeparated(req.query.excludeSections);

      const memoryQuery = (req.query.memoryQuery as string) || null;
      if (memoryQuery) {
        log.log(`preview: memoryQuery="${memoryQuery.slice(0, 80)}" callType=${callType}`);
      }

      const request: ContextRequest = {
        callType,
        llmMode,
        sessionKey: (req.query.sessionKey as string) || null,
        activity: (req.query.activity as string) || null,
        memoryQuery,
        includeSections,
        excludeSections,
      };

      const spine = await contextBuilder.resolve(request);
      res.json(spine);
    } catch (err: any) {
      log.error("preview error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/context/preview/rendered", async (req, res) => {
    try {
      const callType = (req.query.callType as ContextCallType) || "full";
      const llmMode = (req.query.llmMode as LlmMode) || "text";

      if (!VALID_CALL_TYPES.includes(callType)) {
        return res.status(400).json({ error: `Invalid callType. Must be one of: ${VALID_CALL_TYPES.join(", ")}` });
      }
      if (!VALID_LLM_MODES.includes(llmMode)) {
        return res.status(400).json({ error: `Invalid llmMode. Must be one of: ${VALID_LLM_MODES.join(", ")}` });
      }

      const includeSections = parseCommaSeparated(req.query.includeSections);
      const excludeSections = parseCommaSeparated(req.query.excludeSections);

      const memoryQuery = (req.query.memoryQuery as string) || null;
      if (memoryQuery) {
        log.log(`rendered preview: memoryQuery="${memoryQuery.slice(0, 80)}" callType=${callType}`);
      }

      const request: ContextRequest = {
        callType,
        llmMode,
        sessionKey: (req.query.sessionKey as string) || null,
        activity: (req.query.activity as string) || null,
        memoryQuery,
        includeSections,
        excludeSections,
      };

      const spine = await contextBuilder.resolve(request);
      const rendered = contextBuilder.renderToPrompt(spine);
      const wirePayload = buildWirePayload(spine.metadata.totalTokens, rendered.length);

      res.json({
        rendered,
        metadata: spine.metadata,
        wirePayload,
      });
    } catch (err: any) {
      log.error("rendered preview error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/context/call-types", async (_req, res) => {
    try {
      const callTypes = VALID_CALL_TYPES.map(ct => ({
        id: ct,
        label: ct === "full" ? "Full" : ct === "world" ? "World" : ct === "internal" ? "Internal" : "None",
        description: ct === "full"
          ? "Complete context for primary interactions (chat, voice, background)"
          : ct === "world"
          ? "World model + memory — for operations reasoning about user's life"
          : ct === "internal"
          ? "Self identity only — for mechanical processing"
          : "No structured context — pure utility operations",
        sectionCount: getSectionsForCallType(ct).length,
        sections: getSectionsForCallType(ct).map(s => s.id),
      }));

      res.json({ callTypes, llmModes: VALID_LLM_MODES });
    } catch (err: any) {
      log.error("Call types error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/context/sections", async (_req, res) => {
    try {
      const topLevel = new Map<string, string[]>();
      for (const s of SPINE_SECTIONS) {
        const root = s.id.split(".")[0];
        if (!topLevel.has(root)) topLevel.set(root, []);
        topLevel.get(root)!.push(s.id);
      }

      const groups = Array.from(topLevel.entries()).map(([prefix, ids]) => ({
        prefix,
        sectionIds: ids,
        includedIn: [...new Set(SPINE_SECTIONS.filter(s => ids.includes(s.id)).flatMap(s => s.includedIn))],
      }));

      res.json({ groups, allSectionIds: getAllSectionIds() });
    } catch (err: any) {
      log.error("Sections error:", err);
      res.status(500).json({ error: err.message });
    }
  });

}
