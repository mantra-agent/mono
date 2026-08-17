/**
 * Pure heading-shape validation for document templates.
 * Template page markdown is the vessel; artifact markdown is judged against it.
 */

export interface ShapeHeading {
  level: 2 | 3;
  title: string;
  /** When the template line after the heading contains "omit if empty". */
  omitIfEmpty: boolean;
}

export interface ArtifactShapeValidation {
  ok: boolean;
  residuals: string[];
  /** True when template has a date/## heading then unlabeled lead body before the next heading. */
  requiresUnlabeledLead: boolean;
  missingUnlabeledLead: boolean;
}

const HEADING_RE = /^(#{2,3})\s+(.+?)\s*$/;

function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Extract ## / ### headings and omit-if-empty markers from template markdown. */
export function extractTemplateHeadings(templateMarkdown: string): ShapeHeading[] {
  const lines = templateMarkdown.replace(/\r\n/g, "\n").split("\n");
  const headings: ShapeHeading[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(HEADING_RE);
    if (!match) continue;
    const level = match[1].length as 2 | 3;
    if (level !== 2 && level !== 3) continue;
    const title = match[2].trim();
    if (!title) continue;
    if (normalizeTitle(title) === "residual") continue;
    let omitIfEmpty = false;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j].trim();
      if (!next) continue;
      if (HEADING_RE.test(lines[j])) break;
      if (/omit if empty/i.test(next)) {
        omitIfEmpty = true;
      }
      break;
    }
    headings.push({ level, title, omitIfEmpty });
  }
  return headings;
}

interface ArtifactSection {
  level: 2 | 3;
  title: string;
  body: string;
}

function parseArtifactSections(markdown: string): {
  sections: ArtifactSection[];
  leadBeforeFirstHeading: string;
} {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const sections: ArtifactSection[] = [];
  let leadBeforeFirstHeading = "";
  let current: ArtifactSection | null = null;
  const bodyLines: string[] = [];
  const leadLines: string[] = [];
  let sawHeading = false;

  const flush = () => {
    if (!current) return;
    current.body = bodyLines.join("\n").trim();
    sections.push(current);
    bodyLines.length = 0;
  };

  for (const line of lines) {
    const match = line.match(HEADING_RE);
    if (match) {
      const level = match[1].length as 2 | 3;
      if (level === 2 || level === 3) {
        flush();
        if (!sawHeading) {
          leadBeforeFirstHeading = leadLines.join("\n").trim();
          leadLines.length = 0;
        }
        sawHeading = true;
        current = { level, title: match[2].trim(), body: "" };
        continue;
      }
    }
    if (!sawHeading) leadLines.push(line);
    else bodyLines.push(line);
  }
  flush();
  if (!sawHeading) leadBeforeFirstHeading = leadLines.join("\n").trim();
  return { sections, leadBeforeFirstHeading };
}

function sectionBodyNonEmpty(body: string): boolean {
  const stripped = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^\s*[-*+]\s*$/gm, "")
    .trim();
  return stripped.length > 0;
}

/**
 * Validate artifact markdown against template markdown headings.
 * v1 rules from Spec: required ##/### present with non-empty body unless omit-if-empty;
 * unlabeled lead when template date heading is followed by body before next heading.
 */
export function validateArtifactShape(
  artifactMarkdown: string,
  templateMarkdown: string,
): ArtifactShapeValidation {
  const templateHeadings = extractTemplateHeadings(templateMarkdown);
  const { sections, leadBeforeFirstHeading } = parseArtifactSections(artifactMarkdown);

  const templateLines = templateMarkdown.replace(/\r\n/g, "\n").split("\n");
  let requiresUnlabeledLead = false;
  for (let i = 0; i < templateLines.length; i++) {
    const match = templateLines[i].match(HEADING_RE);
    if (!match || match[1].length !== 2) continue;
    let bodyBeforeNext = "";
    for (let j = i + 1; j < templateLines.length; j++) {
      if (HEADING_RE.test(templateLines[j])) break;
      bodyBeforeNext += templateLines[j] + "\n";
    }
    const note = bodyBeforeNext.trim();
    if (/unlabeled lead/i.test(note) || /^\d{4}-\d{2}-\d{2}/.test(match[2].trim())) {
      if (/unlabeled lead/i.test(note) || /lead/i.test(note)) {
        requiresUnlabeledLead = true;
      }
    }
    break;
  }

  const residuals: string[] = [];
  const byTitle = new Map<string, ArtifactSection[]>();
  for (const section of sections) {
    if (normalizeTitle(section.title) === "residual") continue;
    const key = normalizeTitle(section.title);
    const list = byTitle.get(key) ?? [];
    list.push(section);
    byTitle.set(key, list);
  }

  for (const heading of templateHeadings) {
    const isDateVessel = /^yyyy-mm-dd$/i.test(heading.title.trim()) || heading.title.includes("YYYY-MM-DD");
    let match: ArtifactSection | undefined;
    if (isDateVessel) {
      match = sections.find((s) => s.level === 2 && /^\d{4}-\d{2}-\d{2}/.test(s.title.trim()));
    } else {
      const candidates = byTitle.get(normalizeTitle(heading.title)) ?? [];
      match = candidates.find((s) => s.level === heading.level) ?? candidates[0];
    }

    if (!match) {
      if (!heading.omitIfEmpty) {
        residuals.push(heading.title);
      }
      continue;
    }
    if (!sectionBodyNonEmpty(match.body) && !heading.omitIfEmpty) {
      residuals.push(heading.title);
    }
  }

  const missingUnlabeledLead = requiresUnlabeledLead && !sectionBodyNonEmpty(leadBeforeFirstHeading);
  if (missingUnlabeledLead) {
    residuals.push("unlabeled lead");
  }

  return {
    ok: residuals.length === 0,
    residuals,
    requiresUnlabeledLead,
    missingUnlabeledLead,
  };
}

/** Append or replace trailing ## Residual (Spec/Weekly) list. */
export function applySpecResidualSection(markdown: string, residuals: string[]): string {
  const without = stripTrailingResidual(markdown, 2);
  if (residuals.length === 0) return without.trimEnd() + "\n";
  const list = residuals.map((r) => `- Missing required section: ${r}`).join("\n");
  return `${without.trimEnd()}\n\n## Residual\n\n${list}\n`;
}

/** Inside a Digest day entry, ### Residual only when residuals exist. */
export function applyDigestDayResidual(markdown: string, residuals: string[]): string {
  const without = stripTrailingResidual(markdown, 3);
  if (residuals.length === 0) return without.trimEnd() + "\n";
  const list = residuals.map((r) => `- Missing required section: ${r}`).join("\n");
  return `${without.trimEnd()}\n\n### Residual\n\n${list}\n`;
}

function stripTrailingResidual(markdown: string, level: 2 | 3): string {
  const marker = level === 2 ? /^##\s+Residual\s*$/im : /^###\s+Residual\s*$/im;
  const match = markdown.match(marker);
  if (!match || match.index === undefined) return markdown;
  return markdown.slice(0, match.index).trimEnd();
}
