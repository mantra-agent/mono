export function normalizeForComparison(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

export function isSimilarText(a: string, b: string): boolean {
  const na = normalizeForComparison(a);
  const nb = normalizeForComparison(b);
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const wordsA = Array.from(new Set(na.split(" ").filter(w => w.length > 3)));
  const wordsB = new Set(nb.split(" ").filter(w => w.length > 3));
  if (wordsA.length === 0 || wordsB.size === 0) return false;
  let overlap = 0;
  for (const w of wordsA) if (wordsB.has(w)) overlap++;
  const similarity = overlap / Math.max(wordsA.length, wordsB.size);
  return similarity >= 0.7;
}
