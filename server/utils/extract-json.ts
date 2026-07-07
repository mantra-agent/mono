export function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return trimmed;
  }
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  const firstBrace = trimmed.indexOf("{");
  const firstBracket = trimmed.indexOf("[");
  const starts: Array<{ idx: number; re: RegExp }> = [];
  if (firstBrace >= 0) starts.push({ idx: firstBrace, re: /(\{[\s\S]*\})/ });
  if (firstBracket >= 0) starts.push({ idx: firstBracket, re: /(\[[\s\S]*\])/ });
  starts.sort((a, b) => a.idx - b.idx);
  for (const { re } of starts) {
    const m = trimmed.match(re);
    if (m) return m[1];
  }
  return trimmed;
}
