export function formatDiagnosticValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "true" || trimmed === "false") return "";
    return trimmed;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function formatDiagnosticError(error: unknown, fallback?: unknown, emptyMessage = "Operation failed without an error message."): string {
  const errorText = formatDiagnosticValue(error);
  if (errorText) return errorText;

  const fallbackText = formatDiagnosticValue(fallback);
  if (fallbackText) return fallbackText;

  return emptyMessage;
}

export function hasDiagnosticErrorDetail(error: unknown, fallback?: unknown): boolean {
  return Boolean(formatDiagnosticValue(error) || formatDiagnosticValue(fallback));
}
