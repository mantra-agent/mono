// Use createLogger for logging ONLY
import type { Express } from "express";
import { contextBuilder } from "./context-builder";
import { getSectionsForCallType, SPINE_SECTIONS, getAllSectionIds } from "./context-spine-config";
import { getInferencePayloadCapture, INFERENCE_PAYLOAD_RETENTION_LIMIT, listInferencePayloadCaptures } from "./inference-payload-capture";
import type { ContextCallType, LlmMode, ContextRequest } from "../shared/context-spine";
import { createLogger } from "./log";

const log = createLogger("ContextRoutes");

function parseCommaSeparated(value: unknown): string[] | undefined {
  if (!value || typeof value !== "string") return undefined;
  const items = value.split(",").map(s => s.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

const VALID_CALL_TYPES: ContextCallType[] = ["full", "world", "internal", "none"];
const VALID_LLM_MODES: LlmMode[] = ["text", "voice"];

// Captured inference payload routes below read only concrete provider-bound calls.

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

      res.json({ rendered, metadata: spine.metadata });
    } catch (err: any) {
      log.error("rendered preview error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/context/inference-calls", async (req, res) => {
    try {
      const requested = Number.parseInt(String(req.query.limit ?? INFERENCE_PAYLOAD_RETENTION_LIMIT), 10);
      const captures = await listInferencePayloadCaptures(Number.isFinite(requested) ? requested : INFERENCE_PAYLOAD_RETENTION_LIMIT);
      res.json({ captures, retentionLimit: INFERENCE_PAYLOAD_RETENTION_LIMIT });
    } catch (err: any) {
      log.error("inference payload list error:", err);
      res.status(err?.status || 500).json({ error: err.message });
    }
  });

  app.get("/api/context/inference-calls/:id", async (req, res) => {
    try {
      const capture = await getInferencePayloadCapture(req.params.id);
      if (!capture) return res.status(404).json({ error: "Inference payload capture not found" });
      res.json(capture);
    } catch (err: any) {
      log.error("inference payload detail error:", err);
      res.status(err?.status || 500).json({ error: err.message });
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
