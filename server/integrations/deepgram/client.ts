import { getSecretSync } from "../../secrets-store";

export interface DeepgramConnectionResult {
  connected: boolean;
  projectCount?: number;
  error?: string;
}

export function hasDeepgramApiKey(): boolean {
  return Boolean(getSecretSync("DEEPGRAM_API_KEY")?.trim());
}

export async function testDeepgramConnection(): Promise<DeepgramConnectionResult> {
  const apiKey = getSecretSync("DEEPGRAM_API_KEY")?.trim();
  if (!apiKey) return { connected: false, error: "API key is required." };
  try {
    const response = await fetch("https://api.deepgram.com/v1/projects", {
      headers: { Authorization: `Token ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Deepgram API returned ${response.status}`);
    const payload = await response.json() as { projects?: unknown[] };
    return { connected: true, projectCount: payload.projects?.length ?? 0 };
  } catch (error) {
    return { connected: false, error: error instanceof Error ? error.message : "Deepgram connection failed." };
  }
}
