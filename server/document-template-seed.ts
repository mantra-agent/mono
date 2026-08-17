import { and, eq } from "drizzle-orm";
import {
  DAY_ONE_DOCUMENT_TEMPLATE_IDS,
  documentTemplates,
  skillTemplateBindings,
} from "@shared/models/document-templates";
import { libraryPages } from "@shared/models/info";
import { skills } from "@shared/models/skills";
import { syncContentFields } from "@shared/markdown-tiptap";
import { db } from "./db";
import { createLogger } from "./log";

const log = createLogger("DocumentTemplateSeed");

/** Stable Library page ids for day-one shape pages (insert-only). */
export const SHAPE_PAGE_IDS = {
  spec: "template-shape-spec",
  "daily-digest": "template-shape-daily-digest",
  "weekly-summary": "template-shape-weekly-summary",
} as const;

const SPEC_SHAPE_MARKDOWN = `# Spec shape

Heading outline for Spec Produce. Fill a *different* artifact page against this vessel.

## Failed invariant (inspected)

Name the broken or missing invariant with inspected evidence.

## The cut

The smallest coherent repair. One sentence if possible.

## Outcome

Done when these concrete conditions hold.

## Non-goals

What this deliberately does not do.

## Architecture

Structure, ownership, seams, and why alternatives lose.

## Verification path

How a reviewer proves the cut holds.

## Terminal state

What shipped looks like.

## Governing standards

Named standards this spec must satisfy.
`;

const DAILY_DIGEST_SHAPE_MARKDOWN = `# Daily Digest shape

Closed taxonomy from Structured Daily Digest. Claim-review behavior is owned elsewhere.

## YYYY-MM-DD

unlabeled lead — factual opener before the first ### heading.

### Moved

What completed or advanced.

### Open

omit if empty

### Learning

One line; omit if empty only when none.

### Memory

Always. Rows or \`None\`.
`;

const WEEKLY_SUMMARY_SHAPE_MARKDOWN = `# Weekly Summary shape

Lifted from live reflect weekly.

## Summary

Week in 2-3 factual sentences.

## Plan vs Reality

What the plan committed to vs what happened.

## Wins

Work, family, personal, or capability wins.

## Drift and Friction

What slipped, overloaded, or stayed unresolved.

## Patterns

What repeated across days.

## Carry Forward

1-5 concrete items for the next planning cycle.
`;

const SHAPE_SEEDS: Array<{
  templateId: (typeof DAY_ONE_DOCUMENT_TEMPLATE_IDS)[number];
  name: string;
  pageId: string;
  title: string;
  markdown: string;
  tags: string[];
}> = [
  {
    templateId: "spec",
    name: "Spec",
    pageId: SHAPE_PAGE_IDS.spec,
    title: "Template Shape — Spec",
    markdown: SPEC_SHAPE_MARKDOWN,
    tags: ["template-shape", "spec", "system"],
  },
  {
    templateId: "daily-digest",
    name: "Daily Digest",
    pageId: SHAPE_PAGE_IDS["daily-digest"],
    title: "Template Shape — Daily Digest",
    markdown: DAILY_DIGEST_SHAPE_MARKDOWN,
    tags: ["template-shape", "daily-digest", "system"],
  },
  {
    templateId: "weekly-summary",
    name: "Weekly Summary",
    pageId: SHAPE_PAGE_IDS["weekly-summary"],
    title: "Template Shape — Weekly Summary",
    markdown: WEEKLY_SUMMARY_SHAPE_MARKDOWN,
    tags: ["template-shape", "weekly-summary", "system"],
  },
];

const DAY_ONE_BINDS: Array<{ skillName: string; key: "spec" | "daily" | "weekly"; templateId: string }> = [
  { skillName: "feature-pipeline", key: "spec", templateId: "spec" },
  { skillName: "reflect", key: "daily", templateId: "daily-digest" },
  { skillName: "reflect", key: "weekly", templateId: "weekly-summary" },
];

async function ensureShapePage(seed: (typeof SHAPE_SEEDS)[number]): Promise<void> {
  const existing = await db.select({ id: libraryPages.id }).from(libraryPages).where(eq(libraryPages.id, seed.pageId)).limit(1);
  if (existing.length > 0) return;

  const bySlug = await db.select({ id: libraryPages.id }).from(libraryPages).where(eq(libraryPages.slug, seed.pageId)).limit(1);
  if (bySlug.length > 0) return;

  const synced = syncContentFields({ markdown: seed.markdown });
  await db.insert(libraryPages).values({
    id: seed.pageId,
    title: seed.title,
    slug: seed.pageId,
    content: synced.content,
    plainTextContent: synced.plainTextContent,
    tags: seed.tags,
    status: "active",
    scope: "global",
    sortOrder: 0,
  });
  log.info("seeded shape page", { pageId: seed.pageId });
}

async function ensureGlobalTemplate(seed: (typeof SHAPE_SEEDS)[number]): Promise<void> {
  const [existing] = await db
    .select({ id: documentTemplates.id })
    .from(documentTemplates)
    .where(and(eq(documentTemplates.id, seed.templateId), eq(documentTemplates.scope, "global")))
    .limit(1);
  if (existing) return;

  await db.insert(documentTemplates).values({
    id: seed.templateId,
    name: seed.name,
    pageId: seed.pageId,
    status: "active",
    scope: "global",
    ownerUserId: null,
    accountId: null,
    createdByUserId: null,
  });
  log.info("seeded global template", { templateId: seed.templateId });
}

async function ensureSkillBinding(bind: (typeof DAY_ONE_BINDS)[number]): Promise<void> {
  const [skill] = await db
    .select({ id: skills.id })
    .from(skills)
    .where(and(eq(skills.name, bind.skillName), eq(skills.scope, "global")))
    .limit(1);
  if (!skill) {
    log.warn("skill missing for template bind; will retry next boot", { skillName: bind.skillName });
    return;
  }

  const [existing] = await db
    .select({ id: skillTemplateBindings.id })
    .from(skillTemplateBindings)
    .where(and(eq(skillTemplateBindings.skillId, skill.id), eq(skillTemplateBindings.key, bind.key)))
    .limit(1);
  if (existing) return;

  await db.insert(skillTemplateBindings).values({
    skillId: skill.id,
    key: bind.key,
    templateId: bind.templateId,
  });
  log.info("seeded skill template binding", { skillName: bind.skillName, key: bind.key, templateId: bind.templateId });
}

/** Insert-only day-one shape pages, global map rows, and skill binds. Never overwrites account overlays. */
export async function ensureDocumentTemplateSeeds(): Promise<void> {
  for (const seed of SHAPE_SEEDS) {
    await ensureShapePage(seed);
    await ensureGlobalTemplate(seed);
  }
  for (const bind of DAY_ONE_BINDS) {
    await ensureSkillBinding(bind);
  }
}
