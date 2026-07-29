import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import {
  meetingTurnEnrollments,
  type MeetingTurnEnrollment,
} from "@shared/schema";
import { db } from "../db";
import { chatStorage } from "../integrations/chat/storage";
import { createLogger } from "../log";
import type { Principal } from "../principal";
import { getCurrentPrincipal } from "../principal-context";
import { getPostgresErrorDetails } from "../postgres-errors";
import {
  combineWithVisibleScope,
  combineWithWritableScope,
  ownedInsertValues,
} from "../scoped-storage";
import { runWithMeetingOwnerIdentity } from "./owner-principal";
import { appendMeetingTurnFragment, type MeetingTurnRecord } from "./turn-queue";

const log = createLogger("MeetingTurnEnrollment");
const MAX_INLINE_ATTEMPTS = 1;
const MAX_TOTAL_ATTEMPTS = 8;
const RETRY_BASE_MS = 50;
const RECOVERY_LEASE_MS = 30_000;
const TRANSIENT_POSTGRES_CODES = new Set(["40P01", "40001"]);

const enrollmentScope = {
  scope: meetingTurnEnrollments.scope,
  ownerUserId: meetingTurnEnrollments.ownerUserId,
  accountId: meetingTurnEnrollments.accountId,
};

export interface MeetingTurnEnrollmentInput {
  sessionId: string;
  sessionKey: string;
  sourceTurnId: string;
  sourceMessageId: string;
  speakerKey: string;
  speakerLabel: string;
  participationMode?: "contextual" | "always";
  executionAffinityBootId?: string;
}

export interface MeetingTurnEnrollmentOwnerIdentity {
  sessionId: string;
  sourceTurnId: string;
  ownerUserId: string;
  accountId: string;
}

export type MeetingTurnEnrollmentResult =
  | { outcome: "enrolled"; turn: MeetingTurnRecord }
  | { outcome: "pending" }
  | { outcome: "failed" };

function requireMeetingOwnerPrincipal(): Principal & { userId: string; accountId: string } {
  const principal = getCurrentPrincipal();
  if (principal?.actorType !== "user" || !principal.userId || !principal.accountId) {
    throw new Error("Meeting turn enrollment mutations require a user principal");
  }
  return principal as Principal & { userId: string; accountId: string };
}

function requireMeetingWorkerPrincipal(): Principal {
  const principal = getCurrentPrincipal();
  if (principal?.actorType !== "system" || principal.jobName !== "meeting-turn-worker") {
    throw new Error("Global meeting turn enrollment scans require the named meeting-turn-worker principal");
  }
  return principal;
}

function writableEnrollment(principal: Principal, predicate?: ReturnType<typeof and>) {
  return combineWithWritableScope(principal, enrollmentScope, predicate);
}

function visibleEnrollment(principal: Principal, predicate?: ReturnType<typeof and>) {
  return combineWithVisibleScope(principal, enrollmentScope, predicate);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Must run inside the canonical chat-document transaction. */
export async function ensurePendingMeetingTurnEnrollment(
  input: MeetingTurnEnrollmentInput,
): Promise<void> {
  const principal = requireMeetingOwnerPrincipal();
  const ownership = ownedInsertValues(principal, enrollmentScope);
  await db
    .insert(meetingTurnEnrollments)
    .values({
      sessionId: input.sessionId,
      sessionKey: input.sessionKey,
      scope: "user",
      ownerUserId: ownership.ownerUserId || principal.userId,
      accountId: ownership.accountId || principal.accountId,
      sourceTurnId: input.sourceTurnId,
      sourceMessageId: input.sourceMessageId,
      speakerKey: input.speakerKey,
      speakerLabel: input.speakerLabel,
      participationMode: input.participationMode || "contextual",
      executionAffinityBootId: input.executionAffinityBootId || null,
      status: "pending",
      nextAttemptAt: new Date(),
    })
    .onConflictDoNothing({
      target: [
        meetingTurnEnrollments.ownerUserId,
        meetingTurnEnrollments.accountId,
        meetingTurnEnrollments.sessionId,
        meetingTurnEnrollments.sourceTurnId,
      ],
    });
}

async function getEnrollment(
  principal: Principal,
  sessionId: string,
  sourceTurnId: string,
): Promise<MeetingTurnEnrollment | null> {
  const [row] = await db
    .select()
    .from(meetingTurnEnrollments)
    .where(
      writableEnrollment(
        principal,
        and(
          eq(meetingTurnEnrollments.sessionId, sessionId),
          eq(meetingTurnEnrollments.sourceTurnId, sourceTurnId),
        ),
      ),
    )
    .limit(1);
  return row || null;
}

async function resolveTranscriptText(row: MeetingTurnEnrollment): Promise<string | null> {
  const session = await chatStorage.getSession(row.sessionId);
  const message = session?.messages.find((candidate) => candidate.id === row.sourceMessageId);
  return message?.role === "user" && message.turnId === row.sourceTurnId
    ? message.content.trim() || null
    : null;
}

async function claimEnrollmentAttempt(
  principal: Principal,
  row: MeetingTurnEnrollment,
): Promise<boolean> {
  const [claimed] = await db
    .update(meetingTurnEnrollments)
    .set({
      attemptCount: sql`${meetingTurnEnrollments.attemptCount} + 1`,
      nextAttemptAt: new Date(Date.now() + RECOVERY_LEASE_MS),
      lastAttemptAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      writableEnrollment(
        principal,
        and(
          eq(meetingTurnEnrollments.id, row.id),
          eq(meetingTurnEnrollments.status, "pending"),
          lte(meetingTurnEnrollments.nextAttemptAt, new Date()),
        ),
      ),
    )
    .returning({ id: meetingTurnEnrollments.id });
  return Boolean(claimed);
}

async function markEnrolled(
  principal: Principal,
  row: MeetingTurnEnrollment,
  turnId: string,
  attempts: number,
): Promise<void> {
  await db
    .update(meetingTurnEnrollments)
    .set({
      status: "enrolled",
      enrolledTurnId: turnId,
      attemptCount: sql`${meetingTurnEnrollments.attemptCount} + ${Math.max(0, attempts - 1)}`,
      lastAttemptAt: new Date(),
      postgresCode: null,
      errorType: null,
      enrolledAt: new Date(),
      failedAt: null,
      updatedAt: new Date(),
    })
    .where(
      writableEnrollment(
        principal,
        and(
          eq(meetingTurnEnrollments.id, row.id),
          inArray(meetingTurnEnrollments.status, ["pending", "enrolled"]),
        ),
      ),
    );
}

async function markAttemptFailure(
  principal: Principal,
  row: MeetingTurnEnrollment,
  attempts: number,
  error: unknown,
  transient: boolean,
): Promise<"pending" | "failed"> {
  const details = getPostgresErrorDetails(error);
  const totalAttempts = row.attemptCount + attempts;
  const staysPending = transient && totalAttempts < MAX_TOTAL_ATTEMPTS;
  const outcome = staysPending ? "pending" : "failed";
  const nextAttemptAt = new Date(
    Date.now() + Math.min(30_000, RETRY_BASE_MS * 2 ** Math.min(totalAttempts, 9)),
  );
  await db
    .update(meetingTurnEnrollments)
    .set({
      status: outcome,
      attemptCount: sql`${meetingTurnEnrollments.attemptCount} + ${Math.max(0, attempts - 1)}`,
      nextAttemptAt,
      lastAttemptAt: new Date(),
      postgresCode: details.code,
      errorType: details.errorType.slice(0, 120),
      failedAt: staysPending ? null : new Date(),
      updatedAt: new Date(),
    })
    .where(
      writableEnrollment(
        principal,
        and(
          eq(meetingTurnEnrollments.id, row.id),
          eq(meetingTurnEnrollments.status, "pending"),
        ),
      ),
    );
  const fields = {
    enrollmentId: row.id,
    sessionId: row.sessionId,
    sourceTurnId: row.sourceTurnId,
    outcome,
    postgresCode: details.code,
    errorType: details.errorType,
    causeDepth: details.causeDepth,
    attempts: totalAttempts,
  };
  if (staysPending) log.warn("meeting turn enrollment deferred", fields);
  else log.error("meeting turn enrollment failed", fields);
  return outcome;
}

export async function processMeetingTurnEnrollment(
  sessionId: string,
  sourceTurnId: string,
  transcriptText?: string,
): Promise<MeetingTurnEnrollmentResult> {
  const principal = requireMeetingOwnerPrincipal();
  const row = await getEnrollment(principal, sessionId, sourceTurnId);
  if (!row) throw new Error("Meeting turn enrollment receipt not found");
  if (row.status === "enrolled") {
    const turn = await appendMeetingTurnFragment({
      sessionId: row.sessionId,
      sessionKey: row.sessionKey,
      speakerKey: row.speakerKey,
      speakerLabel: row.speakerLabel,
      participationMode: row.participationMode === "always" ? "always" : "contextual",
      ...(row.executionAffinityBootId ? { executionAffinityBootId: row.executionAffinityBootId } : {}),
      text: transcriptText || await resolveTranscriptText(row) || "",
      sourceTurnId: row.sourceTurnId,
      sourceMessageId: row.sourceMessageId,
    });
    return { outcome: "enrolled", turn };
  }
  if (row.status === "failed") return { outcome: "failed" };
  if (!await claimEnrollmentAttempt(principal, row)) return { outcome: "pending" };

  const text = transcriptText?.trim() || await resolveTranscriptText(row);
  if (!text) {
    await markAttemptFailure(principal, row, 1, new Error("Canonical transcript message is unavailable"), false);
    return { outcome: "failed" };
  }

  let attempts = 0;
  while (attempts < MAX_INLINE_ATTEMPTS) {
    attempts += 1;
    try {
      const turn = await appendMeetingTurnFragment({
        sessionId: row.sessionId,
        sessionKey: row.sessionKey,
        speakerKey: row.speakerKey,
        speakerLabel: row.speakerLabel,
        participationMode: row.participationMode === "always" ? "always" : "contextual",
        ...(row.executionAffinityBootId ? { executionAffinityBootId: row.executionAffinityBootId } : {}),
        text,
        sourceTurnId: row.sourceTurnId,
        sourceMessageId: row.sourceMessageId,
      });
      await markEnrolled(principal, row, turn.id, attempts);
      return { outcome: "enrolled", turn };
    } catch (error) {
      const details = getPostgresErrorDetails(error);
      const transient = TRANSIENT_POSTGRES_CODES.has(details.code);
      if (transient && attempts < MAX_INLINE_ATTEMPTS) {
        log.debug("retrying transient meeting turn enrollment", {
          enrollmentId: row.id,
          postgresCode: details.code,
          attempt: attempts,
        });
        await delay(RETRY_BASE_MS * attempts);
        continue;
      }
      const outcome = await markAttemptFailure(principal, row, attempts, error, transient);
      return { outcome };
    }
  }
  return { outcome: "pending" };
}

export async function recoverPendingMeetingTurnEnrollments(limit = 20): Promise<number> {
  const principal = requireMeetingWorkerPrincipal();
  const bounded = Math.max(1, Math.min(limit, 100));
  const rows = await db
    .select({
      sessionId: meetingTurnEnrollments.sessionId,
      sourceTurnId: meetingTurnEnrollments.sourceTurnId,
      ownerUserId: meetingTurnEnrollments.ownerUserId,
      accountId: meetingTurnEnrollments.accountId,
    })
    .from(meetingTurnEnrollments)
    .where(
      visibleEnrollment(
        principal,
        and(
          eq(meetingTurnEnrollments.status, "pending"),
          lte(meetingTurnEnrollments.nextAttemptAt, new Date()),
        ),
      ),
    )
    .orderBy(asc(meetingTurnEnrollments.nextAttemptAt))
    .limit(bounded);

  let processed = 0;
  for (const row of rows) {
    try {
      await runWithMeetingOwnerIdentity(row, () =>
        processMeetingTurnEnrollment(row.sessionId, row.sourceTurnId),
      );
      processed += 1;
    } catch (error) {
      const details = getPostgresErrorDetails(error);
      log.error("meeting turn enrollment recovery crashed", {
        sessionId: row.sessionId,
        sourceTurnId: row.sourceTurnId,
        postgresCode: details.code,
        errorType: details.errorType,
        causeDepth: details.causeDepth,
      });
    }
  }
  return processed;
}
