export const VOICE_FINALIZATION_MAX_SESSION_ID_LENGTH = 200;
export const VOICE_FINALIZATION_MAX_ERROR_LENGTH = 1_000;
export const VOICE_FINALIZATION_MAX_SYSTEM_STEPS = 40;
export const VOICE_FINALIZATION_MAX_STEP_NAME_LENGTH = 160;
export const VOICE_FINALIZATION_MAX_STEP_DETAIL_LENGTH = 500;

export interface VoiceFinalizationSystemStep {
  name: string;
  status: "done" | "error";
  detail?: string;
}

export interface VoiceFinalizationRequest {
  sessionId: string;
  errorMessage?: string;
  systemSteps?: VoiceFinalizationSystemStep[];
}

export type VoiceFinalizationResponse =
  | { outcome: "finalized"; replayed: boolean }
  | {
      outcome: "not_finalized";
      reason: "invalid_request" | "not_completable";
    }
  | { outcome: "unknown"; reason: "internal_error" };

export type VoiceFinalizationSettlement =
  | { outcome: "finalized"; source: "response" | "reconciliation"; replayed?: boolean }
  | { outcome: "not_finalized"; reason: string }
  | { outcome: "unknown"; reason: string };

function boundedOptionalText(value: string | undefined, maxLength: number): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

export function createVoiceFinalizationRequest(input: {
  sessionId: string;
  errorMessage?: string;
  systemSteps?: VoiceFinalizationSystemStep[];
}): VoiceFinalizationRequest {
  const systemSteps = input.systemSteps
    ?.slice(-VOICE_FINALIZATION_MAX_SYSTEM_STEPS)
    .map((step) => ({
      name: step.name.trim().slice(0, VOICE_FINALIZATION_MAX_STEP_NAME_LENGTH),
      status: step.status,
      detail: boundedOptionalText(step.detail, VOICE_FINALIZATION_MAX_STEP_DETAIL_LENGTH),
    }))
    .filter((step) => step.name.length > 0);

  return {
    sessionId: input.sessionId.trim().slice(0, VOICE_FINALIZATION_MAX_SESSION_ID_LENGTH),
    errorMessage: boundedOptionalText(input.errorMessage, VOICE_FINALIZATION_MAX_ERROR_LENGTH),
    systemSteps: systemSteps && systemSteps.length > 0 ? systemSteps : undefined,
  };
}

export function parseVoiceFinalizationRequest(input: unknown):
  | { ok: true; value: VoiceFinalizationRequest }
  | { ok: false } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false };
  const record = input as Record<string, unknown>;
  const allowedKeys = new Set(["sessionId", "errorMessage", "systemSteps"]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) return { ok: false };

  if (
    typeof record.sessionId !== "string"
    || record.sessionId.trim().length === 0
    || record.sessionId.trim().length > VOICE_FINALIZATION_MAX_SESSION_ID_LENGTH
  ) {
    return { ok: false };
  }

  let errorMessage: string | undefined;
  if (record.errorMessage !== undefined) {
    if (
      typeof record.errorMessage !== "string"
      || record.errorMessage.trim().length === 0
      || record.errorMessage.trim().length > VOICE_FINALIZATION_MAX_ERROR_LENGTH
    ) {
      return { ok: false };
    }
    errorMessage = record.errorMessage.trim();
  }

  let systemSteps: VoiceFinalizationSystemStep[] | undefined;
  if (record.systemSteps !== undefined) {
    if (
      !Array.isArray(record.systemSteps)
      || record.systemSteps.length === 0
      || record.systemSteps.length > VOICE_FINALIZATION_MAX_SYSTEM_STEPS
    ) {
      return { ok: false };
    }
    systemSteps = [];
    for (const rawStep of record.systemSteps) {
      if (!rawStep || typeof rawStep !== "object" || Array.isArray(rawStep)) return { ok: false };
      const step = rawStep as Record<string, unknown>;
      const allowedStepKeys = new Set(["name", "status", "detail"]);
      if (Object.keys(step).some((key) => !allowedStepKeys.has(key))) return { ok: false };
      if (
        typeof step.name !== "string"
        || step.name.trim().length === 0
        || step.name.trim().length > VOICE_FINALIZATION_MAX_STEP_NAME_LENGTH
        || (step.status !== "done" && step.status !== "error")
      ) {
        return { ok: false };
      }
      if (
        step.detail !== undefined
        && (typeof step.detail !== "string" || step.detail.length > VOICE_FINALIZATION_MAX_STEP_DETAIL_LENGTH)
      ) {
        return { ok: false };
      }
      systemSteps.push({
        name: step.name.trim(),
        status: step.status,
        detail: typeof step.detail === "string" && step.detail.trim() ? step.detail.trim() : undefined,
      });
    }
  }

  return {
    ok: true,
    value: {
      sessionId: record.sessionId.trim(),
      errorMessage,
      systemSteps,
    },
  };
}

export function isVoiceFinalizationResponse(input: unknown): input is VoiceFinalizationResponse {
  if (!input || typeof input !== "object") return false;
  const response = input as Record<string, unknown>;
  if (response.outcome === "finalized") return typeof response.replayed === "boolean";
  if (response.outcome === "unknown") return response.reason === "internal_error";
  return response.outcome === "not_finalized"
    && (response.reason === "invalid_request" || response.reason === "not_completable");
}
