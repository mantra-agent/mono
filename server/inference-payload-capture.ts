import { randomUUID } from "crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, runOutsideDatabaseTransaction, withDatabaseLane } from "./db";
import { createLogger } from "./log";
import { getCurrentPrincipal, requireCurrentUserPrincipal } from "./principal-context";
import { ownedInsertValues, visibleScopePredicate } from "./scoped-storage";
import { inferencePayloadCaptures } from "@shared/schema";
import type {
  InferencePayloadCapture,
  InferencePayloadCaptureSummary,
} from "@shared/inference-payload";

const log = createLogger("inference-payload-capture");
export const INFERENCE_PAYLOAD_RETENTION_LIMIT = 20;

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
    log.error(`provider payload decode failed: ${formatErrorChain(error)}`);
    throw new Error("Inference payload capture is unreadable");
  }
}

function formatErrorChain(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 4; depth++) {
    if (seen.has(current)) break;
    seen.add(current);
    if (current instanceof Error) {
      const code = typeof (current as Error & { code?: unknown }).code === "string"
        ? ` code=${(current as Error & { code: string }).code}`
        : "";
      messages.push(`${current.message}${code}`);
      current = (current as Error & { cause?: unknown }).cause;
      continue;
    }
    messages.push(String(current));
    break;
  }
  return messages.join(" <- ");
}

function toSummary(row: typeof inferencePayloadCaptures.$inferSelect): InferencePayloadCaptureSummary {
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
            attempt: input.attempt ?? 1,
            metadata: input.metadata ?? {},
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
    log.debug(`captured provider payload id=${id} provider=${input.provider} boundary=${input.boundary} chars=${requestChars}`);
    return id;
  } catch (error) {
    log.error(`provider payload capture failed provider=${input.provider} boundary=${input.boundary}: ${formatErrorChain(error)}`);
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
    .select()
    .from(inferencePayloadCaptures)
    .where(and(
      visible,
      eq(inferencePayloadCaptures.ownerUserId, principal.userId),
      eq(inferencePayloadCaptures.accountId, principal.accountId),
    ))
    .orderBy(desc(inferencePayloadCaptures.capturedAt), desc(inferencePayloadCaptures.id))
    .limit(boundedLimit);
  return rows.map(toSummary);
}

export async function getInferencePayloadCapture(id: string): Promise<InferencePayloadCapture | null> {
  const principal = requireCurrentUserPrincipal();
  const scope = visibleScopePredicate(principal, {
    scope: inferencePayloadCaptures.scope,
    ownerUserId: inferencePayloadCaptures.ownerUserId,
    accountId: inferencePayloadCaptures.accountId,
  });
  const [row] = await db
    .select()
    .from(inferencePayloadCaptures)
    .where(and(
      eq(inferencePayloadCaptures.id, id),
      scope,
      eq(inferencePayloadCaptures.ownerUserId, principal.userId),
      eq(inferencePayloadCaptures.accountId, principal.accountId),
    ))
    .limit(1);
  if (!row) return null;
  return {
    ...toSummary(row),
    request: decodeProviderRequest(row.request),
    evidence: {
      authority: row.authority,
      observableBoundary: row.observableBoundary,
      excludedSensitiveFields: row.excludedSensitiveFields,
      residualLimitation: row.residualLimitation,
    },
    metadata: row.metadata,
  };
}
