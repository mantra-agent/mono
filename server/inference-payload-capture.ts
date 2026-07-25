import { randomUUID } from "crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, hasAmbientDatabaseTransaction, runOutsideDatabaseTransaction, withDatabaseLane } from "./db";
import { createLogger } from "./log";
import { safeStringify, safeTruncate } from "./utils/safe-stringify";
import { getCurrentPrincipal, requireCurrentUserPrincipal } from "./principal-context";
import { ownedInsertValues, visibleScopePredicate } from "./scoped-storage";
import { apiCallRecords, inferencePayloadCaptures } from "@shared/schema";
import type {
  InferencePayloadCapture,
  InferencePayloadCaptureSummary,
} from "@shared/inference-payload";

const log = createLogger("inference-payload-capture");
export const INFERENCE_PAYLOAD_RETENTION_LIMIT = 20;
const INFERENCE_PAYLOAD_CAPTURE_VERSION = 2;

export interface CaptureInferencePayloadInput {
  provider: string;
  model: string;
  activity?: string | null;
  boundary: string;
  authority: string;
  observableBoundary: string;
  request: unknown;
  excludedSensitiveFields?: string[];
  residualLimitation?: string | null;
  attempt?: number;
  metadata?: Record<string, unknown>;
  sessionId?: string | null;
  source?: string | null;
  apiCallId?: number | null;
}

interface EncodedProviderRequest {
  encoding: "base64-json-utf8-v1";
  data: string;
}

function serializeProviderRequest(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("Provider request is not JSON serializable");
  }
  return serialized;
}

function encodeProviderRequest(serialized: string): EncodedProviderRequest {
  return {
    encoding: "base64-json-utf8-v1",
    data: Buffer.from(serialized, "utf8").toString("base64"),
  };
}

function isEncodedProviderRequest(value: unknown): value is EncodedProviderRequest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<EncodedProviderRequest>;
  return candidate.encoding === "base64-json-utf8-v1" && typeof candidate.data === "string";
}

function decodeProviderRequest(value: unknown): unknown {
  if (!isEncodedProviderRequest(value)) return value;
  try {
    return JSON.parse(Buffer.from(value.data, "base64").toString("utf8"));
  } catch (error) {
    log.error(`provider payload decode failed ${safeStringify({
      errorChain: captureDatabaseErrorChain(error),
    }, {
      label: "inference-payload-capture.decode-failure",
      maxBytes: 4_000,
      maxDepth: 6,
      maxKeys: 24,
      maxArrayItems: 5,
      maxStrLen: 1_000,
    })}`);
    throw new Error("Inference payload capture is unreadable");
  }
}

interface CapturedDatabaseError {
  name: string;
  message: string;
  code?: string;
  severity?: string;
  detail?: string;
  hint?: string;
  position?: string;
  internalPosition?: string;
  internalQuery?: string;
  where?: string;
  schema?: string;
  table?: string;
  column?: string;
  dataType?: string;
  constraint?: string;
  file?: string;
  line?: string;
  routine?: string;
}

const DATABASE_ERROR_FIELDS = [
  "code",
  "severity",
  "detail",
  "hint",
  "position",
  "internalPosition",
  "internalQuery",
  "where",
  "schema",
  "table",
  "column",
  "dataType",
  "constraint",
  "file",
  "line",
  "routine",
] as const;

function captureDatabaseErrorChain(error: unknown): CapturedDatabaseError[] {
  const chain: CapturedDatabaseError[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current !== undefined && current !== null && chain.length < 5 && !seen.has(current)) {
    seen.add(current);
    const record = typeof current === "object" ? current as Record<string, unknown> : null;
    const item: CapturedDatabaseError = {
      name: current instanceof Error ? current.name : typeof current,
      message: safeTruncate(
        current instanceof Error ? current.message : String(current),
        2_000,
        "inference-payload-capture.error-message",
      ),
    };
    if (record) {
      for (const field of DATABASE_ERROR_FIELDS) {
        const value = record[field];
        if (typeof value === "string" && value.length > 0) {
          item[field] = safeTruncate(
            value,
            2_000,
            `inference-payload-capture.error-${field}`,
          );
        }
      }
    }
    chain.push(item);
    current = record?.cause;
  }

  return chain;
}

function captureVersion(metadata: Record<string, unknown>): number | null {
  const value = metadata.captureVersion;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

type CaptureRow = typeof inferencePayloadCaptures.$inferSelect;
type UsageRow = Pick<typeof apiCallRecords.$inferSelect,
  "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "totalTokens" | "metadata"
> | null;

function usageStatus(metadata: Record<string, unknown> | null | undefined): "dispatched" | "success" | "error" | "aborted" | "partial" | null {
  const value = metadata?.status;
  return value === "dispatched" || value === "success" || value === "error" || value === "aborted" || value === "partial"
    ? value
    : null;
}

function usageSemantics(metadata: Record<string, unknown> | null | undefined): "per_call" | "cumulative_provider_session" | "unknown" | null {
  const value = metadata?.usageSemantics;
  return value === "per_call" || value === "cumulative_provider_session" || value === "unknown" ? value : null;
}

function metadataInteger(metadata: Record<string, unknown> | null | undefined, key: string): number | null {
  const tokenAccounting = metadata?.tokenAccounting;
  const value = tokenAccounting && typeof tokenAccounting === "object"
    ? (tokenAccounting as Record<string, unknown>)[key]
    : undefined;
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
}

function toProviderUsage(usage: UsageRow): InferencePayloadCaptureSummary["providerUsage"] {
  if (!usage) return null;
  return {
    inputTokens: usageStatus(usage.metadata) === "dispatched" ? null : usage.inputTokens,
    outputTokens: usageStatus(usage.metadata) === "dispatched" ? null : usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    reasoningTokens: metadataInteger(usage.metadata, "reasoningTokens"),
    totalTokens: usageStatus(usage.metadata) === "dispatched" ? null : usage.totalTokens,
    status: usageStatus(usage.metadata),
    semantics: usageSemantics(usage.metadata),
  };
}

function toSummary(row: CaptureRow, usage: UsageRow = null): InferencePayloadCaptureSummary {
  const version = captureVersion(row.metadata);
  return {
    id: row.id,
    capturedAt: row.capturedAt.toISOString(),
    provider: row.provider,
    model: row.model,
    activity: row.activity,
    boundary: row.boundary,
    sessionId: row.sessionId,
    source: row.source,
    attempt: row.attempt,
    requestChars: row.requestChars,
    apiCallId: row.apiCallId,
    providerUsage: toProviderUsage(usage),
    captureVersion: version,
    completeness: version === INFERENCE_PAYLOAD_CAPTURE_VERSION ? "complete" : "legacy_incomplete",
  };
}

/**
 * Persist the exact secret-free request projection at a provider dispatch boundary.
 * Capture is diagnostic: failure is visible in logs but never blocks the model call.
 */
export async function captureInferencePayload(input: CaptureInferencePayloadInput): Promise<string | null> {
  const principal = getCurrentPrincipal();
  if (principal?.actorType !== "user" || !principal.userId || !principal.accountId) {
    log.debug(`capture skipped without user principal provider=${input.provider} boundary=${input.boundary}`);
    return null;
  }

  const id = randomUUID();
  const ownership = ownedInsertValues(principal, {
    scope: inferencePayloadCaptures.scope,
    ownerUserId: inferencePayloadCaptures.ownerUserId,
    accountId: inferencePayloadCaptures.accountId,
  });
  try {
    const serializedRequest = serializeProviderRequest(input.request);
    const encodedRequest = encodeProviderRequest(serializedRequest);
    const requestChars = serializedRequest.length;

    await runOutsideDatabaseTransaction(() =>
      withDatabaseLane("general", () =>
        db.transaction(async (tx) => {
          await tx.insert(inferencePayloadCaptures).values({
            id,
            ...ownership,
            createdByUserId: principal.userId,
            provider: input.provider,
            model: input.model,
            activity: input.activity ?? null,
            boundary: input.boundary,
            authority: input.authority,
            observableBoundary: input.observableBoundary,
            request: encodedRequest,
            requestChars,
            excludedSensitiveFields: input.excludedSensitiveFields ?? [],
            residualLimitation: input.residualLimitation ?? null,
            apiCallId: input.apiCallId ?? null,
            attempt: input.attempt ?? 1,
            metadata: {
              ...(input.metadata ?? {}),
              captureVersion: INFERENCE_PAYLOAD_CAPTURE_VERSION,
            },
            sessionId: input.sessionId ?? null,
            source: input.source ?? null,
          });

          await tx.execute(sql`
            DELETE FROM inference_payload_captures
            WHERE id IN (
              SELECT id
              FROM inference_payload_captures
              WHERE scope = 'user'
                AND owner_user_id = ${principal.userId}
                AND account_id = ${principal.accountId}
              ORDER BY captured_at DESC, id DESC
              OFFSET ${INFERENCE_PAYLOAD_RETENTION_LIMIT}
            )
          `);
        }),
      ),
    );
    log.debug(`captured provider payload id=${id} apiCallId=${input.apiCallId ?? "unlinked"} provider=${input.provider} boundary=${input.boundary} chars=${requestChars}`);
    return id;
  } catch (error) {
    const diagnostic = {
      provider: input.provider,
      boundary: input.boundary,
      model: input.model,
      activity: input.activity ?? null,
      sessionId: input.sessionId ?? null,
      attempt: input.attempt ?? 1,
      apiCallId: input.apiCallId ?? null,
      ambientTransaction: hasAmbientDatabaseTransaction(),
      errorChain: captureDatabaseErrorChain(error),
    };
    log.warn(
      `provider payload capture failed ${safeStringify(diagnostic, {
        label: "inference-payload-capture.failure",
        maxBytes: 16_000,
        maxDepth: 8,
        maxKeys: 32,
        maxArrayItems: 8,
        maxStrLen: 2_000,
      })}`,
    );
    return null;
  }
}

export async function listInferencePayloadCaptures(
  limit = INFERENCE_PAYLOAD_RETENTION_LIMIT,
): Promise<InferencePayloadCaptureSummary[]> {
  const principal = requireCurrentUserPrincipal();
  const boundedLimit = Math.max(1, Math.min(limit, INFERENCE_PAYLOAD_RETENTION_LIMIT));
  const visible = visibleScopePredicate(principal, {
    scope: inferencePayloadCaptures.scope,
    ownerUserId: inferencePayloadCaptures.ownerUserId,
    accountId: inferencePayloadCaptures.accountId,
  });
  const rows = await db
    .select({ capture: inferencePayloadCaptures, usage: apiCallRecords })
    .from(inferencePayloadCaptures)
    .leftJoin(apiCallRecords, and(
      eq(inferencePayloadCaptures.apiCallId, apiCallRecords.id),
      eq(apiCallRecords.scope, "user"),
      eq(apiCallRecords.ownerUserId, principal.userId),
      eq(apiCallRecords.accountId, principal.accountId),
    ))
    .where(and(
      visible,
      eq(inferencePayloadCaptures.ownerUserId, principal.userId),
      eq(inferencePayloadCaptures.accountId, principal.accountId),
    ))
    .orderBy(desc(inferencePayloadCaptures.capturedAt), desc(inferencePayloadCaptures.id))
    .limit(boundedLimit);
  return rows.map(({ capture, usage }) => toSummary(capture, usage));
}

export async function getInferencePayloadCapture(id: string): Promise<InferencePayloadCapture | null> {
  const principal = requireCurrentUserPrincipal();
  const scope = visibleScopePredicate(principal, {
    scope: inferencePayloadCaptures.scope,
    ownerUserId: inferencePayloadCaptures.ownerUserId,
    accountId: inferencePayloadCaptures.accountId,
  });
  const [result] = await db
    .select({ capture: inferencePayloadCaptures, usage: apiCallRecords })
    .from(inferencePayloadCaptures)
    .leftJoin(apiCallRecords, and(
      eq(inferencePayloadCaptures.apiCallId, apiCallRecords.id),
      eq(apiCallRecords.scope, "user"),
      eq(apiCallRecords.ownerUserId, principal.userId),
      eq(apiCallRecords.accountId, principal.accountId),
    ))
    .where(and(
      eq(inferencePayloadCaptures.id, id),
      scope,
      eq(inferencePayloadCaptures.ownerUserId, principal.userId),
      eq(inferencePayloadCaptures.accountId, principal.accountId),
    ))
    .limit(1);
  if (!result) return null;
  const { capture, usage } = result;
  return {
    ...toSummary(capture, usage),
    request: decodeProviderRequest(capture.request),
    evidence: {
      authority: capture.authority,
      observableBoundary: capture.observableBoundary,
      excludedSensitiveFields: capture.excludedSensitiveFields,
      residualLimitation: capture.residualLimitation,
    },
    metadata: capture.metadata,
  };
}
