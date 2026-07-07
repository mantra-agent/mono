// Use createLogger for logging ONLY
import type { Express } from "express";

import multer from "multer";
import { eventBus } from "../event-bus";

import { createLogger } from "../log";
import { getSetting, setSetting } from "../system-settings";
import { requireAuth } from "../auth";
import { getSecretSync } from "../secrets-store";

const voiceLog = createLogger("VoiceConfig");
const IVC_LATEST_SETTING_KEY = "elevenlabs_ivc_latest";
const IVC_UPLOAD_MAX_FILES = 5;
const IVC_UPLOAD_MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024;
const ivcUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: IVC_UPLOAD_MAX_FILES,
    fileSize: IVC_UPLOAD_MAX_FILE_SIZE_BYTES,
  },
});


export interface AudioTag {
  tag: string;
  description?: string;
}

export interface TtsConfig {
  modelId: string;
  expressiveEnabled: boolean;
  suggestedAudioTags: AudioTag[];
  speed: number;
  stability: number;
  similarityBoost: number;
  style: number;
}

const DEFAULT_AUDIO_TAGS: AudioTag[] = [
  { tag: "excited", description: "Energetic and enthusiastic tone" },
  { tag: "calm", description: "Relaxed and soothing delivery" },
  { tag: "sighs", description: "Audible sigh expressing emotion" },
  { tag: "laughs", description: "Natural laughter" },
  { tag: "pause", description: "Brief dramatic pause" },
  { tag: "nervous", description: "Anxious or hesitant tone" },
  { tag: "cheerfully", description: "Upbeat and happy delivery" },
  { tag: "whispers", description: "Soft, hushed voice" },
];

const TTS_CONFIG_KEY = "voice_tts_config";
const MAX_AUDIO_TAGS = 20;

const SHOW_EXPRESSION_TAGS_KEY = "show_expression_tags";

function getDefaultTtsConfig(): TtsConfig {
  return {
    modelId: "eleven_flash_v2",
    expressiveEnabled: false,
    suggestedAudioTags: DEFAULT_AUDIO_TAGS,
    speed: 1.0,
    stability: 0.5,
    similarityBoost: 0.75,
    style: 0.0,
  };
}

export async function getTtsConfig(): Promise<TtsConfig> {
  const stored = await getSetting<TtsConfig>(TTS_CONFIG_KEY);
  if (stored && typeof stored === "object" && "modelId" in stored) {
    return {
      modelId: stored.modelId || "eleven_flash_v2",
      expressiveEnabled: !!stored.expressiveEnabled,
      suggestedAudioTags: Array.isArray(stored.suggestedAudioTags) ? stored.suggestedAudioTags : DEFAULT_AUDIO_TAGS,
      speed: typeof stored.speed === "number" ? stored.speed : 1.0,
      stability: typeof stored.stability === "number" ? stored.stability : 0.5,
      similarityBoost: typeof stored.similarityBoost === "number" ? stored.similarityBoost : 0.75,
      style: typeof stored.style === "number" ? stored.style : 0.0,
    };
  }
  return getDefaultTtsConfig();
}

export async function getShowExpressionTags(): Promise<boolean> {
  const val = await getSetting<boolean>(SHOW_EXPRESSION_TAGS_KEY);
  return val === true;
}

export async function registerVoiceConfigRoutes(app: Express) {
  app.get("/api/elevenlabs/voices", async (_req, res) => {
    try {
      const { listVoices } = await import("../elevenlabs");
      const voices = await listVoices();
      res.json({ voices });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/elevenlabs/voices/ivc/latest", async (_req, res) => {
    try {
      const latest = await getSetting(IVC_LATEST_SETTING_KEY);
      res.json({ latest: latest ?? null });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/elevenlabs/voices/ivc", ivcUpload.array("samples", IVC_UPLOAD_MAX_FILES), async (req, res) => {
    try {
      const files = Array.isArray(req.files) ? req.files as Express.Multer.File[] : [];
      const name = String(req.body?.name ?? "").trim();
      const consent = String(req.body?.consent ?? "") === "true";
      const description = String(req.body?.description ?? "").trim();
      const removeBackgroundNoise = String(req.body?.removeBackgroundNoise ?? "") === "true";

      if (!consent) {
        return res.status(400).json({ error: "Explicit consent is required before creating an Instant Voice Clone." });
      }
      if (!name) {
        return res.status(400).json({ error: "name is required" });
      }
      if (files.length === 0) {
        return res.status(400).json({ error: "At least one recorded sample is required" });
      }

      const labels = {
        use_case: "magic_demo_ftue",
        source: "xyz_integrations_wizard",
      };
      const { createInstantVoiceClone } = await import("../elevenlabs");
      const startedAt = new Date().toISOString();
      const result = await createInstantVoiceClone({
        name,
        description: description || null,
        removeBackgroundNoise,
        labels,
        samples: files.map((file, index) => ({
          buffer: file.buffer,
          filename: file.originalname || `ivc-sample-${index + 1}.webm`,
          contentType: file.mimetype || "application/octet-stream",
        })),
      });

      const latest = {
        voiceId: result.voice_id,
        requiresVerification: result.requires_verification,
        name,
        description: description || null,
        labels,
        sampleCount: files.length,
        removeBackgroundNoise,
        createdAt: startedAt,
      };
      await setSetting(IVC_LATEST_SETTING_KEY, latest);
      voiceLog.log(`IVC voice created voiceId=${result.voice_id} samples=${files.length} requiresVerification=${result.requires_verification}`);
      res.json({ ...latest });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      voiceLog.error(`POST IVC failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/elevenlabs/agent/voice", async (_req, res) => {
    try {
      const agentId = getSecretSync("ELEVENLABS_AGENT_ID");
      if (!agentId) {
        return res.json({ voiceId: null, configured: false });
      }
      const { getAgentConfig } = await import("../elevenlabs");
      const config = await getAgentConfig(agentId);
      const convCfg = config?.conversation_config as Record<string, unknown> | undefined;
      const tts = convCfg?.tts as Record<string, unknown> | undefined;
      const voiceId = (typeof tts?.voice_id === "string" ? tts.voice_id : null);
      res.json({ voiceId, configured: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/elevenlabs/agent/voice", async (req, res) => {
    try {
      const agentId = getSecretSync("ELEVENLABS_AGENT_ID");
      if (!agentId) {
        return res.status(400).json({ error: "Agent not configured — set ELEVENLABS_AGENT_ID in Settings → Connections" });
      }
      const { voiceId } = req.body;
      if (!voiceId) {
        return res.status(400).json({ error: "voiceId is required" });
      }
      const { updateAgentVoice } = await import("../elevenlabs");
      await updateAgentVoice(agentId, voiceId);
      res.json({ updated: true, voiceId });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/elevenlabs/agent/tts-config", async (_req, res) => {
    try {
      const config = await getTtsConfig();
      voiceLog.log(`GET tts-config: model=${config.modelId} expressive=${config.expressiveEnabled} tags=${config.suggestedAudioTags.length}`);
      res.json(config);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      voiceLog.error(`GET tts-config failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/elevenlabs/agent/tts-config", async (req, res) => {
    try {
      const { modelId, expressiveEnabled, suggestedAudioTags } = req.body;

      if (modelId && !["eleven_flash_v2", "eleven_v3_conversational"].includes(modelId)) {
        return res.status(400).json({ error: "Invalid modelId. Must be 'eleven_flash_v2' or 'eleven_v3_conversational'." });
      }

      const existing = await getTtsConfig();

      const parsedTags: AudioTag[] = Array.isArray(suggestedAudioTags)
        ? suggestedAudioTags.slice(0, MAX_AUDIO_TAGS).reduce<AudioTag[]>((acc, item: unknown) => {
            if (item && typeof item === "object") {
              const obj = item as Record<string, unknown>;
              const tag = String(obj.tag ?? "").trim();
              if (tag.length > 0 && !acc.some(prev => prev.tag === tag)) {
                const desc = typeof obj.description === "string" ? obj.description.trim() : undefined;
                acc.push({ tag, ...(desc ? { description: desc } : {}) });
              }
            }
            return acc;
          }, [])
        : existing.suggestedAudioTags;

      const { speed, stability, similarityBoost, style } = req.body;

      const updated: TtsConfig = {
        modelId: modelId ?? existing.modelId,
        expressiveEnabled: typeof expressiveEnabled === "boolean" ? expressiveEnabled : existing.expressiveEnabled,
        suggestedAudioTags: parsedTags,
        speed: typeof speed === "number" ? Math.max(0.5, Math.min(2.0, speed)) : existing.speed,
        stability: typeof stability === "number" ? Math.max(0, Math.min(1, stability)) : existing.stability,
        similarityBoost: typeof similarityBoost === "number" ? Math.max(0, Math.min(1, similarityBoost)) : existing.similarityBoost,
        style: typeof style === "number" ? Math.max(0, Math.min(1, style)) : existing.style,
      };

      if (updated.modelId === "eleven_flash_v2") {
        updated.expressiveEnabled = false;
      }

      await setSetting(TTS_CONFIG_KEY, updated);
      voiceLog.log(`POST tts-config: model=${updated.modelId} expressive=${updated.expressiveEnabled} tags=${updated.suggestedAudioTags.length}`);

      const agentId = getSecretSync("ELEVENLABS_AGENT_ID");
      if (agentId) {
        try {
          const { setupAgentCallbackUrl } = await import("../elevenlabs");
          await setupAgentCallbackUrl(agentId);
          voiceLog.log("Agent re-configured after TTS config change");
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          voiceLog.warn(`Agent re-setup after TTS config change failed (non-fatal): ${errMsg}`);
        }
      }

      res.json(updated);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      voiceLog.error(`POST tts-config failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/elevenlabs/agent/show-expression-tags", async (_req, res) => {
    try {
      const show = await getShowExpressionTags();
      res.json({ showExpressionTags: show });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/elevenlabs/agent/show-expression-tags", async (req, res) => {
    try {
      const { showExpressionTags } = req.body;
      if (typeof showExpressionTags !== "boolean") {
        return res.status(400).json({ error: "showExpressionTags must be a boolean" });
      }
      await setSetting(SHOW_EXPRESSION_TAGS_KEY, showExpressionTags);
      voiceLog.log(`POST show-expression-tags: ${showExpressionTags}`);
      res.json({ showExpressionTags });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/pronunciation", async (_req, res) => {
    try {
      const { listEntries } = await import("../pronunciation");
      const entries = await listEntries();
      res.json({ entries });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/pronunciation", async (req, res) => {
    try {
      const { word, alias } = req.body;
      if (!word || !alias) {
        return res.status(400).json({ error: "word and alias are required" });
      }
      const { addEntry } = await import("../pronunciation");
      const entry = await addEntry(word, alias);
      res.json({ entry });
    } catch (error: any) {
      res.status(error.message.includes("already exists") ? 409 : 500).json({ error: error.message });
    }
  });

  app.put("/api/pronunciation", async (req, res) => {
    try {
      const { word, alias } = req.body;
      if (!word || !alias) {
        return res.status(400).json({ error: "word and alias are required" });
      }
      const { addEntry, updateEntry } = await import("../pronunciation");
      const entry = await updateEntry(word, alias);
      res.json({ entry });
    } catch (error: any) {
      res.status(error.message.includes("not found") ? 404 : 500).json({ error: error.message });
    }
  });

  app.delete("/api/pronunciation", async (req, res) => {
    try {
      const { word } = req.body;
      if (!word) {
        return res.status(400).json({ error: "word is required" });
      }
      const { removeEntry } = await import("../pronunciation");
      await removeEntry(word);
      res.json({ removed: true, word });
    } catch (error: any) {
      res.status(error.message.includes("not found") ? 404 : 500).json({ error: error.message });
    }
  });

  const { voiceSessionEngine } = await import("../voice-session-engine");

  app.get("/api/sessions/voice/sessions", requireAuth, async (_req, res) => {
    try {
      const limit = parseInt(_req.query.limit as string) || 50;
      const sessions = await voiceSessionEngine.getSessions(limit);
      res.json(sessions.map(s => ({
        id: s.id,
        templateName: s.templateName,
        date: s.date,
        createdAt: s.createdAt,
        summary: s.summary || null,
        metadata: s.metadata,
        transcriptLength: s.transcript.length,
        toolCallCount: s.toolCalls.length,
      })));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/sessions/voice/sessions/:id", requireAuth, async (req, res) => {
    try {
      const session = await voiceSessionEngine.getSession(req.params.id);
      if (!session) return res.status(404).json({ error: "Voice session not found" });
      res.json(session);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });
}
