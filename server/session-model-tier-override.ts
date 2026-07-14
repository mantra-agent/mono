import { AsyncLocalStorage } from "node:async_hooks";
import { semanticTierSchema, type SemanticTier } from "@shared/model-connectors";
import type { InferenceMetadata } from "./model-client";

const storage = new AsyncLocalStorage<SemanticTier | null>();

export function normalizeSessionModelTierOverride(value: unknown): SemanticTier | null {
  if (value === null || value === undefined || value === "" || value === "auto") return null;
  const parsed = semanticTierSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function getActiveSessionModelTierOverride(): SemanticTier | null {
  return storage.getStore() ?? null;
}

export async function withSessionModelTierOverride<T>(
  override: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(normalizeSessionModelTierOverride(override), fn);
}

export async function resolveSessionModelTierOverride(
  metadata?: InferenceMetadata,
): Promise<SemanticTier | null> {
  const active = getActiveSessionModelTierOverride();
  if (active) return active;

  const sessionId = metadata?.sessionId;
  if (!sessionId) return null;

  try {
    const { chatFileStorage } = await import("./chat-file-storage");
    const session = await chatFileStorage.getSession(sessionId);
    return normalizeSessionModelTierOverride(session?.modelTier);
  } catch {
    return null;
  }
}
