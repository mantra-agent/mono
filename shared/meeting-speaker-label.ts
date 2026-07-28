const LEGACY_UNKNOWN_SPEAKER = /^unknown speaker\s+(\d+)$/i;

export function meetingSpeakerDisplayLabel(
  label: string | null | undefined,
  fallbackOrdinal?: number,
): string {
  const trimmed = label?.trim() || "";
  const legacyMatch = trimmed.match(LEGACY_UNKNOWN_SPEAKER);
  if (legacyMatch) return `Speaker ${legacyMatch[1]}`;
  if (trimmed) return trimmed;
  return fallbackOrdinal == null ? "Speaker" : `Speaker ${fallbackOrdinal}`;
}
