/**
 * Voice engine handle — the single voice implementation.
 * Custom-LLM pipeline: ElevenLabs handles audio, our server handles LLM.
 */
import { handleV25CustomLLM } from "./turn-lifecycle";

export const voiceEngine = {
  available: true as const,
  /** Custom-LLM HTTP entry point (called from voice-session.ts). */
  handleCustomLLM: handleV25CustomLLM,
};
