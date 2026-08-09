import { db, pool } from "./db";
import { createLogger } from "./log";
import { infoNotes, libraryPages } from "@shared/models/info";
import { eq, and, sql } from "drizzle-orm";

const log = createLogger("LibrarySchema");

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "page";
}

/**
 * Compatibility convergence for Library schema and legacy Notes adoption.
 * Boot schema convergence is the only caller; route registration must remain DDL-free.
 */
export async function convergeLibraryCompatibilitySchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS library_page_views (
      page_id TEXT PRIMARY KEY REFERENCES library_pages(id) ON DELETE CASCADE,
      last_viewed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`ALTER TABLE library_pages ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE library_pages ADD COLUMN IF NOT EXISTS one_liner TEXT`);
  await pool.query(`ALTER TABLE library_pages ADD COLUMN IF NOT EXISTS summary TEXT`);
  await pool.query(`ALTER TABLE library_pages ADD COLUMN IF NOT EXISTS structural_role TEXT NOT NULL DEFAULT 'artifact'`);
  await pool.query(`ALTER TABLE library_pages DROP CONSTRAINT IF EXISTS chk_library_pages_structural_role`);
  await pool.query(`ALTER TABLE library_pages ADD CONSTRAINT chk_library_pages_structural_role CHECK (structural_role IN ('source', 'artifact', 'wiki', 'meta'))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_library_pages_structural_role ON library_pages(structural_role)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS library_page_pins (
      page_id TEXT PRIMARY KEY REFERENCES library_pages(id) ON DELETE CASCADE,
      pinned_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_library_page_pins_pinned_at ON library_page_pins(pinned_at)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS library_page_trash (
      page_id TEXT PRIMARY KEY REFERENCES library_pages(id) ON DELETE CASCADE,
      deleted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_library_page_trash_deleted_at ON library_page_trash(deleted_at)`);

  const { rows: sentinel } = await pool.query(`SELECT 1 FROM library_pages WHERE sort_order != 0 LIMIT 1`);
  if (sentinel.length === 0) {
    await pool.query(`
      WITH ranked AS (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY parent_id ORDER BY title) - 1 AS rn
        FROM library_pages
      )
      UPDATE library_pages SET sort_order = ranked.rn
      FROM ranked WHERE library_pages.id = ranked.id
    `);
  }

  const { rows: legacyColumns } = await pool.query(`
    SELECT
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'library_pages' AND column_name = 'type') AS has_type,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'library_pages' AND column_name = 'metadata') AS has_metadata
  `);
  const hasType = legacyColumns[0]?.has_type === true;
  const hasMetadata = legacyColumns[0]?.has_metadata === true;
  if (hasType) {
    await pool.query(`ALTER TABLE library_pages ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}'`);
    await pool.query(`ALTER TABLE library_pages ADD COLUMN IF NOT EXISTS status TEXT`);
    await pool.query(hasMetadata ? `
      UPDATE library_pages SET tags = ARRAY['spec'], status = COALESCE((metadata->>'status'), 'draft') WHERE type = 'spec'
    ` : `
      UPDATE library_pages SET tags = ARRAY['spec'], status = COALESCE(status, 'draft') WHERE type = 'spec'
    `);
    await pool.query(`UPDATE library_pages SET tags = ARRAY['folder'] WHERE type = 'folder'`);
    await pool.query(`DROP INDEX IF EXISTS idx_library_pages_type`);
    await pool.query(`ALTER TABLE library_pages DROP COLUMN IF EXISTS type`);
  }
  if (hasMetadata) await pool.query(`ALTER TABLE library_pages DROP COLUMN IF EXISTS metadata`);

  const existingNotesFolder = await db
    .select({ id: libraryPages.id })
    .from(libraryPages)
    .where(and(eq(libraryPages.slug, "notes"), sql`'system-folder' = ANY(${libraryPages.tags})`));
  if (existingNotesFolder.length > 0) return;

  const { resolveLibraryParent } = await import("./library-index");
  const { upsertLibraryPageMemory } = await import("./routes/library");
  const folderId = await resolveLibraryParent("notes");
  await db.update(libraryPages).set({ sortOrder: -1, emoji: "📝" }).where(eq(libraryPages.id, folderId));

  const allNotes = await db.select().from(infoNotes);
  const usedSlugs = new Set<string>();
  for (const note of allNotes) {
    const baseSlug = slugify(note.title || "untitled");
    let finalSlug = baseSlug;
    let counter = 2;
    while (usedSlugs.has(finalSlug)) finalSlug = `${baseSlug}-${counter++}`;
    usedSlugs.add(finalSlug);
    const [created] = await db.insert(libraryPages).values({
      title: note.title || "Untitled",
      slug: finalSlug,
      content: note.content ?? { type: "doc", content: [] },
      plainTextContent: note.plainTextContent || "",
      parentId: folderId,
      tags: ["migrated-from-note"],
      sortOrder: 0,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    }).returning();
    await upsertLibraryPageMemory(created).catch((error) => {
      log.warn("legacy note memory projection failed", {
        pageId: created.id,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    });
  }
  log.info("library compatibility convergence complete", { migratedNotes: allNotes.length });
}
