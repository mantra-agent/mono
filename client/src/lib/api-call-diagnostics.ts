import { formatDiagnosticValue } from "@/lib/diagnostic-error";

export interface DiagnosticApiCallLike {
  stopReason?: string | null;
  responseContent?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface DiagnosticApiCallContentLike {
  responseContent?: string | null;
}

function stringifyDiagnosticValue(value: unknown): string | undefined {
  const text = formatDiagnosticValue(value);
  if (!text) return undefined;

  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const direct = stringifyDiagnosticValue(record.message)
      || stringifyDiagnosticValue(record.error)
      || stringifyDiagnosticValue(record.detail)
      || stringifyDiagnosticValue(record.reason);
    if (direct) {
      const code = stringifyDiagnosticValue(record.code);
      const status = stringifyDiagnosticValue(record.status);
      const suffix = [code && `code=${code}`, status && `status=${status}`].filter(Boolean).join(" ");
      return suffix ? `${direct} (${suffix})` : direct;
    }
  }

  return text;
}

function parseContentErrorText(content?: string | null): string | undefined {
  const text = stringifyDiagnosticValue(content);
  if (!text) return undefined;

  try {
    const parsed = JSON.parse(text);
    const parsedText = stringifyDiagnosticValue(parsed);
    if (parsedText) return parsedText;
  } catch {
    // Plain text response content is still useful diagnostic text.
  }

  return text;
}

export function getApiCallErrorText(
  call: DiagnosticApiCallLike,
  content?: DiagnosticApiCallContentLike | null,
): string | undefined {
  const metadata = call.metadata ?? undefined;
  const status = stringifyDiagnosticValue(metadata?.status)?.toLowerCase();
  const metadataError = stringifyDiagnosticValue(metadata?.error)
    || stringifyDiagnosticValue(metadata?.errorMessage)
    || stringifyDiagnosticValue(metadata?.lastError);
  if (metadataError) return metadataError;

  const responseError = parseContentErrorText(content?.responseContent ?? call.responseContent ?? null);
  if (responseError) return responseError;

  const stopReason = stringifyDiagnosticValue(call.stopReason);
  if (status && status !== "success") {
    return stopReason || `Call ended with status: ${status}`;
  }
  if (stopReason && stopReason.toLowerCase().includes("error")) return stopReason;

  return undefined;
}

export function shouldShowApiCallResponse(
  responseContent: string | null | undefined,
  errorText: string | undefined,
): boolean {
  const text = responseContent?.trim();
  if (!text || text === "true" || text === "false") return false;
  return !errorText || text !== errorText.trim();
}
