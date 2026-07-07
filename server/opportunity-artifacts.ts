/**
 * Opportunity Artifact Provisioner
 *
 * Server-owned slot provisioning for opportunity artifacts (research,
 * cover letter, resume). The endpoint resolves/creates the Library
 * hierarchy and upserts the slot row BEFORE spawning the generating
 * skill, so the skill receives an exact libraryPageId to write into.
 * Regeneration is therefore idempotent on page identity: same slot,
 * same page, fresh content (replace-in-place).
 *
 * Library hierarchy:
 *   Opportunities (root, slug "opportunities")
 *     └── {Company}
 *           ├── Research — {Company}        (kind: research, per-company)
 *           ├── Cover Letter — {Opp Title}  (kind: cover_letter, per-opportunity)
 *           └── Resume — {Opp Title}        (kind: resume, per-opportunity)
 */
import { db, acquireLibraryParentLocks } from "./db";
import { eq, and } from "drizzle-orm";
import { libraryPages, type ArtifactKind, type OpportunityRow } from "@shared/schema";
import { opportunityStorage } from "./opportunity-storage";
import { createLogger } from "./log";

const log = createLogger("OpportunityArtifacts");

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "page";
}

async function createPage(title: string, parentId: string | null, placeholder: string): Promise<{ id: string; slug: string }> {
  const { syncContentFields } = await import("@shared/markdown-tiptap");
  const synced = syncContentFields({ markdown: placeholder });
  const page = await db.transaction(async (tx) => {
    await acquireLibraryParentLocks(tx, [parentId]);
    const [row] = await tx.insert(libraryPages).values({
      title,
      slug: slugify(title),
      content: synced.content,
      plainTextContent: synced.plainTextContent,
      parentId,
      tags: ["opportunity-artifact"],
    }).returning();
    return row;
  });
  log.log(`created page "${title}" id=${page.id} parent=${parentId ?? "root"}`);
  return { id: page.id, slug: page.slug };
}

/** Find a page by exact title under a given parent. */
async function findChildByTitle(parentId: string, title: string): Promise<{ id: string } | undefined> {
  const [row] = await db.select({ id: libraryPages.id })
    .from(libraryPages)
    .where(and(eq(libraryPages.parentId, parentId), eq(libraryPages.title, title)));
  return row;
}

/** Resolve the Opportunities root through the canonical Library index. */
async function ensureOpportunitiesRoot(): Promise<string> {
  const { resolveLibraryParent } = await import("./library-index");
  return resolveLibraryParent("opportunities");
}

export function artifactPageTitle(kind: ArtifactKind, opportunity: OpportunityRow, company: string): string {
  switch (kind) {
    case "research": return `Research — ${company}`;
    case "cover_letter": return `Cover Letter — ${opportunity.title}`;
    case "resume": return `Resume — ${opportunity.title}`;
  }
}

export interface ArtifactSlot {
  libraryPageId: string;
  companyPageId: string;
  pageTitle: string;
}

/**
 * Resolve/create the full Library hierarchy for an artifact and upsert
 * the slot row. Returns the exact page the skill must write into.
 *
 * Research is per-company: if another opportunity at the same company
 * already provisioned a research page, that page is reused (shared).
 */
export async function ensureArtifactSlot(
  opportunity: OpportunityRow,
  kind: ArtifactKind,
  sessionId?: string | null,
): Promise<ArtifactSlot> {
  const company = (opportunity.company || opportunity.title).trim();
  const rootId = await ensureOpportunitiesRoot();

  const companyPage = await findChildByTitle(rootId, company)
    ?? await createPage(company, rootId, `Artifacts for opportunities at ${company}.`);
  const companyPageId = companyPage.id;

  const pageTitle = artifactPageTitle(kind, opportunity, company);

  // Reuse the existing slot's page when present (replace-in-place).
  const existing = await opportunityStorage.getArtifact(opportunity.id, kind);
  let libraryPageId = existing?.libraryPageId;

  if (libraryPageId) {
    // Verify the page still exists; if it was deleted, reprovision.
    const [page] = await db.select({ id: libraryPages.id }).from(libraryPages).where(eq(libraryPages.id, libraryPageId));
    if (!page) libraryPageId = undefined;
  }

  if (!libraryPageId) {
    // Research pages are shared per-company: check for a sibling page
    // with the same title before creating a new one.
    const sibling = await findChildByTitle(companyPageId, pageTitle);
    libraryPageId = sibling?.id
      ?? (await createPage(pageTitle, companyPageId, "_Generation in progress…_")).id;
  }

  await opportunityStorage.upsertArtifact(opportunity.id, kind, { libraryPageId, sessionId });
  return { libraryPageId, companyPageId, pageTitle };
}

/** Map artifact kind to the builtin skill that generates it. */
export const ARTIFACT_SKILLS: Record<ArtifactKind, string> = {
  research: "research",
  cover_letter: "cover-letter",
  resume: "resume",
};

export interface GenerateOptions {
  focus?: string;        // research: optional focus areas
  tone?: string;         // cover letter: Formal | Direct | Warm
  length?: string;       // cover letter: Half | Full
  emphasis?: string;     // cover letter + resume: what to emphasize
}

/**
 * Build the preContext handed to the generating skill. Contains the
 * exact target page, the opportunity snapshot, and user options. The
 * skill MUST write to libraryPageId via update_library_page — never
 * create a new page.
 */
export function buildPreContext(
  opportunity: OpportunityRow,
  kind: ArtifactKind,
  slot: ArtifactSlot,
  options: GenerateOptions = {},
): string {
  const company = (opportunity.company || opportunity.title).trim();
  const lines: string[] = [
    `## Artifact Generation Work Order`,
    ``,
    `**Artifact kind:** ${kind}`,
    `**Opportunity:** [${opportunity.id}] ${opportunity.title}${opportunity.company ? ` @ ${opportunity.company}` : ""}`,
    `**Type:** ${opportunity.type} | **Status:** ${opportunity.status}${opportunity.location ? ` | **Location:** ${opportunity.location}` : ""}`,
    ``,
    `**TARGET LIBRARY PAGE (write here, replace-in-place):**`,
    `- libraryPageId: ${slot.libraryPageId}`,
    `- title: ${slot.pageTitle}`,
    `- Use library(action: "update_library_page", id: "${slot.libraryPageId}", plainTextContent: ...) to write the final artifact.`,
    `- NEVER create a new Library page. The slot page already exists.`,
    ``,
    `**Company:** ${company}`,
  ];
  if (opportunity.jobUrl) lines.push(`**Job URL:** ${opportunity.jobUrl}`);
  if (options.focus) lines.push(`**Focus areas (user-specified):** ${options.focus}`);
  if (options.tone) lines.push(`**Tone:** ${options.tone}`);
  if (options.length) lines.push(`**Length:** ${options.length}`);
  if (options.emphasis) lines.push(`**Emphasis:** ${options.emphasis}`);
  if (opportunity.description) {
    lines.push(``, `**Opportunity description:**`, opportunity.description);
  }
  if (opportunity.jdText && kind !== "research") {
    lines.push(``, `**Job description (full text):**`, "```", opportunity.jdText, "```");
  } else if (opportunity.jdText && kind === "research") {
    lines.push(``, `**Job description (context for research focus):**`, "```", opportunity.jdText.slice(0, 4000), "```");
  }
  lines.push(``, `**Opportunity ID for exec tool calls:** ${opportunity.id}`);
  return lines.join("\n");
}
