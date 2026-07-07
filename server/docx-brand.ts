/**
 * DOCX Brand Styling Module
 *
 * Exports brand constants and helper functions for generating
 * visually branded Word documents. All values derived from the
 * Resume Design Standard library page.
 *
 * Used by artifact-docx.ts and any
 * future DOCX generation that needs consistent brand styling.
 */

import {
  Paragraph,
  TextRun,
  BorderStyle,
  AlignmentType,
  TabStopType,
  TabStopPosition,
  type ISectionOptions,
} from "docx";

// ---------------------------------------------------------------------------
// Brand Constants — Resume Design Standard compliant
// ---------------------------------------------------------------------------

/**
 * Brand design tokens for DOCX generation.
 * Colors are 6-char hex (no #) as required by the docx package.
 * Font sizes are in half-points. Spacing is in twips (1pt = 20 twips).
 */
export const BRAND = {
  colors: {
    /** Near-black body text */
    foreground: "1A1A1A",
    /** Gray-500 equivalent for dates, contact info */
    muted: "5C6370",
    /** Dark green for section headers — B&W safe */
    accent: "1A6B5E",
    /** Light gray for horizontal rules / separators */
    separator: "D1D5DB",
    /** Page background */
    white: "FFFFFF",
  },
  fonts: {
    /** ATS-safe primary font — ships with every OS */
    primary: "Calibri",
    /** Universal fallback */
    fallback: "Arial",
  },
  sizes: {
    /** 20pt — candidate name */
    name: 38,
    /** 12pt — target title under name, section headers */
    sectionHeader: 24,
    /** 11pt — subsection headers (company/title lines), body text */
    body: 22,
    /** 10pt — small: skills grid, dates, contact info */
    small: 20,
    /** 9pt — tiny labels */
    tiny: 18,
  },
  spacing: {
    /** 0.75 inch page margins (1080 twips) */
    pageMargin: 1080,
    /** 14pt between major sections */
    sectionGap: 280,
    /** 10pt between job entries */
    jobEntryGap: 200,
    /** 6pt after section header border */
    afterSectionHeader: 120,
    /** 3pt between bullet points */
    bulletGap: 60,
    /** 4pt between body paragraphs */
    paragraphGap: 80,
  },
  lineSpacing: {
    /** 1.15 line spacing for body text (240 = single) */
    body: 276,
    /** Single spacing for bullets */
    bullet: 240,
  },
} as const;

// ---------------------------------------------------------------------------
// Computed layout values
// ---------------------------------------------------------------------------

/** Printable width in twips at current margins (letter = 12240 twips wide) */
const PRINTABLE_WIDTH = 12240 - BRAND.spacing.pageMargin * 2;

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

/**
 * Candidate name header — 20pt bold, left-aligned.
 */
export function brandedNameHeader(name: string): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.LEFT,
    spacing: { after: 0 },
    children: [
      new TextRun({
        text: name,
        bold: true,
        size: BRAND.sizes.name,
        font: BRAND.fonts.primary,
        color: BRAND.colors.foreground,
      }),
    ],
  });
}

/**
 * Target title line — 12pt regular, left-aligned, directly under name.
 * Shows the role being pursued, not current role.
 */
export function brandedTargetTitle(title: string): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.LEFT,
    spacing: { after: BRAND.spacing.bulletGap },
    children: [
      new TextRun({
        text: title,
        size: BRAND.sizes.sectionHeader,
        font: BRAND.fonts.primary,
        color: BRAND.colors.foreground,
      }),
    ],
  });
}

/**
 * Contact info line — items joined by " | " separators.
 * 10pt muted, left-aligned.
 */
export function brandedContactLine(items: string[]): Paragraph {
  const runs: TextRun[] = [];
  for (let i = 0; i < items.length; i++) {
    if (i > 0) {
      runs.push(
        new TextRun({
          text: "  |  ",
          size: BRAND.sizes.small,
          font: BRAND.fonts.primary,
          color: BRAND.colors.separator,
        }),
      );
    }
    runs.push(
      new TextRun({
        text: items[i],
        size: BRAND.sizes.small,
        font: BRAND.fonts.primary,
        color: BRAND.colors.muted,
      }),
    );
  }
  return new Paragraph({
    alignment: AlignmentType.LEFT,
    spacing: { after: BRAND.spacing.sectionGap },
    children: runs,
  });
}

/**
 * Section header — 12pt bold, ALL CAPS, accent color.
 * Bottom border in separator color (light gray), not accent.
 */
export function brandedSectionHeader(text: string): Paragraph {
  return new Paragraph({
    spacing: {
      before: BRAND.spacing.sectionGap,
      after: BRAND.spacing.afterSectionHeader,
    },
    border: {
      bottom: {
        color: BRAND.colors.separator,
        space: 4,
        style: BorderStyle.SINGLE,
        size: 4,
      },
    },
    children: [
      new TextRun({
        text: text.toUpperCase(),
        bold: true,
        size: BRAND.sizes.sectionHeader,
        font: BRAND.fonts.primary,
        color: BRAND.colors.accent,
      }),
    ],
  });
}

/**
 * Separator line — thin border paragraph in separator color.
 */
export function brandedSeparator(): Paragraph {
  return new Paragraph({
    spacing: {
      before: BRAND.spacing.afterSectionHeader,
      after: BRAND.spacing.afterSectionHeader,
    },
    border: {
      bottom: {
        color: BRAND.colors.separator,
        space: 1,
        style: BorderStyle.SINGLE,
        size: 4,
      },
    },
    children: [],
  });
}

/**
 * Body text paragraph — 11pt, foreground, 1.15 line spacing.
 */
export function brandedBody(
  text: string,
  options?: { bold?: boolean; italic?: boolean; color?: string },
): Paragraph {
  return new Paragraph({
    spacing: {
      after: BRAND.spacing.paragraphGap,
      line: BRAND.lineSpacing.body,
    },
    children: [
      new TextRun({
        text,
        bold: options?.bold,
        italics: options?.italic,
        size: BRAND.sizes.body,
        font: BRAND.fonts.primary,
        color: options?.color ?? BRAND.colors.foreground,
      }),
    ],
  });
}

/**
 * Bullet point paragraph — 11pt body text, single line spacing.
 */
export function brandedBullet(text: string): Paragraph {
  return new Paragraph({
    bullet: { level: 0 },
    spacing: {
      after: BRAND.spacing.bulletGap,
      line: BRAND.lineSpacing.bullet,
    },
    children: [
      new TextRun({
        text,
        size: BRAND.sizes.body,
        font: BRAND.fonts.primary,
        color: BRAND.colors.foreground,
      }),
    ],
  });
}

/**
 * Experience entry header — company bold, " — " separator, role title.
 * Date right-aligned via tab stop. keepNext prevents page break before bullets.
 */
export function brandedExperienceHeader(
  company: string,
  title: string,
  duration: string,
): Paragraph {
  return new Paragraph({
    keepNext: true,
    spacing: {
      before: BRAND.spacing.jobEntryGap,
      after: BRAND.spacing.bulletGap,
    },
    tabStops: [
      {
        type: TabStopType.RIGHT,
        position: TabStopPosition.MAX,
      },
    ],
    children: [
      new TextRun({
        text: company,
        bold: true,
        size: BRAND.sizes.body,
        font: BRAND.fonts.primary,
        color: BRAND.colors.foreground,
      }),
      new TextRun({
        text: ` — ${title}`,
        size: BRAND.sizes.body,
        font: BRAND.fonts.primary,
        color: BRAND.colors.foreground,
      }),
      new TextRun({
        text: "\t",
        size: BRAND.sizes.small,
        font: BRAND.fonts.primary,
      }),
      new TextRun({
        text: duration,
        size: BRAND.sizes.small,
        font: BRAND.fonts.primary,
        color: BRAND.colors.muted,
      }),
    ],
  });
}

/**
 * Skills row — renders up to 3 skills as a bulleted, tab-separated line at 10pt.
 * Fixed 3-column layout (tab stops at 1/3 and 2/3 of printable width) so
 * variable-length phrases get a full column of space instead of squashing.
 */
const SKILLS_MAX_COLS = 3;

export function brandedSkillsRow(skills: string[]): Paragraph {
  const items = skills.slice(0, SKILLS_MAX_COLS);
  const runs: TextRun[] = [];
  for (let i = 0; i < items.length; i++) {
    if (i > 0) {
      runs.push(
        new TextRun({
          text: "\t",
          size: BRAND.sizes.small,
          font: BRAND.fonts.primary,
        }),
      );
    }
    runs.push(
      new TextRun({
        text: `• ${items[i]}`,
        size: BRAND.sizes.small,
        font: BRAND.fonts.primary,
        color: BRAND.colors.foreground,
      }),
    );
  }

  // Fixed tab stops at column boundaries (1/3 and 2/3 of printable width)
  const tabStops = Array.from({ length: SKILLS_MAX_COLS - 1 }, (_, i) => ({
    type: TabStopType.LEFT,
    position: Math.round((PRINTABLE_WIDTH / SKILLS_MAX_COLS) * (i + 1)),
  }));

  return new Paragraph({
    spacing: { after: BRAND.spacing.paragraphGap },
    tabStops,
    children: runs,
  });
}

/**
 * Default document configuration — margins, default font, base styles.
 * Spread into the `Document` constructor options.
 */
export function brandedDocumentDefaults() {
  return {
    defaultTextRunProperties: {
      font: BRAND.fonts.primary,
      size: BRAND.sizes.body,
      color: BRAND.colors.foreground,
    },
    styles: {
      default: {
        document: {
          run: {
            font: BRAND.fonts.primary,
            size: BRAND.sizes.body,
            color: BRAND.colors.foreground,
          },
          paragraph: {
            spacing: {
              after: BRAND.spacing.paragraphGap,
              line: BRAND.lineSpacing.body,
            },
          },
        },
      },
    },
    sections: [] as ISectionOptions[],
  };
}

/**
 * Standard section properties — page margins for letter size.
 */
export function brandedSectionProperties() {
  return {
    page: {
      margin: {
        top: BRAND.spacing.pageMargin,
        bottom: BRAND.spacing.pageMargin,
        left: BRAND.spacing.pageMargin,
        right: BRAND.spacing.pageMargin,
      },
    },
  };
}
