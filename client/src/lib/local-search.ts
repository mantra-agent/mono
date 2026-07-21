export function getSearchTokens(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

export function matchesSearchTokens(
  tokens: string[],
  values: Array<string | number | null | undefined>,
): boolean {
  if (tokens.length === 0) return true;
  const searchableText = values.filter((value) => value != null).join(" ").toLowerCase();
  return tokens.every((token) => searchableText.includes(token));
}
