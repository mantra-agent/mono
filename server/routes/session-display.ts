import type { Express } from "express";
import { getSetting, setSetting } from "../system-settings";
import { getArtifactsBySession, getSessionsByArtifact } from "../session-artifacts";
import { chatFileStorage } from "../chat-file-storage";
import { requireAuth } from "../auth";

const VISIBILITY_LAYER_KEY = "session_visibility_layer";

export async function getVisibilityLayer(): Promise<number> {
  const val = await getSetting<number>(VISIBILITY_LAYER_KEY);
  if (typeof val === "number" && val >= 1 && val <= 4) return val;
  return 2;
}

export function registerSessionDisplayRoutes(app: Express) {
  app.get("/api/session/visibility-layer", async (_req, res) => {
    try {
      const layer = await getVisibilityLayer();
      res.json({ layer });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // Session artifacts: get all artifacts linked to a session
  app.get("/api/sessions/:id/artifacts", requireAuth, async (req, res) => {
    try {
      const session = await chatFileStorage.getSession(req.params.id);
      if (!session) return res.status(404).json({ error: "Session not found" });
      const artifacts = await getArtifactsBySession(req.params.id);
      res.json(artifacts);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // Library page linked sessions: get all sessions that touched a library page
  app.get("/api/library/:slug/sessions", requireAuth, async (req, res) => {
    try {
      const artifactRows = await getSessionsByArtifact("library_page", req.params.slug);
      // Enrich with session summaries
      const sessions = (await Promise.all(
        artifactRows.map(async (row) => {
          const session = await chatFileStorage.getSession(row.sessionId);
          if (!session) return null;
          return {
            sessionId: row.sessionId,
            title: session.title || "Untitled",
            sessionType: session.sessionType || "unknown",
            createdAt: row.createdAt,
          };
        }),
      )).filter((session): session is NonNullable<typeof session> => session !== null);
      res.json(sessions);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/session/visibility-layer", async (req, res) => {
    try {
      const { layer } = req.body;
      if (typeof layer !== "number" || layer < 1 || layer > 4 || !Number.isInteger(layer)) {
        return res.status(400).json({ error: "layer must be an integer between 1 and 4" });
      }
      await setSetting(VISIBILITY_LAYER_KEY, layer);
      res.json({ layer });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });
}
