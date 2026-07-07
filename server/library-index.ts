import { getSetting, setSetting } from "./system-settings";
import { createLogger } from "./log";

const log = createLogger("LibraryIndex");

export interface LibraryIndexEntry {
  pageId: string | null;
  title: string;
  namingConvention: string;
  tags: string[];
  description: string;
}

export interface LibraryParentResolutionInput {
  purpose?: string | null;
  pageContext?: string | null;
  title?: string | null;
  contentSummary?: string | null;
  tags?: string[] | null;
}

export interface LibraryParentResolution {
  filingKey: string;
  parentId: string;
  parentTitle: string;
  namingConvention: string;
  tags: string[];
  description: string;
}

export type LibraryIndex = Record<string, LibraryIndexEntry>;

const SETTING_KEY = "system.library-index";

const PURPOSE_ALIASES: Record<string, string> = {
  journal: "journals",
  journals: "journals",
  "daily-journal": "journals",
  "daily brief": "daily-briefs",
  dailybrief: "daily-briefs",
  brief: "daily-briefs",
  "daily review": "daily-reviews",
  "daily-review": "daily-reviews",
  "evening review": "daily-reviews",
  spec: "specs",
  "implementation-plan": "specs",
  specs: "specs",
  specification: "specs",
  plan: "plans",
  plans: "plans",
  "execution-plan": "plans",
  "multi-step-plan": "plans",
  workflow: "workflows",
  workflows: "workflows",
  "workflow-checkpoint": "workflows",
  "weekly plan": "weekly-plans",
  "financial review": "financial-reviews",
  "financial-review": "financial-reviews",
  finance: "financial-reviews",
  meeting: "meeting-notes",
  "meeting notes": "meeting-notes",
  "meeting-note": "meeting-notes",
  "weekly reflection": "weekly-reflections",
  "weekly-reflection": "weekly-reflections",
  "weekly review": "weekly-reflections",
  "monthly reflection": "monthly-reflections",
  "monthly-reflection": "monthly-reflections",
  "monthly review": "monthly-reflections",
  "quarterly reflection": "quarterly-reflections",
  "quarterly-reflection": "quarterly-reflections",
  "quarterly review": "quarterly-reflections",
  "annual reflection": "annual-reflections",
  "annual-reflection": "annual-reflections",
  "annual review": "annual-reflections",
  note: "notes",
  notes: "notes",
  article: "thought-leadership",
  post: "thought-leadership",
  "thought leadership": "thought-leadership",
  opportunity: "opportunities",
  opportunities: "opportunities",
  "opportunity-artifact": "opportunities",
};

function normalize(value: string): string {
  return value.toLowerCase().trim().replace(/[_\s]+/g, "-").replace(/^-|-$/g, "");
}

function words(value: string | null | undefined): Set<string> {
  return new Set((value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean));
}

function scoreEntry(key: string, entry: LibraryIndexEntry, input: LibraryParentResolutionInput): number {
  const purpose = (input.purpose || "").toLowerCase().trim();
  const normalizedPurpose = normalize(purpose);
  if (normalizedPurpose === key || PURPOSE_ALIASES[purpose] === key || PURPOSE_ALIASES[normalizedPurpose] === key) return 100;

  let score = 0;
  const textWords = words(`${input.title || ""} ${input.contentSummary || ""} ${input.pageContext || ""}`);
  const tags = new Set((input.tags || []).map(t => normalize(t)));

  for (const tag of entry.tags) {
    const normalizedTag = normalize(tag);
    if (tags.has(normalizedTag)) score += 25;
    for (const part of normalizedTag.split("-")) {
      if (textWords.has(part)) score += 6;
    }
  }
  for (const part of key.split("-")) {
    if (textWords.has(part)) score += 8;
  }
  for (const part of words(`${entry.title} ${entry.description}`)) {
    if (textWords.has(part)) score += 2;
  }
  return score;
}

const DEFAULT_INDEX: LibraryIndex = {
  "journals": {
    pageId: "2f448d63-ea31-4919-92e3-a45619968107",
    title: "Journal",
    namingConvention: "{YYYY-MM-DD}",
    tags: ["journal", "daily"],
    description: "Daily journal entries written by parameterized Reflect",
  },
  "daily-briefs": {
    pageId: "3f328f0a-d39d-4161-aff1-e9217c8bc10d",
    title: "Daily Briefs",
    namingConvention: "Daily Brief — {DayOfWeek}, {MonthName} {Day}, {Year}",
    tags: ["daily-brief"],
    description: "Morning briefings assembled by brief-daily skill",
  },
  "daily-reviews": {
    pageId: "59ce5eec-adf9-4ae1-aaef-f0ec6e5a5aca",
    title: "Daily Reviews",
    namingConvention: "Evening Review — {YYYY-MM-DD}",
    tags: ["daily-review", "evening"],
    description: "Evening reviews written by review-daily skill",
  },
  "specs": {
    pageId: "ca12b31d-6a57-4977-a001-65c1924c74bd",
    title: "Specs",
    namingConvention: "{Title}",
    tags: ["spec", "implementation-plan"],
    description: "Architecture and implementation specs",
  },
  "financial-reviews": {
    pageId: "768dc6d0-c3a3-4962-bc23-f8e14e773422",
    title: "Finance",
    namingConvention: "{Period} Financial Review — {DateRange}",
    tags: ["financial-review"],
    description: "Periodic financial reviews",
  },
  "plans": {
    pageId: null,
    title: "Plans",
    namingConvention: "Plan: {Title}",
    tags: ["plan", "execution-plan"],
    description: "Durable multi-step execution plans and checkpoints",
  },
  "workflows": {
    pageId: null,
    title: "Workflows",
    namingConvention: "Workflow: {Title}",
    tags: ["workflow", "checkpoint"],
    description: "Workflow run checkpoint pages and lifecycle artifacts",
  },
  "weekly-plans": {
    pageId: null,
    title: "Weekly Plans",
    namingConvention: "Weekly Plan — {YYYY-MM-DD}",
    tags: ["weekly-plan"],
    description: "Weekly planning outputs from parameterized Plan",
  },
  "thought-leadership": {
    pageId: "3d757f54-16fa-49ff-b927-26a53ad125cf",
    title: "Thought Leadership",
    namingConvention: "{Title}",
    tags: ["thought-leadership"],
    description: "Social posts, articles, and content drafts",
  },
  "opportunities": {
    pageId: null,
    title: "Opportunities",
    namingConvention: "{Company} / {Artifact}",
    tags: ["opportunity-artifact"],
    description: "Opportunity research, resumes, cover letters, and company artifact folders",
  },
  "meeting-notes": {
    pageId: "619070a3-24fd-4561-9d09-2d62803c1460",
    title: "Meetings",
    namingConvention: "{PersonOrGroup} — {Topic}",
    tags: ["meeting-notes"],
    description: "Meeting notes and follow-ups",
  },
  "weekly-reflections": {
    pageId: null,
    title: "Weekly Reflections",
    namingConvention: "Weekly Planning — {YYYY}-W{XX}",
    tags: ["weekly-reflection", "planning"],
    description: "Weekly planning and reflection outputs from parameterized Plan and Reflect",
  },
  "monthly-reflections": {
    pageId: null,
    title: "Monthly Reflections",
    namingConvention: "Monthly Planning — {MonthName} {Year}",
    tags: ["monthly-reflection", "planning"],
    description: "Monthly planning and reflection outputs from parameterized Plan and Reflect",
  },
  "quarterly-reflections": {
    pageId: null,
    title: "Quarterly Reflections",
    namingConvention: "Quarterly Reflection — Q{Q} {Year}",
    tags: ["quarterly-reflection", "planning"],
    description: "Quarterly reflection outputs from parameterized Reflect — synthesis across the prior 3 monthly reflections",
  },
  "annual-reflections": {
    pageId: null,
    title: "Annual Reflections",
    namingConvention: "Annual Reflection — {Year}",
    tags: ["annual-reflection", "identity"],
    description: "Annual identity-level reflection outputs from parameterized Reflect — Voice, principles, self-model, and lifetime arc",
  },
  "notes": {
    pageId: null,
    title: "Notes",
    namingConvention: "{Title}",
    tags: ["system-folder"],
    description: "Quick-capture notes — system folder, always pinned at top of Library tree",
  },
};

export async function getLibraryIndex(): Promise<LibraryIndex> {
  const index = await getSetting<LibraryIndex>(SETTING_KEY);
  if (!index) {
    await seedLibraryIndex();
    return DEFAULT_INDEX;
  }
  // Backfill any new default entries that landed in code after the index was
  // first persisted (e.g. quarterly-reflections, annual-reflections). Without
  // this, resolveLibraryParent would throw "Unknown artifact type" on new
  // entries until the persisted setting is wiped.
  let mutated = false;
  for (const [type, entry] of Object.entries(DEFAULT_INDEX)) {
    if (!index[type]) {
      index[type] = entry;
      mutated = true;
      log.log(`Backfilled missing library index entry for type "${type}"`);
    }
  }
  if (mutated) {
    await setSetting(SETTING_KEY, index);
  }
  return index;
}

export async function resolveLibraryParent(type: string): Promise<string> {
  const { db: database } = await import("./db");
  const { libraryPages } = await import("@shared/models/info");
  const { eq } = await import("drizzle-orm");

  const index = await getLibraryIndex();
  const entry = index[type];
  if (!entry) {
    throw new Error(`[LibraryIndex] Unknown artifact type: "${type}". Add it to system.library-index before use.`);
  }

  if (entry.pageId) {
    const [existing] = await database.select({ id: libraryPages.id }).from(libraryPages).where(eq(libraryPages.id, entry.pageId));
    if (existing) return entry.pageId;
    log.log(`Page ${entry.pageId} for type "${type}" not found in database, will auto-create`);
  }

  const slug = type;
  const [created] = await database.insert(libraryPages).values({
    title: entry.title,
    slug,
    content: { type: "doc", content: [] },
    plainTextContent: "",
    tags: ["folder", ...entry.tags],
  }).returning();

  log.log(`Auto-created parent page for type "${type}": id=${created.id} title="${entry.title}"`);

  await updateLibraryIndexEntry(type, { pageId: created.id });
  return created.id;
}

export async function resolveLibraryParentFromContext(input: LibraryParentResolutionInput): Promise<LibraryParentResolution> {
  const index = await getLibraryIndex();
  const explicitKey = input.purpose ? normalize(input.purpose) : "";
  const aliasKey = input.purpose ? (PURPOSE_ALIASES[input.purpose.toLowerCase().trim()] || PURPOSE_ALIASES[explicitKey]) : undefined;
  const filingKey = index[explicitKey] ? explicitKey : aliasKey;

  if (filingKey && index[filingKey]) {
    const entry = index[filingKey];
    const parentId = await resolveLibraryParent(filingKey);
    return { filingKey, parentId, parentTitle: entry.title, namingConvention: entry.namingConvention, tags: entry.tags, description: entry.description };
  }

  const scored = Object.entries(index)
    .map(([key, entry]) => ({ key, entry, score: scoreEntry(key, entry, input) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const second = scored[1];
  if (!best || best.score < 20 || (second && best.score - second.score < 10)) {
    const options = Object.entries(index).map(([key, entry]) => `${key} (${entry.title})`).join(", ");
    throw new Error(`[LibraryIndex] Could not confidently resolve parent for title="${input.title || ""}" purpose="${input.purpose || ""}". Provide a clearer purpose. Known filing keys: ${options}`);
  }

  const parentId = await resolveLibraryParent(best.key);
  return {
    filingKey: best.key,
    parentId,
    parentTitle: best.entry.title,
    namingConvention: best.entry.namingConvention,
    tags: best.entry.tags,
    description: best.entry.description,
  };
}

export async function updateLibraryIndexEntry(type: string, updates: Partial<LibraryIndexEntry>): Promise<void> {
  const index = await getLibraryIndex();
  const entry = index[type];
  if (!entry) {
    throw new Error(`[LibraryIndex] Cannot update unknown type: "${type}"`);
  }
  index[type] = { ...entry, ...updates };
  await setSetting(SETTING_KEY, index);
  log.log(`Updated index entry for type "${type}": ${JSON.stringify(updates)}`);
}

export async function seedLibraryIndex(): Promise<void> {
  const existing = await getSetting<LibraryIndex>(SETTING_KEY);
  if (existing) return;
  await setSetting(SETTING_KEY, DEFAULT_INDEX);
  log.log("Seeded library index with default entries");
}
