import { eq, or, sql } from "drizzle-orm";
import { db } from "../db";
import { createLogger } from "../log";
import { resolveLibraryParent } from "../library-index";
import { publishLibraryChanged, slugifyLibraryTitle } from "../library-save";
import { setSetting } from "../system-settings";
import { projects } from "@shared/schema";
import { libraryPages } from "@shared/models/info";
import { syncContentFields } from "@shared/markdown-tiptap";
import type { ProjectNote, ProjectPage } from "@shared/models/work";

const log = createLogger("MigrateProjectNotesSpecToLibrary");
const RUN_KEY = "migration.project-notes-spec-to-library.v1";

type ProjectRow = typeof projects.$inferSelect;
type MigrationKind = "notes" | "spec";

type MigrationStats = {
  projectsMigrated: number;
  pagesCreated: number;
  notesPagesCreated: number;
  specPagesCreated: number;
  projectsScanned: number;
  skippedAlreadyMigrated: number;
};

function normalizeNotes(notes: unknown): ProjectNote[] {
  return Array.isArray(notes) ? notes.filter((note): note is ProjectNote => Boolean(note && typeof note === "object" && typeof (note as ProjectNote).content === "string")) : [];
}

function normalizePages(pages: unknown): ProjectPage[] {
  return Array.isArray(pages) ? pages.filter((page): page is ProjectPage => Boolean(page && typeof page === "object" && typeof (page as ProjectPage).id === "string")) : [];
}

function hasNotesContent(project: ProjectRow): boolean {
  return normalizeNotes(project.notes).some(note => note.content.trim().length > 0);
}

function hasSpecContent(project: ProjectRow): boolean {
  return project.spec.trim().length > 0;
}

function pageTitle(project: ProjectRow, kind: MigrationKind): string {
  return `${project.title} — ${kind === "notes" ? "Notes" : "Spec"}`;
}

function pageSlug(project: ProjectRow, kind: MigrationKind): string {
  return `${slugifyLibraryTitle(pageTitle(project, kind), `project-${project.id}-${kind}`)}-project-${project.id}-${kind}`;
}

function markdownForNotes(project: ProjectRow): string {
  const notes = normalizeNotes(project.notes).filter(note => note.content.trim().length > 0);
  const body = notes.map((note, index) => {
    const created = note.createdAt ? `\nCreated: ${note.createdAt}` : "";
    const updated = note.updatedAt && note.updatedAt !== note.createdAt ? `\nUpdated: ${note.updatedAt}` : "";
    return `## Note ${index + 1}${created}${updated}\n\n${note.content.trim()}`;
  }).join("\n\n---\n\n");
  return `# ${pageTitle(project, "notes")}\n\nMigrated from project notes for @project:${project.id}.\n\n${body}\n`;
}

function markdownForSpec(project: ProjectRow): string {
  return `# ${pageTitle(project, "spec")}\n\nMigrated from project spec for @project:${project.id}.\n\n${project.spec.trim()}\n`;
}

function projectAlreadyLinks(project: ProjectRow, slug: string): boolean {
  return normalizePages(project.pages).some(page => page.slug === slug || page.id === slug);
}

async function existingPage(slug: string): Promise<typeof libraryPages.$inferSelect | undefined> {
  const [page] = await db.select()
    .from(libraryPages)
    .where(eq(libraryPages.slug, slug))
    .limit(1);
  return page;
}

async function createMigrationPage(project: ProjectRow, kind: MigrationKind, parentId: string): Promise<typeof libraryPages.$inferSelect> {
  const title = pageTitle(project, kind);
  const slug = pageSlug(project, kind);
  const existing = await existingPage(slug);
  if (existing) return existing;

  const markdown = kind === "notes" ? markdownForNotes(project) : markdownForSpec(project);
  const synced = syncContentFields({ markdown });
  const [page] = await db.insert(libraryPages).values({
    title,
    slug,
    content: synced.content,
    plainTextContent: synced.plainTextContent,
    parentId,
    tags: ["project", `project:${project.id}`, kind],
    status: "migrated",
    scope: project.scope,
    ownerUserId: project.ownerUserId,
    accountId: project.accountId,
    updatedAt: sql`CURRENT_TIMESTAMP`,
  }).returning();

  try {
    const { upsertLibraryPageMemory } = await import("../routes/library");
    await upsertLibraryPageMemory(page as typeof libraryPages.$inferSelect);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`project library migration memory sync failed projectId=${project.id} kind=${kind} pageId=${page.id} error=${message}`);
  }

  publishLibraryChanged("created", page);
  return page;
}

async function linkPageToProject(project: ProjectRow, page: { id: string; title: string; slug: string }): Promise<boolean> {
  const [freshProject] = await db.select({ pages: projects.pages }).from(projects).where(eq(projects.id, project.id)).limit(1);
  const pages = normalizePages(freshProject?.pages ?? project.pages);
  if (pages.some(existing => existing.id === page.id || existing.slug === page.slug)) return false;
  pages.push({ id: page.id, title: page.title, slug: page.slug, addedAt: new Date().toISOString() });
  await db.update(projects).set({ pages: pages as unknown as Record<string, unknown>, updatedAt: new Date() }).where(eq(projects.id, project.id));
  return true;
}

export async function migrateProjectNotesSpecToLibrary(): Promise<MigrationStats> {
  const stats: MigrationStats = {
    projectsMigrated: 0,
    pagesCreated: 0,
    notesPagesCreated: 0,
    specPagesCreated: 0,
    projectsScanned: 0,
    skippedAlreadyMigrated: 0,
  };

  try {
    const parentId = await resolveLibraryParent("notes");
    const rows = await db.select().from(projects).where(or(sql`jsonb_array_length(${projects.notes}) > 0`, sql`length(trim(${projects.spec})) > 0`));
    stats.projectsScanned = rows.length;

    for (const project of rows) {
      let migratedThisProject = false;
      const kinds: MigrationKind[] = [];
      if (hasNotesContent(project)) kinds.push("notes");
      if (hasSpecContent(project)) kinds.push("spec");

      for (const kind of kinds) {
        const slug = pageSlug(project, kind);
        if (projectAlreadyLinks(project, slug)) {
          stats.skippedAlreadyMigrated += 1;
          continue;
        }
        const existed = await existingPage(slug);
        const page = existed ?? await createMigrationPage(project, kind, parentId);
        const linked = await linkPageToProject(project, page);
        if (linked || !existed) {
          stats.pagesCreated += existed ? 0 : 1;
          if (!existed && kind === "notes") stats.notesPagesCreated += 1;
          if (!existed && kind === "spec") stats.specPagesCreated += 1;
          migratedThisProject = true;
        }
      }

      if (migratedThisProject) stats.projectsMigrated += 1;
    }

    await setSetting(RUN_KEY, { ...stats, completedAt: new Date().toISOString() });
    log.log(`complete projectsMigrated=${stats.projectsMigrated} pagesCreated=${stats.pagesCreated} notesPagesCreated=${stats.notesPagesCreated} specPagesCreated=${stats.specPagesCreated} projectsScanned=${stats.projectsScanned} skippedAlreadyMigrated=${stats.skippedAlreadyMigrated}`);
    return stats;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`failed error=${message}`);
    throw error;
  }
}

