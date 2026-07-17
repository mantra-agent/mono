import { createLogger } from "../log";

const log = createLogger("DocumentStoreMigrationMode");

export const DOCUMENT_STORE_MIGRATION_MODE_ENV = "DOCUMENT_STORE_MIGRATION_MODE";
export type DocumentStoreMigrationMode = "off" | "shadow" | "cutover";

const VALID_MODES = new Set<DocumentStoreMigrationMode>(["off", "shadow", "cutover"]);
let invalidValueLogged: string | null = null;

/**
 * One fail-closed discriminant for document-store migration behavior.
 * Missing or invalid configuration resolves to off.
 */
export function getDocumentStoreMigrationMode(): DocumentStoreMigrationMode {
  const raw = process.env[DOCUMENT_STORE_MIGRATION_MODE_ENV]?.trim().toLowerCase();
  if (!raw) return "off";
  if (VALID_MODES.has(raw as DocumentStoreMigrationMode)) {
    return raw as DocumentStoreMigrationMode;
  }
  if (invalidValueLogged !== raw) {
    invalidValueLogged = raw;
    log.error("invalid document store migration mode; failing closed", {
      configuredValue: raw,
      effectiveMode: "off",
    });
  }
  return "off";
}

export function documentStoreShadowEnabled(): boolean {
  return getDocumentStoreMigrationMode() !== "off";
}

export function documentStoreTargetReadsRequested(): boolean {
  return getDocumentStoreMigrationMode() === "cutover";
}
