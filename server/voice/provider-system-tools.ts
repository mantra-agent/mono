import type { ToolDefinition } from "@shared/models/tools";

export const ELEVENLABS_ADDITIONAL_LANGUAGE_CODES = [
  "ar", "bg", "zh", "hr", "cs", "da", "nl", "fi", "fr", "de", "el",
  "hi", "hu", "id", "it", "ja", "ko", "ms", "no", "pl", "pt", "ro",
  "ru", "sk", "es", "sv", "ta", "tr", "uk", "vi", "fil",
] as const;

export const ELEVENLABS_LANGUAGE_CODES = ["en", ...ELEVENLABS_ADDITIONAL_LANGUAGE_CODES] as const;

export type ElevenLabsAdditionalLanguageCode = typeof ELEVENLABS_ADDITIONAL_LANGUAGE_CODES[number];
export type ElevenLabsLanguageCode = typeof ELEVENLABS_LANGUAGE_CODES[number];

export interface ProviderSystemToolCall {
  callId: string;
  name: "language_detection";
  args: {
    reason: string;
    language: ElevenLabsLanguageCode;
  };
}

const SUPPORTED_LANGUAGE_CODES = new Set<string>(ELEVENLABS_LANGUAGE_CODES);
const PROVIDER_SYSTEM_TOOL_NAMES = new Set(["language_detection"]);

interface OpenAIToolEnvelope {
  type?: unknown;
  function?: {
    name?: unknown;
    description?: unknown;
    parameters?: unknown;
  };
}

export function buildLanguagePresets(): Record<ElevenLabsAdditionalLanguageCode, {
  overrides: { agent: { first_message: string } };
}> {
  return Object.fromEntries(ELEVENLABS_ADDITIONAL_LANGUAGE_CODES.map((language) => [
    language,
    { overrides: { agent: { first_message: "" } } },
  ])) as Record<ElevenLabsAdditionalLanguageCode, { overrides: { agent: { first_message: string } } }>;
}

export function extractProviderSystemTools(value: unknown): ToolDefinition[] {
  if (!Array.isArray(value)) return [];

  const tools: ToolDefinition[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const envelope = candidate as OpenAIToolEnvelope;
    if (envelope.type !== "function" || !envelope.function) continue;

    const name = typeof envelope.function.name === "string" ? envelope.function.name : "";
    if (!PROVIDER_SYSTEM_TOOL_NAMES.has(name)) continue;

    const parameters = envelope.function.parameters;
    if (!parameters || typeof parameters !== "object") continue;
    const parameterRecord = parameters as Record<string, unknown>;
    if (parameterRecord.type !== "object" || !parameterRecord.properties || typeof parameterRecord.properties !== "object") continue;

    tools.push({
      name,
      description: typeof envelope.function.description === "string" ? envelope.function.description : "",
      parameters: {
        type: "object",
        properties: parameterRecord.properties as Record<string, unknown>,
        required: Array.isArray(parameterRecord.required)
          ? parameterRecord.required.filter((entry): entry is string => typeof entry === "string")
          : undefined,
      },
    });
  }
  return tools;
}

export function mergeVoiceTools(
  applicationTools: ToolDefinition[],
  providerSystemTools: ToolDefinition[],
): ToolDefinition[] {
  if (providerSystemTools.length === 0) return applicationTools;
  const providerNames = new Set(providerSystemTools.map((tool) => tool.name));
  return [
    ...applicationTools.filter((tool) => !providerNames.has(tool.name)),
    ...providerSystemTools,
  ];
}

export function createLanguageDetectionCall(
  voiceSessionId: string,
  turn: number,
  args: Record<string, unknown>,
): ProviderSystemToolCall | null {
  const language = typeof args.language === "string" ? args.language.trim().toLowerCase() : "";
  const reason = typeof args.reason === "string" ? args.reason.trim() : "";
  if (!SUPPORTED_LANGUAGE_CODES.has(language) || !reason) return null;

  return {
    callId: `call_language_${voiceSessionId}_${turn}_${Date.now()}`,
    name: "language_detection",
    args: {
      reason,
      language: language as ElevenLabsLanguageCode,
    },
  };
}
