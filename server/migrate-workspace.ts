// Use createLogger for logging ONLY
import { resolve, join } from "path";
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, rmSync, writeFileSync } from "fs";
import { WORKSPACE_DIR } from "./paths";
import { createLogger } from "./log";

const log = createLogger("MigrateWorkspace");

const MARKER_FILE = join(WORKSPACE_DIR, ".workspace-migrated");
const OLD_NESTED = join(WORKSPACE_DIR, "workspace");

const DIRS_TO_MIGRATE = ["uploads", "config", "project-files"];

interface CopyResult { copied: number; skipped: number }

function copyDirRecursive(src: string, dest: string): CopyResult {
  if (!existsSync(src)) return { copied: 0, skipped: 0 };
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });

  let copied = 0;
  let skipped = 0;
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const stat = statSync(srcPath);

    if (stat.isDirectory()) {
      const sub = copyDirRecursive(srcPath, destPath);
      copied += sub.copied;
      skipped += sub.skipped;
    } else if (!existsSync(destPath)) {
      copyFileSync(srcPath, destPath);
      copied++;
    } else {
      log.log(`  skipped (already exists): ${destPath}`);
      skipped++;
    }
  }
  return { copied, skipped };
}

export function migrateWorkspaceData(): void {
  if (existsSync(MARKER_FILE)) return;
  if (!existsSync(OLD_NESTED)) {
    writeFileSync(MARKER_FILE, new Date().toISOString(), "utf-8");
    return;
  }

  log.log("Starting one-time workspace data migration...");
  log.log(`Old nested path: ${OLD_NESTED}`);
  log.log(`Correct root: ${WORKSPACE_DIR}`);

  let totalFiles = 0;
  let totalSkipped = 0;

  for (const dir of DIRS_TO_MIGRATE) {
    const src = join(OLD_NESTED, dir);
    const dest = join(WORKSPACE_DIR, dir);

    if (!existsSync(src)) {
      log.log(`Skipping ${dir}/ — not found in nested path`);
      continue;
    }

    const result = copyDirRecursive(src, dest);
    totalFiles += result.copied;
    totalSkipped += result.skipped;
    log.log(`Migrated ${dir}/ — ${result.copied} copied, ${result.skipped} skipped`);
  }

  log.log(`Total: ${totalFiles} files migrated, ${totalSkipped} skipped (already existed)`);

  try {
    rmSync(OLD_NESTED, { recursive: true, force: true });
    log.log("Cleaned up nested workspace/ directory");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Warning: could not fully remove nested dir: ${msg}`);
  }

  writeFileSync(MARKER_FILE, new Date().toISOString(), "utf-8");
  log.log("Migration complete. Marker file written.");
}
