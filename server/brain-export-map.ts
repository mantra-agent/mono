import { getTableName, is, Table } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import * as schema from "@shared/schema";
import { isSecurityDenied } from "./backup-completeness";

// Derived Brain export producers.
//
// Schema is membership. Every non-denylisted relation exports. Ordinary tables
// use Drizzle; declared/live relations with no pgTable use raw SQL automatically.
// Catalog FKs own insert order and identity/sequence metadata.
// BRAIN_EXPORT_EXCEPTIONS is only for sensitiveFields and serial overrides —
// not a second membership inventory and not a per-table raw-SQL registry.
// TABLE_REGISTRY is not a producer list.

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
  /** Drizzle-backed producer, or raw SQL when no pgTable declaration exists. */
  kind: "drizzle" | "raw";
  table?: PgTable;
  domain: BrainDomain;
  hasSerial: boolean;
  serialCol?: string;
  sensitiveFields?: string[];
};

/** Authored exceptions only — sensitiveFields and serial overrides. Not membership. */
export type BrainExportException = {
  domain?: BrainDomain;
  sensitiveFields?: string[];
  serialCol?: string;
  hasSerial?: boolean;
};

/**
 * Tiny authored exception map. Keys are relation names.
 * - sensitiveFields: redaction metadata for export summaries
 * - serialCol / hasSerial: restore sequence overrides when catalog evidence is absent
 * Do not add raw-SQL rows here; missing Drizzle tables auto-export via raw SQL.
 * Do not list security-denylisted relations.
 */
export const BRAIN_EXPORT_EXCEPTIONS: Record<string, BrainExportException> = {
  users: { sensitiveFields: ["password", "reset_token"], domain: "core" },
  connected_accounts: { sensitiveFields: ["tokens"], domain: "core" },
  provider_connections: {
    sensitiveFields: ["encryptedCredential", "credentialIv", "credentialTag"],
    domain: "other",
  },
  info_notes: { hasSerial: true, serialCol: "note_id", domain: "info" },
  library_pages: { hasSerial: true, serialCol: "page_id", domain: "info" },
  library_page_links: { hasSerial: true, serialCol: "id", domain: "info" },
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
 * Resolve the export/import producer for one relation.
 * Security-denylisted relations never resolve as producers (return null).
 * Non-denylisted relations always resolve: Drizzle when declared, else raw SQL.
 */
export function resolveExportProducer(relation: string): BrainExportEntry | null {
  if (isSecurityDenied(relation)) return null;

  const exception = BRAIN_EXPORT_EXCEPTIONS[relation];
  const drizzle = collectDrizzleTables().get(relation);
  if (drizzle) {
    return {
      key: relation,
      kind: "drizzle",
      table: drizzle,
      domain: exception?.domain ?? "other",
      hasSerial: exception?.hasSerial ?? Boolean(exception?.serialCol),
      serialCol: exception?.serialCol,
      sensitiveFields: exception?.sensitiveFields,
    };
  }

  // Auto raw SQL — no per-table exception row required.
  return {
    key: relation,
    kind: "raw",
    domain: exception?.domain ?? "other",
    hasSerial: exception?.hasSerial ?? Boolean(exception?.serialCol),
    serialCol: exception?.serialCol,
    sensitiveFields: exception?.sensitiveFields,
  };
}

/**
 * Drizzle table names that are eligible producers (non-denylisted).
 * Used as known-source labels for leftover classification; membership itself
 * is every live non-denylisted relation.
 */
export function listExportProducerNames(): string[] {
  return listDrizzleTableNames().filter((name) => !isSecurityDenied(name));
}

export function getBrainExportProducerCount(): number {
  return listExportProducerNames().length;
}

/**
 * Build ordered export/import entries from catalog (or manifest) insert order.
 * Missing producers are returned separately so callers can fail closed with exact names.
 * Under inverted default, only denylisted names yield missing producers.
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
 * For import paths without a catalog insertOrder: producers for present JSON
 * files, stable-sorted. Prefer manifest insertOrder when present.
 * Denylisted file keys are skipped (no producer).
 */
export function buildExportEntriesForPresentFiles(fileKeys: string[]): BrainExportEntry[] {
  const entries: BrainExportEntry[] = [];
  for (const name of [...fileKeys].sort()) {
    const entry = resolveExportProducer(name);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** All Drizzle tables for DB Sync schema convergence (not fate-filtered). */
export function listAllDrizzleTables(): PgTable[] {
  return [...collectDrizzleTables().values()];
}
