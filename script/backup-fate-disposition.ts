import { readFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { getTableName, is, Table } from "drizzle-orm";
import * as schema from "../shared/schema";
import { EXCLUSIONS, INCLUSIONS, SOURCE_VERIFIED_INCLUDES } from "../server/backup-completeness";

// Build-time backup-fate invariant.
//
// A declared relation without an include/exclude disposition is unrepresentable.
// Every relation the source guarantees can exist in Live — current Drizzle table
// declarations plus schema-bootstrap / immutable-migration CREATE TABLE names —
// must resolve to exactly one fate: EXCLUSIONS, INCLUSIONS, SOURCE_VERIFIED_INCLUDES,
// or a TABLE_REGISTRY exporter key. Missing fate fails the production build with the
// exact relation names, so a new table can never first surface as an "unexplained
// relation" in a Live backup preflight. The runtime pg_catalog preflight remains
// fail-closed only for leftovers source cannot see (a table created by hand).

// Keyword is matched case-sensitively (all DDL in this repo uses uppercase
// CREATE TABLE) and the relation name is lowercase snake_case only, so the
// optional-keyword branch can never capture "IF" as a relation name.
const CREATE_TABLE_RE = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+"?([a-z_][a-z0-9_]*)"?/g;
const REGISTRY_KEY_RE = /key:\s*"([a-z_][a-z0-9_]*)"/g;

// The permissive CREATE TABLE regex can capture reserved words that follow the
// keyword in comments or non-DDL prose. These are proven false positives, not
// relations. Keep this list minimal and evidence-backed.
const PARSER_FALSE_POSITIVES = new Set(["is"]);

export interface BackupFateSummary {
  declaredRelations: number;
  fatedRelations: number;
  includedWithoutExporter: string[];
}

function collectDeclaredDrizzleTables(): Set<string> {
  const names = new Set<string>();
  for (const value of Object.values(schema)) {
    if (value && is(value as never, Table)) names.add(getTableName(value as never));
  }
  return names;
}

async function collectCreateTableNames(root: string): Promise<Set<string>> {
  const names = new Set<string>();
  const sources: string[] = [join(root, "server/schema-bootstrap.ts")];
  const migrationsDir = join(root, "migrations");
  if (existsSync(migrationsDir)) {
    for (const entry of await readdir(migrationsDir)) {
      if (entry.endsWith(".sql")) sources.push(join(migrationsDir, entry));
    }
  }
  for (const file of sources) {
    if (!existsSync(file)) continue;
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(CREATE_TABLE_RE)) {
      const name = match[1];
      if (!PARSER_FALSE_POSITIVES.has(name)) names.add(name);
    }
  }
  return names;
}

async function collectRegistryExporterKeys(root: string): Promise<Set<string>> {
  const text = await readFile(join(root, "server/routes/brain.ts"), "utf8");
  const start = text.indexOf("export const TABLE_REGISTRY");
  if (start < 0) throw new Error("backup fate disposition: TABLE_REGISTRY not found in server/routes/brain.ts");
  const end = text.indexOf("];", start);
  if (end < 0) throw new Error("backup fate disposition: TABLE_REGISTRY array terminator not found");
  const block = text.slice(start, end);
  const keys = new Set<string>();
  for (const match of block.matchAll(REGISTRY_KEY_RE)) keys.add(match[1]);
  return keys;
}

export async function validateBackupFateDisposition(root: string): Promise<BackupFateSummary> {
  const [created, registryKeys] = await Promise.all([
    collectCreateTableNames(root),
    collectRegistryExporterKeys(root),
  ]);
  const drizzle = collectDeclaredDrizzleTables();

  const fated = new Set<string>([
    ...Object.keys(EXCLUSIONS),
    ...Object.keys(INCLUSIONS),
    ...SOURCE_VERIFIED_INCLUDES,
    ...registryKeys,
  ]);

  const declared = new Set<string>([...drizzle, ...created]);
  const unfated = [...declared].filter((name) => !fated.has(name)).sort();
  if (unfated.length) {
    throw new Error(
      `backup fate disposition failed (${unfated.length} declared relation(s) without an include/exclude disposition):\n${unfated
        .map((name) => `- ${name}`)
        .join("\n")}\nAdd each to EXCLUSIONS/INCLUSIONS/SOURCE_VERIFIED_INCLUDES in server/backup-completeness.ts or TABLE_REGISTRY in server/routes/brain.ts before shipping.`,
    );
  }

  // Residual visibility (non-failing in this first cut): included relations that
  // still lack a TABLE_REGISTRY exporter mapping. This is the pre-existing
  // exporter-backfill debt tracked under @task:2265; the fate invariant above is
  // the shippable cut. It is surfaced in build output, not enforced, so a merge
  // is not blocked on the separate ~100-relation exporter reconciliation.
  const included = new Set<string>([...Object.keys(INCLUSIONS), ...SOURCE_VERIFIED_INCLUDES]);
  const includedWithoutExporter = [...included]
    .filter((name) => declared.has(name) && !registryKeys.has(name))
    .sort();

  return { declaredRelations: declared.size, fatedRelations: fated.size, includedWithoutExporter };
}
