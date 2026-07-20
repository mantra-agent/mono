export type LibraryIndexCategory = "Entities" | "Concepts" | "Synthesis";

export interface LibraryIndexEntry {
  id: string;
  title: string;
  category: LibraryIndexCategory;
  description: string;
}

export function normalizeLibraryIndexCategory(value: unknown): LibraryIndexCategory {
  const text = String(value ?? "").toLowerCase();
  if (text.startsWith("entit")) return "Entities";
  if (text.startsWith("synth")) return "Synthesis";
  return "Concepts";
}

export function parseLibraryIndexEntries(indexContent: string): LibraryIndexEntry[] {
  const entries: LibraryIndexEntry[] = [];
  let category: LibraryIndexCategory = "Concepts";

  for (const line of indexContent.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(Entities|Concepts|Synthesis)\s*$/i);
    if (heading) {
      category = normalizeLibraryIndexCategory(heading[1]);
      continue;
    }

    // TipTap plain-text projection strips Markdown list markers, so both the
    // persisted plain-text form and the Markdown source form are canonical.
    const match = line.match(/^\s*(?:[-*+]\s+)?@page:([A-Za-z0-9_-]+)\s*(?:—|-|:)\s*(.+)$/);
    if (!match) continue;
    entries.push({
      id: match[1],
      title: match[1],
      category,
      description: match[2].trim(),
    });
  }

  return entries;
}
