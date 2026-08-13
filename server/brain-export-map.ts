import { getTableName, is, Table } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import * as schema from "@shared/schema";

// Derived Brain export producers.
//
// Include implies export. Every Drizzle pgTable is a potential producer; fate
// (EXCLUSIONS / INCLUSIONS / SOURCE_VERIFIED_INCLUDES) decides membership.
// Catalog FKs own insert order and identity/sequence metadata. This module is
// the single name → producer map plus the tiny authored exception surface.
// TABLE_REGISTRY is no longer a second inventory.

export type BrainDomain =
  | "core"
  | "memory"
  | "chat"
  | "finance"
  | "strategy"
  | "skills"
  | "info"
  | "health"
  | "cognition"
  | "email"
  | "calendar"
  | "other";

export type BrainExportEntry = {
  key: string;
  /** Drizzle-backed producer, or raw SQL for includes with no pgTable declaration. */
  kind: "drizzle" | "raw";
  table?: PgTable;
  domain: BrainDomain;
  hasSerial: boolean;
  serialCol?: string;
  sensitiveFields?: string[];
};

/** Authored exceptions only — not a second table inventory. */
export type BrainExportException = {
  /** Force raw SQL producer even if a Drizzle table exists. */
  kind?: "drizzle" | "raw";
  /** Include with no Drizzle declaration must set kind:"raw" or supply table. */
  table?: PgTable;
  domain?: BrainDomain;
  sensitiveFields?: string[];
  serialCol?: string;
  hasSerial?: boolean;
};

/**
 * Tiny authored exception map. Keys are relation names.
 * - sensitiveFields: redaction metadata for export summaries
 * - serialCol / hasSerial: restore sequence overrides when catalog evidence is absent
 * - kind:"raw": include has no Drizzle pgTable; export/import use raw SQL SELECT and json_populate_recordset
 */
export const BRAIN_EXPORT_EXCEPTIONS: Record<string, BrainExportException> = {
  users: { sensitiveFields: ["password", "reset_token"], domain: "core" },
  connected_accounts: { sensitiveFields: ["tokens"], domain: "core" },
  subscription_oauth_transactions: { sensitiveFields: ["codeVerifier"], domain: "core" },
  provider_connections: {
    sensitiveFields: ["encryptedCredential", "credentialIv", "credentialTag"],
    domain: "other",
  },
  info_notes: { hasSerial: true, serialCol: "note_id", domain: "info" },
  library_pages: { hasSerial: true, serialCol: "page_id", domain: "info" },
  library_page_links: { hasSerial: true, serialCol: "id", domain: "info" },

  // Includes with no Drizzle declaration — raw SQL producers (bootstrap / ensure DDL).
  app_migrations: { kind: "raw", domain: "core" },
  application_error_aggregates: { kind: "raw", domain: "other" },
  backup_jobs: { kind: "raw", domain: "core" },
  document_store_cutover_state: { kind: "raw", domain: "chat" },
  document_store_migration_conflicts: { kind: "raw", domain: "chat" },
  document_store_migration_runs: { kind: "raw", domain: "chat" },
  historical_continuity_entries: { kind: "raw", domain: "chat" },
  hours_used_intervals: { kind: "raw", domain: "other" },
  hours_used_rollups: { kind: "raw", domain: "other" },
  intentions: { kind: "raw", domain: "other" },
  legacy_memory_quarantine_state: { kind: "raw", domain: "memory" },
  library_vault_identity_migrations: { kind: "raw", domain: "info" },
  parked_ideas: { kind: "raw", domain: "other" },
  railway_api_call_receipts: { kind: "raw", domain: "other" },
  skill_scores: { kind: "raw", domain: "skills" },
  slack_events: { kind: "raw", domain: "other" },
  slack_installations: { kind: "raw", domain: "other" },
  slack_principal_mappings: { kind: "raw", domain: "other" },
  slack_session_bindings: { kind: "raw", domain: "other" },
  waitlist_applications: { kind: "raw", domain: "other" },
};

let drizzleTableCache: Map<string, PgTable> | null = null;

export function collectDrizzleTables(): Map<string, PgTable> {
  if (drizzleTableCache) return drizzleTableCache;
  const map = new Map<string, PgTable>();
  for (const value of Object.values(schema)) {
    if (value && is(value as never, Table)) {
      const table = value as PgTable;
      map.set(getTableName(table), table);
    }
  }
  drizzleTableCache = map;
  return map;
}

export function listDrizzleTableNames(): string[] {
  return [...collectDrizzleTables().keys()].sort();
}

/**
 * Resolve the export/import producer for one included relation.
 * Returns null when the include has neither a Drizzle table nor a raw/table exception.
 */
export function resolveExportProducer(relation: string): BrainExportEntry | null {
  const exception = BRAIN_EXPORT_EXCEPTIONS[relation];
  if (exception?.kind === "raw") {
    return {
      key: relation,
      kind: "raw",
      domain: exception.domain ?? "other",
      hasSerial: exception.hasSerial ?? Boolean(exception.serialCol),
      serialCol: exception.serialCol,
      sensitiveFields: exception.sensitiveFields,
    };
  }
  const drizzle = collectDrizzleTables().get(relation);
  const table = exception?.table ?? drizzle;
  if (!table) return null;
  return {
    key: relation,
    kind: "drizzle",
    table,
    domain: exception?.domain ?? "other",
    hasSerial: exception?.hasSerial ?? Boolean(exception?.serialCol),
    serialCol: exception?.serialCol,
    sensitiveFields: exception?.sensitiveFields,
  };
}

/** Every name that can currently produce an export (Drizzle ∪ raw exceptions ∪ exception tables). */
export function listExportProducerNames(): string[] {
  const names = new Set<string>(collectDrizzleTables().keys());
  for (const [name, exception] of Object.entries(BRAIN_EXPORT_EXCEPTIONS)) {
    if (exception.kind === "raw" || exception.table || names.has(name)) names.add(name);
  }
  return [...names].sort();
}

export function getBrainExportProducerCount(): number {
  return listExportProducerNames().length;
}

/**
 * Build ordered export/import entries from catalog (or manifest) insert order.
 * Missing producers are returned separately so callers can fail closed with exact names.
 */
export function buildExportEntriesFromOrder(insertOrder: string[]): {
  entries: BrainExportEntry[];
  missingProducers: string[];
} {
  const entries: BrainExportEntry[] = [];
  const missingProducers: string[] = [];
  const seen = new Set<string>();
  for (const name of insertOrder) {
    if (seen.has(name)) continue;
    seen.add(name);
    const entry = resolveExportProducer(name);
    if (!entry) missingProducers.push(name);
    else entries.push(entry);
  }
  return { entries, missingProducers };
}

/**
 * For import paths without a catalog insertOrder: every producer that has a
 * matching JSON file, stable-sorted. Prefer manifest insertOrder when present.
 */
export function buildExportEntriesForPresentFiles(fileKeys: string[]): BrainExportEntry[] {
  const wanted = new Set(fileKeys);
  const entries: BrainExportEntry[] = [];
  for (const name of listExportProducerNames()) {
    if (!wanted.has(name)) continue;
    const entry = resolveExportProducer(name);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** All Drizzle tables for DB Sync schema convergence (not fate-filtered). */
export function listAllDrizzleTables(): PgTable[] {
  return [...collectDrizzleTables().values()];
}
