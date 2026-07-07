-- Fix: library_pages.id has no database-level default.
-- The Drizzle schema declares .default(sql`gen_random_uuid()`) but that
-- ORM-level default is not firing consistently across all insert paths
-- (tool handler, library-index, thoughts, skill-seed).
-- Adding the default at the database level makes it work regardless of
-- which code path inserts.

ALTER TABLE library_pages ALTER COLUMN id SET DEFAULT gen_random_uuid();
