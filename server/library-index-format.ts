export type LibraryIndexCategory = "Entities" | "Concepts" | "Synthesis";

export interface LibraryIndexSection {
  id: string;
  title: string;
  path: string;
  depth: number;
  sortOrder: number;
  category: LibraryIndexCategory;
}

export interface LibraryIndexEntry {
  id: string;
  title: string;
  category: LibraryIndexCategory;
  description: string;
  sortOrder: number;
  sectionId: string | null;
  sectionPath: string | null;
}

export interface LibraryIndexStructure {
  sections: LibraryIndexSection[];
  entries: LibraryIndexEntry[];
}

export function normalizeLibraryIndexCategory(value: unknown): LibraryIndexCategory {
  const text = String(value ?? "").toLowerCase();
  if (text.startsWith("entit")) return "Entities";
  if (text.startsWith("synth")) return "Synthesis";
  return "Concepts";
}

export function libraryIndexSectionId(path: string): string {
  return `index-section:${path}`;
}

export function parseLibraryIndexStructure(indexContent: string): LibraryIndexStructure {
  const sections: LibraryIndexSection[] = [];
  const entries: LibraryIndexEntry[] = [];
  const headingStack: Array<{ level: number; title: string }> = [];
  const seenSectionPaths = new Set<string>();
  let category: LibraryIndexCategory = "Concepts";
  let currentSection: LibraryIndexSection | null = null;
  let currentCategorySection: LibraryIndexSection | null = null;
  let sortOrder = 0;

  for (const line of indexContent.split(/\r?\n/)) {
    const heading = line.match(/^\s*(#{2,6})\s+(.+?)\s*$/);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2].trim();
      while (
        headingStack.length > 0 &&
        headingStack[headingStack.length - 1].level >= level
      ) {
        headingStack.pop();
      }
      headingStack.push({ level, title });
      const path = headingStack.map((item) => item.title).join(" / ");
      if (/^(Entities|Concepts|Synthesis)$/i.test(title)) {
        category = normalizeLibraryIndexCategory(title);
      }
      currentSection = {
        id: libraryIndexSectionId(path),
        title,
        path,
        depth: headingStack.length - 1,
        sortOrder: sortOrder++,
        category,
      };
      if (!seenSectionPaths.has(path)) {
        sections.push(currentSection);
        seenSectionPaths.add(path);
      }
      if (/^(Entities|Concepts|Synthesis)$/i.test(title)) {
        currentCategorySection = currentSection;
      }
      continue;
    }

    // Some legacy projections stripped heading markers while preserving the
    // canonical category title. Accept those three headings without treating
    // arbitrary prose as structure.
    const plainCategory = line.trim();
    if (/^(Entities|Concepts|Synthesis)$/i.test(plainCategory)) {
      category = normalizeLibraryIndexCategory(plainCategory);
      currentSection = {
        id: libraryIndexSectionId(category),
        title: category,
        path: category,
        depth: 0,
        sortOrder: sortOrder++,
        category,
      };
      if (!seenSectionPaths.has(currentSection.path)) {
        sections.push(currentSection);
        seenSectionPaths.add(currentSection.path);
      }
      currentCategorySection = currentSection;
      headingStack.length = 0;
      continue;
    }

    // TipTap plain-text projection strips Markdown list markers, so both the
    // persisted plain-text form and the Markdown source form are canonical.
    const match = line.match(
      /^\s*(?:[-*+]\s+)?@page:([A-Za-z0-9_-]+)\s*(?:—|-|:)\s*(.+)$/,
    );
    if (!match) continue;
    entries.push({
      id: match[1],
      title: match[1],
      category,
      description: match[2].trim(),
      sortOrder: sortOrder++,
      sectionId: (currentSection ?? currentCategorySection)?.id ?? null,
      sectionPath: (currentSection ?? currentCategorySection)?.path ?? null,
    });
  }

  return { sections, entries };
}

export function parseLibraryIndexEntries(indexContent: string): LibraryIndexEntry[] {
  return parseLibraryIndexStructure(indexContent).entries;
}
