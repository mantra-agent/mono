import { and, eq } from "drizzle-orm";
import { syncContentFields } from "@shared/markdown-tiptap";
import {
  DAY_ONE_DOCUMENT_TEMPLATE_IDS,
  documentTemplates,
  skillTemplateBindings,
} from "@shared/models/document-templates";
import { libraryPageTrash, libraryPages } from "@shared/models/info";
import { skills } from "@shared/models/skills";
import { db } from "./db";
import { createLogger } from "./log";

const log = createLogger("DocumentTemplateSeed");

/** Stable Library page ids for day-one shape pages. */
export const SHAPE_PAGE_IDS = {
  spec: "template-shape-spec",
  "daily-digest": "template-shape-daily-digest",
  "weekly-summary": "template-shape-weekly-summary",
  "daily-brief": "template-shape-daily-brief",
  "stand-up": "template-shape-stand-up",
} as const;

const SPEC_SHAPE_MARKDOWN = `# Spec shape

This page is the shape, not the spec. Fill a different page. Every section: as simple as possible. No filler.

## Problem

One sentence, people-first: who is stuck, and what is broken. Then the inspected evidence — not a slogan.

## Solution

Done when these concrete conditions hold. Not a restatement of Scope.

## Scope

The cut — the smallest coherent change.

## Out-of-scope

What this deliberately does not do.

## External

What the outside world touches: end consumers, or external systems. What they see or receive.

## Internal

Architecture — objects, who owns them, and the seams between them. Name where this breaks first. Do not catalog discarded options.

## Acceptance Criteria

How we'll know we're done. Three short beats:

- Picture — what shipped looks like
- Check — how a reviewer proves it
- Bars — the named standards it must satisfy
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

Work-ledger close. Process stays on the skill.

## Today

Who carried what this week, grouped by Person. None when no live owners.

## Does Not Add Up

Bandwidth across the week. None when it fits.

## Unlocks

What still unlocks next week, ranked by fan-in. None when no unresolved edges.

## Moved

What actually completed or advanced this week.

omit if empty

## Still Blocked

What stayed blocked.

omit if empty

## Board

Week-close board: active projects, milestones, live tasks.
`;

const STAND_UP_SHAPE_MARKDOWN = `# Stand Up shape

Work-ledger open. Process stays on the skill.

## Today

Who is on what today. Group by Person. None when no live owners.

## Does Not Add Up

Bandwidth, not integrity. None when the day fits.

## Unlocks

Highest-leverage incomplete work, ranked by blocked_by fan-in. None when no unresolved edges.

## Board

Active projects, their milestones, and live tasks. Appendix.
`;

const DAILY_BRIEF_SHAPE_MARKDOWN = `# Daily Brief shape

Closed taxonomy from live brief-daily 7.8. Coach orientation, child skills, and day rotation stay on the skill.

## Weekday, Month D, YYYY

unlabeled lead — bolded affirmation, then unlabeled thesis.

**Weather**

Required. 2–3 practical lines.

**Did You Know?**

Required. Exact learning-skill output.

**Today's Schedule**

omit if empty

**Priority Alignment**

omit if empty

**Wellness**

omit if empty

**Big Picture**

omit if empty

**News**

omit if empty

**Carry-Forward**

omit if empty
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
  {
    templateId: "daily-brief",
    name: "Daily Brief",
    pageId: SHAPE_PAGE_IDS["daily-brief"],
    title: "Template Shape — Daily Brief",
    markdown: DAILY_BRIEF_SHAPE_MARKDOWN,
    tags: ["template-shape", "daily-brief", "system"],
  },
  {
    templateId: "stand-up",
    name: "Stand Up",
    pageId: SHAPE_PAGE_IDS["stand-up"],
    title: "Template Shape — Stand Up",
    markdown: STAND_UP_SHAPE_MARKDOWN,
    tags: ["template-shape", "stand-up", "system"],
  },
];

const DAY_ONE_BINDS: Array<{ skillName: string; key: "spec" | "daily" | "weekly"; templateId: string }> = [
  { skillName: "feature-pipeline", key: "spec", templateId: "spec" },
  { skillName: "reflect", key: "daily", templateId: "daily-digest" },
  { skillName: "brief-daily", key: "daily", templateId: "daily-brief" },
  { skillName: "stand-up", key: "daily", templateId: "stand-up" },
  { skillName: "stand-up", key: "weekly", templateId: "weekly-summary" },
];

function normalizeShapeMarkdown(markdown: string): string {
  return markdown.replace(/\r\n/g, "\n").trim();
}

async function ensureShapePage(seed: (typeof SHAPE_SEEDS)[number]): Promise<void> {
  const synced = syncContentFields({ markdown: seed.markdown });
  const nextPlain = normalizeShapeMarkdown(synced.plainTextContent);
  const [existing] =
    (await db
      .select({
        id: libraryPages.id,
        scope: libraryPages.scope,
        slug: libraryPages.slug,
        status: libraryPages.status,
        plainTextContent: libraryPages.plainTextContent,
        trashPageId: libraryPageTrash.pageId,
      })
      .from(libraryPages)
      .leftJoin(libraryPageTrash, eq(libraryPageTrash.pageId, libraryPages.id))
      .where(eq(libraryPages.id, seed.pageId))
      .limit(1)) ?? [];

  if (!existing) {
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
    return;
  }

  if (existing.trashPageId) {
    await db.delete(libraryPageTrash).where(eq(libraryPageTrash.pageId, existing.id));
    log.info("restored official shape page from trash", { pageId: seed.pageId });
  }

  if (existing.scope !== "global" || existing.slug !== seed.pageId || existing.status !== "active") {
    await db
      .update(libraryPages)
      .set({
        scope: "global",
        slug: seed.pageId,
        status: "active",
        ownerUserId: null,
        accountId: null,
        vaultId: null,
        updatedAt: new Date(),
      })
      .where(eq(libraryPages.id, existing.id));
    log.info("healed official shape page identity", {
      pageId: seed.pageId,
      priorScope: existing.scope,
    });
  }

  // Official Spec, recut Weekly Summary, and recut Stand Up vessels may converge.
  // Daily Digest / Brief stay insert-only for body text. Identity is not optional.
  if (seed.templateId !== "spec" && seed.templateId !== "weekly-summary" && seed.templateId !== "stand-up") return;
  if (normalizeShapeMarkdown(existing.plainTextContent) === nextPlain) return;

  await db
    .update(libraryPages)
    .set({
      title: seed.title,
      content: synced.content,
      plainTextContent: synced.plainTextContent,
      tags: seed.tags,
      status: "active",
      updatedAt: new Date(),
    })
    .where(eq(libraryPages.id, existing.id));
  log.info("converged official shape page", { pageId: existing.id, templateId: seed.templateId });
}

async function ensureGlobalTemplate(seed: (typeof SHAPE_SEEDS)[number]): Promise<void> {
  const [existing] = await db
    .select({ id: documentTemplates.id, pageId: documentTemplates.pageId })
    .from(documentTemplates)
    .where(and(eq(documentTemplates.id, seed.templateId), eq(documentTemplates.scope, "global")))
    .limit(1);
  if (existing) {
    if (existing.pageId !== seed.pageId) {
      await db
        .update(documentTemplates)
        .set({ pageId: seed.pageId, updatedAt: new Date() })
        .where(and(eq(documentTemplates.id, seed.templateId), eq(documentTemplates.scope, "global")));
      log.info("retargeted global template pageId", { templateId: seed.templateId, pageId: seed.pageId });
    }
    return;
  }

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

async function unbindRetiredSkillKey(skillName: string, key: "spec" | "daily" | "weekly"): Promise<void> {
  const [skill] = await db
    .select({ id: skills.id })
    .from(skills)
    .where(and(eq(skills.name, skillName), eq(skills.scope, "global")))
    .limit(1);
  if (!skill) return;

  const deleted = await db
    .delete(skillTemplateBindings)
    .where(and(eq(skillTemplateBindings.skillId, skill.id), eq(skillTemplateBindings.key, key)))
    .returning({ id: skillTemplateBindings.id });
  if (deleted.length > 0) {
    log.info("unbound retired skill template binding", { skillName, key, count: deleted.length });
  }
}

/** Day-one shape pages, global map rows, and skill binds. Identity (live + global + canonical id) heals on every boot. Spec, recut weekly-summary, and recut stand-up may also converge body text. Never overwrites account overlays. */
export async function ensureDocumentTemplateSeeds(): Promise<void> {
  for (const seed of SHAPE_SEEDS) {
    await ensureShapePage(seed);
    await ensureGlobalTemplate(seed);
  }
  await unbindRetiredSkillKey("reflect", "weekly");
  for (const bind of DAY_ONE_BINDS) {
    await ensureSkillBinding(bind);
  }
}
