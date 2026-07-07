export function sanitizeSummary(summary: string): string {
  if (!summary) return summary;
  const trimmed = summary.trim();
  if (!trimmed.startsWith("{") || !trimmed.includes('"summary"')) return summary;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed.summary === "string" && parsed.summary.trim()) {
      return parsed.summary.trim();
    }
    if (parsed && typeof parsed.title === "string" && parsed.title.trim()) {
      return parsed.title.trim();
    }
  } catch {}
  const match = trimmed.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (match) {
    try {
      return JSON.parse(`"${match[1]}"`);
    } catch {
      return match[1];
    }
  }
  return summary;
}


// --- Progressive Summarization: Summary Quality Validation ---

const GARBAGE_MARKERS = [
  "<function_calls>",
  "<invoke ",
  "<parameter ",
  "```xml",
  "<tool_call>",
  "<tool_response>",
  "<turn role=",
];

export interface SummaryValidation {
  valid: boolean;
  reason?: string;
  compressionRatio?: number;
}

export function validateSummary(summary: string, inputLength: number): SummaryValidation {
  if (!summary || !summary.trim()) {
    return { valid: false, reason: "empty" };
  }

  const MAX_SUMMARY_LENGTH = 3000;
  if (summary.length > MAX_SUMMARY_LENGTH) {
    return { valid: false, reason: `too_long: ${summary.length} chars (max ${MAX_SUMMARY_LENGTH})` };
  }

  const compressionRatio = inputLength > 0 ? summary.length / inputLength : 0;
  if (inputLength > 1000 && compressionRatio > 0.8) {
    return { valid: false, reason: `not_compressed: ratio ${compressionRatio.toFixed(2)}`, compressionRatio };
  }

  for (const marker of GARBAGE_MARKERS) {
    if (summary.includes(marker)) {
      return { valid: false, reason: `garbage_marker: ${marker}`, compressionRatio };
    }
  }

  return { valid: true, compressionRatio };
}
