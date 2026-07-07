import express, { type Express, type Request, type Response } from "express";
import { chatStorage } from "../chat/storage";
import { speechToText, ensureCompatibleFormat, sessionAudioResponseStream } from "./client";
import { createLogger } from "../../log";
import { requireAuth } from "../../auth";

const log = createLogger("AudioRoutes");

// Body parser with 50MB limit for audio payloads
const audioBodyParser = express.json({ limit: "50mb" });

export function registerAudioRoutes(app: Express): void {
  app.use("/api/sessions", requireAuth);
  // Get all conversations
  app.get("/api/sessions", async (req: Request, res: Response) => {
    try {
      const conversations = await chatStorage.getAllSessions();
      res.json(conversations);
    } catch (error) {
      log.error("Error fetching sessions:", error);
      res.status(500).json({ error: "Failed to fetch sessions" });
    }
  });

  // Get single session with messages
  app.get("/api/sessions/:id", async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const session = await chatStorage.getSession(id);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }
      const messages = await chatStorage.getMessagesBySession(id);
      res.json({ ...session, messages });
    } catch (error) {
      log.error("Error fetching session:", error);
      res.status(500).json({ error: "Failed to fetch session" });
    }
  });

  // Create new session
  app.post("/api/sessions", async (req: Request, res: Response) => {
    try {
      const { title } = req.body;
      const session = await chatStorage.createSession(title || "New Session", undefined, undefined, { provenance: { triggerType: "user", triggerName: title || "New Session" } });
      res.status(201).json(session);
    } catch (error) {
      log.error("Error creating session:", error);
      res.status(500).json({ error: "Failed to create session" });
    }
  });

  // Delete session
  app.delete("/api/sessions/:id", async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      await chatStorage.deleteSession(id);
      res.status(204).send();
    } catch (error) {
      log.error("Error deleting session:", error);
      res.status(500).json({ error: "Failed to delete session" });
    }
  });

  // Send voice message and get streaming audio response
  // Auto-detects audio format and converts WebM/MP4/OGG to WAV
  // Uses gpt-4o-mini-transcribe for STT, gpt-audio for voice response
  app.post("/api/sessions/:id/messages", audioBodyParser, async (req: Request, res: Response) => {
    try {
      const sessionId = req.params.id as string;
      const { audio, voice = "alloy" } = req.body;

      if (!audio) {
        return res.status(400).json({ error: "Audio data (base64) is required" });
      }

      // 1. Auto-detect format and convert to OpenAI-compatible format
      const rawBuffer = Buffer.from(audio, "base64");
      const { buffer: audioBuffer, format: inputFormat } = await ensureCompatibleFormat(rawBuffer);

      // 2. Transcribe user audio
      const userTranscript = await speechToText(audioBuffer, inputFormat);

      // 3. Save user message
      await chatStorage.createMessage(sessionId, "user", userTranscript);

      // 4. Get session history
      const existingMessages = await chatStorage.getMessagesBySession(sessionId);
      const chatHistory = existingMessages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      // 5. Set up SSE
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      res.write(`data: ${JSON.stringify({ type: "user_transcript", data: userTranscript })}\n\n`);

      // 6. Stream audio response through the specialized audio model boundary.
      const stream = await sessionAudioResponseStream(chatHistory, voice, String(sessionId));
      let assistantTranscript = "";

      for await (const event of stream) {
        if (event.type === "transcript") {
          assistantTranscript += event.data;
        }
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }

      // 7. Save assistant message
      await chatStorage.createMessage(sessionId, "assistant", assistantTranscript, undefined, undefined, "openai/gpt-audio");

      res.write(`data: ${JSON.stringify({ type: "done", transcript: assistantTranscript })}\n\n`);
      res.end();
    } catch (error) {
      log.error("Error processing voice message:", error);
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ type: "error", error: "Failed to process voice message" })}\n\n`);
        res.end();
      } else {
        res.status(500).json({ error: "Failed to process voice message" });
      }
    }
  });
}
