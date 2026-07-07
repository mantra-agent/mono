/**
 * patch-guard.ts — Reusable patch sanitizer for update-style tool handlers.
 *
 * Ensures update actions are safe partial mutations by default.
 * Omitted fields, undefined values, schema-default empty strings, and
 * accidental blanks never erase persisted data. Destructive clears
 * require explicit intent, confirmation, and a reason.
 *
 * Place at the mutation boundary before storage methods.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PatchGuardConfig<T> {
  /** Fields where accidental blanking degrades the record materially. */
  protectedFields: Array<keyof T>;

  /** Subset of protectedFields that may be cleared via clearFields. */
  clearableFields?: Array<keyof T>;

  /**
   * Subset of clearableFields that require confirmDestructiveUpdate + reason.
   * If omitted, all clearableFields are treated as non-destructive clears.
   */
  destructiveFields?: Array<keyof T>;

  /** Protected string fields where empty string is a valid value. */
  allowEmptyStringFields?: Array<keyof T>;

  /** Protected collection fields where empty array/object is a valid value. */
  allowEmptyCollectionFields?: Array<keyof T>;
}

export interface PatchInput {
  clearFields?: string[];
  confirmDestructiveUpdate?: boolean;
  destructiveUpdateReason?: string;
  [key: string]: unknown;
}

export interface PatchGuardResult<T> {
  /** Sanitized patch object safe to pass to storage. */
  patch: Partial<T>;
  /** Fields explicitly cleared by the caller. */
  clearFields: Array<keyof T>;
  /** Trimmed caller-provided reason when a destructive clear was authorized. */
  destructiveUpdateReason?: string;
}

export interface PatchClearAuditDetails {
  operation: string;
  entityType: string;
  entityId: string | number;
  clearFields: Array<string | number | symbol>;
  destructiveUpdateReason?: string;
}

export interface PatchClearAuditLogger {
  warn: (...args: unknown[]) => void;
}

export class PatchGuardError extends Error {
  public readonly code: string;
  public readonly fields: string[];
  public readonly required?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    fields: string[],
    required?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PatchGuardError';
    this.code = code;
    this.fields = fields;
    this.required = required;
  }

  toJSON() {
    return {
      error: this.code,
      message: this.message,
      fields: this.fields,
      ...(this.required ? { required: this.required } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isEmptyString(v: unknown): boolean {
  return typeof v === 'string' && v.trim() === '';
}

function isEmptyCollection(v: unknown): boolean {
  if (Array.isArray(v)) return v.length === 0;
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    return Object.keys(v as Record<string, unknown>).length === 0;
  }
  return false;
}

function asKeySet<T>(arr: Array<keyof T> | undefined): Set<string> {
  return new Set((arr ?? []).map(String));
}

function sanitizeAuditReason(reason: string | undefined): string | undefined {
  const trimmed = reason?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/[\r\n\t]+/g, ' ').slice(0, 500);
}

export function logPatchClearAudit(
  logger: PatchClearAuditLogger,
  details: PatchClearAuditDetails,
): void {
  if (details.clearFields.length === 0) return;

  logger.warn('patch_guard_explicit_clear', JSON.stringify({
    operation: details.operation,
    entityType: details.entityType,
    entityId: String(details.entityId),
    clearFields: details.clearFields.map(String),
    destructiveUpdateReason: sanitizeAuditReason(details.destructiveUpdateReason),
  }));
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Sanitize a raw update payload into a safe partial patch.
 *
 * Behavior:
 * 1. Drop keys with undefined values.
 * 2. Drop empty strings for protected string fields (unless explicitly allowed).
 * 3. Drop empty arrays/objects for protected collection fields (unless allowed).
 * 4. Validate clearFields against the clearable allowlist.
 * 5. Reject conflicting clear + set on the same field.
 * 6. Reject destructive clears without confirmDestructiveUpdate + reason.
 * 7. Return sanitized patch + validated clearFields.
 */
export function sanitizePatch<T>(
  raw: PatchInput,
  config: PatchGuardConfig<T>,
): PatchGuardResult<T> {
  const {
    protectedFields,
    clearableFields = [],
    destructiveFields = [],
    allowEmptyStringFields = [],
    allowEmptyCollectionFields = [],
  } = config;

  const protectedSet = asKeySet(protectedFields);
  const clearableSet = asKeySet(clearableFields);
  const destructiveSet = asKeySet(destructiveFields);
  const allowEmptyStrSet = asKeySet(allowEmptyStringFields);
  const allowEmptyColSet = asKeySet(allowEmptyCollectionFields);

  // Extract control fields
  const {
    clearFields: rawClearFields,
    confirmDestructiveUpdate,
    destructiveUpdateReason,
    ...fields
  } = raw;

  // ── Step 4: Validate clearFields ──────────────────────────────────────
  const validatedClearFields: Array<keyof T> = [];
  let authorizedDestructiveReason: string | undefined;

  if (rawClearFields && rawClearFields.length > 0) {
    const unknownFields = rawClearFields.filter((f) => !clearableSet.has(f));
    if (unknownFields.length > 0) {
      throw new PatchGuardError(
        'invalid_clear_fields',
        `Cannot clear fields not in the clearable allowlist: ${unknownFields.join(', ')}`,
        unknownFields,
      );
    }

    // ── Step 6: Require confirmation for destructive clears ─────────────
    const destructiveRequested = rawClearFields.filter((f) =>
      destructiveSet.has(f),
    );
    if (destructiveRequested.length > 0) {
      if (!confirmDestructiveUpdate || !destructiveUpdateReason?.trim()) {
        throw new PatchGuardError(
          'destructive_update_rejected',
          'Refusing to blank protected fields without explicit confirmation.',
          destructiveRequested,
          {
            clearFields: destructiveRequested,
            confirmDestructiveUpdate: true,
            destructiveUpdateReason: '<reason required>',
          },
        );
      }
      authorizedDestructiveReason = sanitizeAuditReason(destructiveUpdateReason);
    }

    validatedClearFields.push(
      ...(rawClearFields as Array<keyof T>),
    );
  }

  // ── Step 5: Reject conflicting clear + set ────────────────────────────
  const clearFieldSet = new Set(rawClearFields?.map(String) ?? []);
  const patch: Partial<T> = {};

  for (const [key, value] of Object.entries(fields)) {
    // Step 1: Drop undefined
    if (value === undefined) continue;

    // Step 5: Conflict check — field is both set and cleared
    if (clearFieldSet.has(key)) {
      throw new PatchGuardError(
        'conflicting_clear_and_set',
        `Cannot both set and clear field "${key}" in the same request.`,
        [key],
      );
    }

    // Step 2: Drop empty strings for protected string fields
    if (
      protectedSet.has(key) &&
      isEmptyString(value) &&
      !allowEmptyStrSet.has(key)
    ) {
      continue;
    }

    // Step 3: Drop empty collections for protected collection fields
    if (
      protectedSet.has(key) &&
      isEmptyCollection(value) &&
      !allowEmptyColSet.has(key)
    ) {
      continue;
    }

    (patch as Record<string, unknown>)[key] = value;
  }

  return {
    patch,
    clearFields: validatedClearFields,
    ...(authorizedDestructiveReason ? { destructiveUpdateReason: authorizedDestructiveReason } : {}),
  };
}
