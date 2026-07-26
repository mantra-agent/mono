import { createHash, randomUUID } from "crypto";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db, hasAmbientDatabaseTransaction, runOutsideDatabaseTransaction, withDatabaseLane } from "./db";
import { createLogger } from "./log";
import { safeStringify, safeTruncate } from "./utils/safe-stringify";
import { getCurrentPrincipal, requireCurrentUserPrincipal } from "./principal-context";
import { ownedInsertValues, visibleScopePredicate } from "./scoped-storage";
import { apiCallRecords, inferencePayloadCaptures } from "@shared/schema";
import { storageBackend, PRIVATE_PREFIX } from "./object_storage/objectStorage";
import { ObjectPermission, canAccessObjectForPrincipal, setObjectAclPolicy } from "./object_storage/objectAcl";
import type {
  InferencePayloadCapture,
  InferencePayloadCaptureSummary,
} from "@shared/inference-payload";

const log = createLogger("inference-payload-capture");
export const INFERENCE_PAYLOAD_LIST_LIMIT = 20;
export const INFERENCE_PAYLOAD_RETENTION_LIMIT = 100;
const INFERENCE_PAYLOAD_ARCHIVE_BATCH_LIMIT = 5;
const INFERENCE_PAYLOAD_CAPTURE_VERSION = 2;
const INFERENCE_PAYLOAD_ARCHIVE_ENCODING = "private-object-json-utf8-v1";
const INFERENCE_PAYLOAD_ARCHIVE_PREFIX = `${PRIVATE_PREFIX}inference-payload-captures/`;

const archiveMaintenanceTailByOwner = new Map<string, Promise<void>>();
const archiveMaintenancePendingByOwner = new Set<string>();

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

interface ArchivedProviderRequest {
  encoding: typeof INFERENCE_PAYLOAD_ARCHIVE_ENCODING;
  objectKey: string;
  bytes: number;
  sha256: string;
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

function isArchivedProviderRequest(value: unknown): value is ArchivedProviderRequest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ArchivedProviderRequest>;
  return candidate.encoding === INFERENCE_PAYLOAD_ARCHIVE_ENCODING
    && typeof candidate.objectKey === "string"
    && Number.isInteger(candidate.bytes)
    && typeof candidate.sha256 === "string";
}

function captureArchiveObjectKey(id: string): string {
  return `${INFERENCE_PAYLOAD_ARCHIVE_PREFIX}${id}.json`;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
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

async function hydrateProviderRequest(
  id: string,
  value: unknown,
  principal: ReturnType<typeof requireCurrentUserPrincipal>,
): Promise<unknown> {
  if (!isArchivedProviderRequest(value)) return decodeProviderRequest(value);

  const expectedKey = captureArchiveObjectKey(id);
  if (value.objectKey !== expectedKey) {
    log.error(`capture archive pointer rejected captureId=${id}`);
    throw new Error("Inference payload capture is unreadable");
  }
  const canRead = await canAccessObjectForPrincipal({
    principal,
    objectKey: expectedKey,
    requestedPermission: ObjectPermission.READ,
  });
  if (!canRead) {
    log.warn(`capture archive access denied captureId=${id}`);
    throw new Error("Inference payload capture is unavailable");
  }

  const body = await storageBackend.getObjectBuffer(expectedKey);
  if (body.length !== value.bytes || sha256(body) !== value.sha256) {
    log.error(`capture archive integrity failed captureId=${id} expectedBytes=${value.bytes} actualBytes=${body.length}`);
    throw new Error("Inference payload capture is unreadable");
  }
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    log.error(`capture archive JSON decode failed captureId=${id}`);
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

function archivePointer(serialized: string, objectKey: string): ArchivedProviderRequest {
  return {
    encoding: INFERENCE_PAYLOAD_ARCHIVE_ENCODING,
    objectKey,
    bytes: Buffer.byteLength(serialized, "utf8"),
    sha256: sha256(serialized),
  };
}

async function archiveLinkedCapture(
  row: Pick<CaptureRow, "id" | "request" | "ownerUserId" | "accountId" | "createdByUserId">,
): Promise<boolean> {
  if (isArchivedProviderRequest(row.request)) return false;

  const serialized = JSON.stringify(decodeProviderRequest(row.request));
  if (serialized === undefined) {
    throw new Error("Stored provider request is not JSON serializable");
  }
  const objectKey = captureArchiveObjectKey(row.id);
  const pointer = archivePointer(serialized, objectKey);

  await storageBackend.putObject(objectKey, serialized, {
    contentType: "application/json; charset=utf-8",
    cacheControl: "private, no-store",
  });
  const objectMetadata = await storageBackend.headObject(objectKey);
  if (!objectMetadata || objectMetadata.contentLength !== pointer.bytes) {
    throw new Error("Inference capture archive verification failed");
  }
  await setObjectAclPolicy(objectKey, {
    owner: row.ownerUserId,
    ownerUserId: row.ownerUserId,
    accountId: row.accountId,
    createdByUserId: row.createdByUserId,
    scope: "user",
    visibility: "private",
  });

  const updated = await db
    .update(inferencePayloadCaptures)
    .set({ request: pointer })
    .where(and(
      eq(inferencePayloadCaptures.id, row.id),
      eq(inferencePayloadCaptures.scope, "user"),
      eq(inferencePayloadCaptures.ownerUserId, row.ownerUserId),
      eq(inferencePayloadCaptures.accountId, row.accountId),
      isNotNull(inferencePayloadCaptures.apiCallId),
      sql`${inferencePayloadCaptures.request}->>'encoding' IS DISTINCT FROM ${INFERENCE_PAYLOAD_ARCHIVE_ENCODING}`,
    ))
    .returning({ id: inferencePayloadCaptures.id });
  return updated.length > 0;
}

async function maintainCaptureRetention(ownerUserId: string, accountId: string): Promise<void> {
  const linkedRows = await db
    .select({
      id: inferencePayloadCaptures.id,
      request: inferencePayloadCaptures.request,
      ownerUserId: inferencePayloadCaptures.ownerUserId,
      accountId: inferencePayloadCaptures.accountId,
      createdByUserId: inferencePayloadCaptures.createdByUserId,
    })
    .from(inferencePayloadCaptures)
    .where(and(
      eq(inferencePayloadCaptures.scope, "user"),
      eq(inferencePayloadCaptures.ownerUserId, ownerUserId),
      eq(inferencePayloadCaptures.accountId, accountId),
      isNotNull(inferencePayloadCaptures.apiCallId),
      sql`${inferencePayloadCaptures.request}->>'encoding' IS DISTINCT FROM ${INFERENCE_PAYLOAD_ARCHIVE_ENCODING}`,
    ))
    .orderBy(desc(inferencePayloadCaptures.capturedAt), desc(inferencePayloadCaptures.id))
    .offset(INFERENCE_PAYLOAD_RETENTION_LIMIT)
    .limit(INFERENCE_PAYLOAD_ARCHIVE_BATCH_LIMIT);

  let archived = 0;
  for (const row of linkedRows) {
    if (await archiveLinkedCapture(row)) archived += 1;
  }

  const deleted = await db
    .delete(inferencePayloadCaptures)
    .where(and(
      eq(inferencePayloadCaptures.scope, "user"),
      eq(inferencePayloadCaptures.ownerUserId, ownerUserId),
      eq(inferencePayloadCaptures.accountId, accountId),
      isNull(inferencePayloadCaptures.apiCallId),
      sql`${inferencePayloadCaptures.id} IN (
        SELECT id
        FROM inference_payload_captures
        WHERE scope = 'user'
          AND owner_user_id = ${ownerUserId}
          AND account_id = ${accountId}
          AND api_call_id IS NULL
        ORDER BY captured_at DESC, id DESC
        OFFSET ${INFERENCE_PAYLOAD_RETENTION_LIMIT}
      )`,
    ))
    .returning({ id: inferencePayloadCaptures.id });

  if (archived > 0 || deleted.length > 0) {
    log.debug(`capture retention maintained ownerRowsArchived=${archived} unlinkedRowsDeleted=${deleted.length}`);
  }
}

async function runCaptureRetentionPass(ownerUserId: string, accountId: string): Promise<void> {
  await runOutsideDatabaseTransaction(() =>
    withDatabaseLane("general", () => maintainCaptureRetention(ownerUserId, accountId)),
  );
}

function scheduleCaptureRetention(ownerUserId: string, accountId: string): void {
  const maintenanceKey = `${ownerUserId}:${accountId}`;
  if (archiveMaintenanceTailByOwner.has(maintenanceKey)) {
    archiveMaintenancePendingByOwner.add(maintenanceKey);
    return;
  }

  const maintenance = (async () => {
    archiveMaintenancePendingByOwner.delete(maintenanceKey);
    await runCaptureRetentionPass(ownerUserId, accountId);
    if (archiveMaintenancePendingByOwner.has(maintenanceKey)) {
      archiveMaintenancePendingByOwner.delete(maintenanceKey);
      await runCaptureRetentionPass(ownerUserId, accountId);
    }
  })()
    .catch((error) => {
      log.warn(`capture retention maintenance failed ${safeStringify({
        errorChain: captureDatabaseErrorChain(error),
      }, {
        label: "inference-payload-capture.retention-failure",
        maxBytes: 8_000,
        maxDepth: 6,
        maxKeys: 24,
        maxArrayItems: 5,
        maxStrLen: 1_000,
      })}`);
    })
    .finally(() => {
      archiveMaintenanceTailByOwner.delete(maintenanceKey);
      archiveMaintenancePendingByOwner.delete(maintenanceKey);
    });
  archiveMaintenanceTailByOwner.set(maintenanceKey, maintenance);
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
        db.insert(inferencePayloadCaptures).values({
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
        }),
      ),
    );
    scheduleCaptureRetention(principal.userId, principal.accountId);
    log.debug(`capture created captureId=${id} apiCallId=${input.apiCallId ?? "unlinked"} provider=${input.provider} boundary=${input.boundary} attempt=${input.attempt ?? 1} chars=${requestChars}`);
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
  limit = INFERENCE_PAYLOAD_LIST_LIMIT,
): Promise<InferencePayloadCaptureSummary[]> {
  const principal = requireCurrentUserPrincipal();
  const boundedLimit = Math.max(1, Math.min(limit, INFERENCE_PAYLOAD_LIST_LIMIT));
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
  if (!result) {
    log.debug(`capture fetch unavailable captureId=${id}`);
    return null;
  }
  const { capture, usage } = result;
  log.debug(`capture fetch succeeded captureId=${id} apiCallId=${capture.apiCallId ?? "unlinked"} usageStatus=${usageStatus(usage?.metadata) ?? "unavailable"}`);
  return {
    ...toSummary(capture, usage),
    request: await hydrateProviderRequest(capture.id, capture.request, principal),
    evidence: {
      authority: capture.authority,
      observableBoundary: capture.observableBoundary,
      excludedSensitiveFields: capture.excludedSensitiveFields,
      residualLimitation: capture.residualLimitation,
    },
    metadata: capture.metadata,
  };
}
