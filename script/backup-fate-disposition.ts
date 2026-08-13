import { readFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { getTableName, is, Table } from "drizzle-orm";
import * as schema from "../shared/schema";
import { EXCLUSIONS, INCLUSIONS, SOURCE_VERIFIED_INCLUDES } from "../server/backup-completeness";
import {
  BRAIN_EXPORT_EXCEPTIONS,
  listExportProducerNames,
  resolveExportProducer,
} from "../server/brain-export-map";

// Build-time backup-fate + producer invariant.
//
// A declared relation without an include/exclude disposition is unrepresentable.
// Every relation the source guarantees can exist in Live — current Drizzle table
// declarations plus schema-bootstrap / immutable-migration CREATE TABLE names —
// must resolve to exactly one fate: EXCLUSIONS, INCLUSIONS, or SOURCE_VERIFIED_INCLUDES.
//
// Include implies export. Every included relation must resolve to a derived
// producer (Drizzle table or authored raw/table exception). Missing producer
// fails the production build with the exact names. Fate without a producer is
// unrepresentable. Default-include remains forbidden.
//
// The runtime pg_catalog preflight remains fail-closed only for leftovers
// source cannot see (a table created by hand).

// Keyword is matched case-sensitively (all DDL in this repo uses uppercase
// CREATE TABLE) and the relation name is lowercase snake_case only, so the
// optional-keyword branch can never capture "IF" as a relation name.
const CREATE_TABLE_RE = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+"?([a-z_][a-z0-9_]*)"?/g;

// The permissive CREATE TABLE regex can capture reserved words that follow the
// keyword in comments or non-DDL prose. These are proven false positives, not
// relations. Keep this list minimal and evidence-backed.
const PARSER_FALSE_POSITIVES = new Set(["is"]);

export interface BackupFateSummary {
  declaredRelations: number;
  fatedRelations: number;
  includedWithoutExporter: string[];
  producerCount: number;
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
  // Bootstrap-only ensure DDL outside schema-bootstrap also declares live relations.
  const extraSources = [
    join(root, "server/backup-storage.ts"),
    join(root, "server/hours-used.ts"),
    join(root, "server/historical-continuity.ts"),
    join(root, "server/error-telemetry.ts"),
    join(root, "server/integrations/railway/request-attribution.ts"),
    join(root, "server/memory/legacy-memory-quarantine.ts"),
    join(root, "server/slack/schema.ts"),
  ];
  for (const file of extraSources) {
    if (existsSync(file)) sources.push(file);
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

export async function validateBackupFateDisposition(root: string): Promise<BackupFateSummary> {
  // Touch root so the validator stays path-bound to the build cwd even when
  // producer resolution is pure module evaluation.
  if (!existsSync(root)) throw new Error(`backup fate disposition: root not found: ${root}`);

  const created = await collectCreateTableNames(root);
  const drizzle = collectDeclaredDrizzleTables();
  const producerNames = new Set(listExportProducerNames());

  const fated = new Set<string>([
    ...Object.keys(EXCLUSIONS),
    ...Object.keys(INCLUSIONS),
    ...SOURCE_VERIFIED_INCLUDES,
  ]);

  const declared = new Set<string>([...drizzle, ...created]);
  const unfated = [...declared].filter((name) => !fated.has(name)).sort();
  if (unfated.length) {
    throw new Error(
      `backup fate disposition failed (${unfated.length} declared relation(s) without an include/exclude disposition):\n${unfated
        .map((name) => `- ${name}`)
        .join("\n")}\nAdd each to EXCLUSIONS/INCLUSIONS/SOURCE_VERIFIED_INCLUDES in server/backup-completeness.ts before shipping. Default-include is forbidden.`,
    );
  }

  // Include implies export. Every included relation that is declared (or
  // explicitly authored as a raw exception) must resolve to a producer.
  const included = new Set<string>([...Object.keys(INCLUSIONS), ...SOURCE_VERIFIED_INCLUDES]);
  const includedWithoutExporter = [...included]
    .filter((name) => {
      // Only enforce producers for relations the source can actually create,
      // plus any explicitly authored raw exceptions (even if discovery missed them).
      const mustHaveProducer = declared.has(name) || name in BRAIN_EXPORT_EXCEPTIONS;
      if (!mustHaveProducer) return false;
      return resolveExportProducer(name) == null;
    })
    .sort();

  if (includedWithoutExporter.length) {
    throw new Error(
      `backup fate disposition failed (${includedWithoutExporter.length} included relation(s) without a producer):\n${includedWithoutExporter
        .map((name) => `- ${name}`)
        .join("\n")}\nInclude implies export. Add a Drizzle pgTable declaration or a BRAIN_EXPORT_EXCEPTIONS raw/table producer in server/brain-export-map.ts.`,
    );
  }

  return {
    declaredRelations: declared.size,
    fatedRelations: fated.size,
    includedWithoutExporter: [],
    producerCount: producerNames.size,
  };
}
