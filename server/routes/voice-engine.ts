import type { Express } from "express";
import { z } from "zod";
import { createLogger } from "../log";
import {
  getVoiceWebhookBaseUrlOverrideSync,
  loadVoiceWebhookBaseUrlOverride,
  setVoiceWebhookBaseUrlOverride,
} from "../voice-webhook-base-url";
import { getPublicBaseUrl } from "../voice-llm";
import { getSecretSync } from "../secrets-store";

const log = createLogger("voice-engine-routes");

export function registerVoiceEngineRoutes(app: Express): void {
  // Webhook base URL override — lets the user pin the public URL used for
  // ElevenLabs custom-LLM callbacks so they can test voice in dev without
  // env var changes.
  void loadVoiceWebhookBaseUrlOverride();

  app.get("/api/voice/webhook-base-url", (_req, res) => {
    try {
      const override = getVoiceWebhookBaseUrlOverrideSync();
      const effective = getPublicBaseUrl();
      res.json({
        override,
        effective,
        usingOverride: override !== null && override === effective,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  const putBaseUrlSchema = z.object({
    url: z.string().nullable(),
  });

  app.put("/api/voice/webhook-base-url", async (req, res) => {
    const parsed = putBaseUrlSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "url is required (string or null to clear)" });
    }
    try {
      const value = await setVoiceWebhookBaseUrlOverride(parsed.data.url);
      log.log(`webhook base URL override set to ${value ?? "(cleared)"}`);

      // Re-apply agent config so the new URL takes effect immediately.
      const agentId = getSecretSync("ELEVENLABS_AGENT_ID");
      let reapplyError: string | null = null;
      if (agentId) {
        try {
          const { setupAgentCallbackUrl } = await import("../elevenlabs");
          await setupAgentCallbackUrl(agentId);
        } catch (err) {
          reapplyError = err instanceof Error ? err.message : String(err);
          log.warn(`re-apply agent config after URL change failed: ${reapplyError}`);
        }
      }

      res.json({
        override: value,
        effective: getPublicBaseUrl(),
        reapplied: agentId ? "v2" : "skipped",
        reapplyError,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`PUT /api/voice/webhook-base-url failed: ${msg}`);
      res.status(400).json({ error: msg });
    }
  });

  log.log("registered /api/voice/webhook-base-url routes");
}
