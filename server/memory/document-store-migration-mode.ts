import { createLogger } from "../log";

const log = createLogger("DocumentStoreMigrationMode");

export const DOCUMENT_STORE_MIGRATION_MODE_ENV = "DOCUMENT_STORE_MIGRATION_MODE";
export type DocumentStoreMigrationMode = "off" | "shadow" | "cutover" | "independent";

const VALID_MODES = new Set<DocumentStoreMigrationMode>([
  "off",
  "shadow",
  "cutover",
  "independent",
]);
let invalidValueLogged: string | null = null;

/**
 * One fail-closed discriminant for document-store migration behavior.
 * Missing or invalid configuration resolves to off. Once independent mode is
 * persisted, startup rejects any other mode before stale legacy writes resume.
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
  const mode = getDocumentStoreMigrationMode();
  return mode === "shadow" || mode === "cutover";
}

export function documentStoreTargetReadsRequested(): boolean {
  const mode = getDocumentStoreMigrationMode();
  return mode === "cutover" || mode === "independent";
}

export function documentStoreIndependentWritesRequested(): boolean {
  return getDocumentStoreMigrationMode() === "independent";
}
