import { readFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { getTableName, is, Table } from "drizzle-orm";
import * as schema from "../shared/schema";
import {
  isSecurityDenied,
  listSecurityDenylistNames,
  SECURITY_DENYLIST,
} from "../server/backup-completeness";
import {
  BRAIN_EXPORT_EXCEPTIONS,
  resolveExportProducer,
} from "../server/brain-export-map";

// Build-time inverted-default backup invariant.
//
// Schema is membership. Every declared relation (Drizzle pgTable + bootstrap /
// migration / ensure CREATE TABLE) minus SECURITY_DENYLIST is a required
// export member. There is no include inventory and no unfated state.
//
// Fail npm run build when:
// 1. A denylisted relation would resolve as a producer, or
// 2. A non-denylisted declared relation has no producer.
//
// Ordinary tables use Drizzle. Declared relations with no pgTable use raw SQL
// automatically. BRAIN_EXPORT_EXCEPTIONS is only sensitiveFields / serial overrides.
//
// Runtime leftovers (live tables source cannot see) export via raw SQL; they
// are not a build concern.

const CREATE_TABLE_RE = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+"?([a-z_][a-z0-9_]*)"?/g;

// The permissive CREATE TABLE regex can capture reserved words that follow the
// keyword in comments or non-DDL prose. These are proven false positives, not
// relations. Keep this list minimal and evidence-backed.
const PARSER_FALSE_POSITIVES = new Set(["is"]);

export interface BackupFateSummary {
  declaredRelations: number;
  membershipRelations: number;
  denylistRelations: number;
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
  if (!existsSync(root)) throw new Error(`backup fate disposition: root not found: ${root}`);

  const created = await collectCreateTableNames(root);
  const drizzle = collectDeclaredDrizzleTables();
  const declared = new Set<string>([...drizzle, ...created]);
  const denylist = listSecurityDenylistNames();

  // Denylist entries must carry owner + reason (authored security surface only).
  for (const name of denylist) {
    const entry = SECURITY_DENYLIST[name];
    if (!entry?.owner?.trim() || !entry?.reason?.trim()) {
      throw new Error(
        `backup fate disposition failed: SECURITY_DENYLIST.${name} must include non-empty owner and reason`,
      );
    }
  }

  // Denylisted relations must never resolve as producers.
  const denylistAsProducers = denylist.filter((name) => resolveExportProducer(name) != null);
  if (denylistAsProducers.length) {
    throw new Error(
      `backup fate disposition failed (${denylistAsProducers.length} denylisted relation(s) would resolve as a producer):\n${denylistAsProducers
        .map((name) => `- ${name}`)
        .join("\n")}\nSecurity-denylisted relations must never enter Brain export.`,
    );
  }

  // Denylist must not appear in BRAIN_EXPORT_EXCEPTIONS (exceptions are export metadata).
  const denylistExceptions = denylist.filter((name) => name in BRAIN_EXPORT_EXCEPTIONS);
  if (denylistExceptions.length) {
    throw new Error(
      `backup fate disposition failed (${denylistExceptions.length} denylisted relation(s) listed in BRAIN_EXPORT_EXCEPTIONS):\n${denylistExceptions
        .map((name) => `- ${name}`)
        .join("\n")}\nRemove denylisted names from BRAIN_EXPORT_EXCEPTIONS; they never export.`,
    );
  }

  // Membership = declared − denylist. Every member must have a producer.
  const membership = [...declared].filter((name) => !isSecurityDenied(name)).sort();
  const missingProducers = membership.filter((name) => resolveExportProducer(name) == null);
  if (missingProducers.length) {
    throw new Error(
      `backup fate disposition failed (${missingProducers.length} membership relation(s) without a producer):\n${missingProducers
        .map((name) => `- ${name}`)
        .join(
          "\n",
        )}\nSchema is membership. Non-denylisted declared relations must resolve to a Drizzle or auto raw-SQL producer.`,
    );
  }

  // Count producers among membership that have Drizzle tables (reporting only).
  const drizzleProducers = membership.filter((name) => drizzle.has(name)).length;

  return {
    declaredRelations: declared.size,
    membershipRelations: membership.length,
    denylistRelations: denylist.length,
    producerCount: drizzleProducers,
  };
}
