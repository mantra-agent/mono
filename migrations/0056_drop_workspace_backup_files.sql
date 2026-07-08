-- Backups are stored in R2 via backup_jobs.s3_key.
-- The legacy workspace_backup_files table duplicated file payloads in Postgres
-- and can exceed export string limits during database sync.

DROP TABLE IF EXISTS workspace_backup_files;
