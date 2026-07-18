import { randomUUID } from "crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { meetingTurns, type MeetingTurn } from "@shared/schema";
import { BOOT_ID, db, fnv1a32 } from "../db";
import { createLogger } from "../log";
import type { Principal } from "../principal";
import { getCurrentPrincipal } from "../principal-context";
import {
  combineWithVisibleScope,
  combineWithWritableScope,
  ownedInsertValues,
} from "../scoped-storage";
import type { MeetingParticipationDecision } from "./addressed-turn";

const log = createLogger("MeetingTurnQueue");
const TURN_LOCK_NAMESPACE = 0x4d54524e; // 'MTRN'
export const MEETING_TURN_QUIET_MS = 1_200;
export const MEETING_TURN_INCOMPLETE_RETRY_MS = 1_500;
const MAX_APPEND_GAP_MS = 12_000;
const PARTICIPATION_LEASE_MS = 30_000;
const EXECUTION_LEASE_MS = 45 * 60_000;
const MAX_EXECUTION_ATTEMPTS = 3;
const CONTENTION_RETRY_MS = 1_000;

const meetingTurnScope = {
  scope: meetingTurns.scope,
  ownerUserId: meetingTurns.ownerUserId,
  accountId: meetingTurns.accountId,
};

type DrizzleTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface MeetingTurnOwnerIdentity {
  sessionId: string;
  ownerUserId: string;
  accountId: string;
}

export interface MeetingTurnRecord {
  id: string;
  sessionId: string;
  sessionKey: string;
  ownerUserId: string;
  accountId: string;
  speakerKey: string;
  speakerLabel: string;
  participationMode: "contextual" | "always";
  executionAffinityBootId: string | null;
  text: string;
  sourceTurnIds: string[];
  sourceMessageIds: string[];
  revision: number;
  assemblyStatus: "collecting" | "complete";
  participationStatus: "pending" | "claimed" | "respond" | "silent" | "failed";
  executionStatus: "waiting" | "pending" | "claimed" | "completed" | "failed" | "not_applicable";
  prompt: string | null;
  completenessDeferrals: number;
  readyAt: Date;
  claimToken: string | null;
  attemptCount: number;
}

function mapTurn(row: MeetingTurn): MeetingTurnRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    sessionKey: row.sessionKey,
    ownerUserId: row.ownerUserId,
    accountId: row.accountId,
    speakerKey: row.speakerKey,
    speakerLabel: row.speakerLabel,
    participationMode: row.participationMode === "always" ? "always" : "contextual",
    executionAffinityBootId: row.executionAffinityBootId,
    text: row.text,
    sourceTurnIds: row.sourceTurnIds,
    sourceMessageIds: row.sourceMessageIds,
    revision: row.revision,
    assemblyStatus: row.assemblyStatus,
    participationStatus: row.participationStatus,
    executionStatus: row.executionStatus,
    prompt: row.prompt,
    completenessDeferrals: row.completenessDeferrals,
    readyAt: row.readyAt,
    claimToken: row.claimToken,
    attemptCount: row.attemptCount,
  };
}

function requireMeetingWorkerPrincipal(): Principal {
  const principal = getCurrentPrincipal();
  if (principal?.actorType !== "system" || principal.jobName !== "meeting-turn-worker") {
    throw new Error("Global meeting turn scans require the named meeting-turn-worker principal");
  }
  return principal;
}

function requireMeetingOwnerPrincipal(): Principal & { userId: string; accountId: string } {
  const principal = getCurrentPrincipal();
  if (principal?.actorType !== "user" || !principal.userId || !principal.accountId) {
    throw new Error("Meeting turn mutations require a user principal");
  }
  return principal as Principal & { userId: string; accountId: string };
}

function visibleMeeting(principal: Principal, predicate?: SQL): SQL {
  return combineWithVisibleScope(principal, meetingTurnScope, predicate);
}

function writableMeeting(principal: Principal, predicate?: SQL): SQL {
  return combineWithWritableScope(principal, meetingTurnScope, predicate);
}

async function lockSession(tx: DrizzleTx, sessionId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${TURN_LOCK_NAMESPACE}::int4, ${fnv1a32(sessionId)}::int4)`,
  );
}

function executableOnThisBoot(): SQL {
  return or(
    sql`${meetingTurns.executionAffinityBootId} IS NULL`,
    eq(meetingTurns.executionAffinityBootId, BOOT_ID),
  )!;
}

export async function appendMeetingTurnFragment(input: {
  sessionId: string;
  sessionKey: string;
  speakerKey: string;
  speakerLabel: string;
  participationMode?: "contextual" | "always";
  executionAffinityBootId?: string;
  text: string;
  sourceTurnId: string;
  sourceMessageId: string;
}): Promise<MeetingTurnRecord> {
  const principal = requireMeetingOwnerPrincipal();
  return db.transaction(async (tx) => {
    await lockSession(tx, input.sessionId);

    const [duplicate] = await tx
      .select()
      .from(meetingTurns)
      .where(
        writableMeeting(
          principal,
          and(
            eq(meetingTurns.sessionId, input.sessionId),
            sql`${input.sourceTurnId} = ANY(${meetingTurns.sourceTurnIds})`,
          ),
        ),
      )
      .orderBy(desc(meetingTurns.createdAt))
      .limit(1);
    if (duplicate) return mapTurn(duplicate);

    const [open] = await tx
      .select()
      .from(meetingTurns)
      .where(
        writableMeeting(
          principal,
          and(
            eq(meetingTurns.sessionId, input.sessionId),
            inArray(meetingTurns.executionStatus, ["waiting", "pending"]),
          ),
        ),
      )
      .orderBy(desc(meetingTurns.lastFragmentAt))
      .limit(1)
      .for("update");

    const affinity = input.executionAffinityBootId || null;
    const canAppend = Boolean(
      open
        && open.speakerKey === input.speakerKey
        && open.participationMode === (input.participationMode || "contextual")
        && open.executionAffinityBootId === affinity
        && Date.now() - open.lastFragmentAt.getTime() <= MAX_APPEND_GAP_MS,
    );
    const readyAt = new Date(
      Date.now() + (input.participationMode === "always" ? 0 : MEETING_TURN_QUIET_MS),
    );

    if (canAppend && open) {
      const [updated] = await tx
        .update(meetingTurns)
        .set({
          text: sql`CONCAT_WS(' ', NULLIF(${meetingTurns.text}, ''), ${input.text.trim()})`,
          sourceTurnIds: sql`array_append(${meetingTurns.sourceTurnIds}, ${input.sourceTurnId})`,
          sourceMessageIds: sql`array_append(${meetingTurns.sourceMessageIds}, ${input.sourceMessageId})`,
          speakerLabel: input.speakerLabel,
          revision: sql`${meetingTurns.revision} + 1`,
          assemblyStatus: "collecting",
          participationStatus: "pending",
          executionStatus: "waiting",
          participationDecision: null,
          prompt: null,
          readyAt,
          lastFragmentAt: new Date(),
          claimToken: null,
          claimedAt: null,
          claimExpiresAt: null,
          error: null,
          updatedAt: new Date(),
        })
        .where(
          writableMeeting(
            principal,
            and(eq(meetingTurns.id, open.id), eq(meetingTurns.revision, open.revision)),
          ),
        )
        .returning();
      if (!updated) throw new Error(`Meeting turn ${open.id} changed during append`);
      log.debug(
        `fragment appended sessionId=${input.sessionId} turnId=${updated.id} revision=${updated.revision}`,
      );
      return mapTurn(updated);
    }

    const ownership = ownedInsertValues(principal, meetingTurnScope);
    const [created] = await tx
      .insert(meetingTurns)
      .values({
        sessionId: input.sessionId,
        sessionKey: input.sessionKey,
        scope: "user",
        ownerUserId: ownership.ownerUserId || principal.userId,
        accountId: ownership.accountId || principal.accountId,
        speakerKey: input.speakerKey,
        speakerLabel: input.speakerLabel,
        participationMode: input.participationMode || "contextual",
        executionAffinityBootId: affinity,
        text: input.text.trim(),
        sourceTurnIds: [input.sourceTurnId],
        sourceMessageIds: [input.sourceMessageId],
        readyAt,
      })
      .returning();
    log.debug(
      `fragment created sessionId=${input.sessionId} turnId=${created.id} revision=${created.revision}`,
    );
    return mapTurn(created);
  });
}

export async function claimReadyMeetingTurn(sessionId: string): Promise<MeetingTurnRecord | null> {
  const principal = requireMeetingOwnerPrincipal();
  return db.transaction(async (tx) => {
    await lockSession(tx, sessionId);
    const [candidate] = await tx
      .select()
      .from(meetingTurns)
      .where(
        writableMeeting(
          principal,
          and(
            eq(meetingTurns.sessionId, sessionId),
            eq(meetingTurns.assemblyStatus, "collecting"),
            eq(meetingTurns.participationStatus, "pending"),
            lte(meetingTurns.readyAt, new Date()),
            executableOnThisBoot(),
          ),
        ),
      )
      .orderBy(asc(meetingTurns.readyAt))
      .limit(1)
      .for("update");
    if (!candidate) return null;
    const [claimed] = await tx
      .update(meetingTurns)
      .set({
        assemblyStatus: "complete",
        participationStatus: "claimed",
        claimToken: randomUUID(),
        claimedAt: new Date(),
        claimExpiresAt: new Date(Date.now() + PARTICIPATION_LEASE_MS),
        updatedAt: new Date(),
      })
      .where(
        writableMeeting(
          principal,
          and(
            eq(meetingTurns.id, candidate.id),
            eq(meetingTurns.revision, candidate.revision),
            eq(meetingTurns.participationStatus, "pending"),
          ),
        ),
      )
      .returning();
    return claimed ? mapTurn(claimed) : null;
  });
}

export async function deferIncompleteMeetingTurn(turn: MeetingTurnRecord): Promise<boolean> {
  const principal = requireMeetingOwnerPrincipal();
  const [updated] = await db
    .update(meetingTurns)
    .set({
      assemblyStatus: "collecting",
      participationStatus: "pending",
      executionStatus: "waiting",
      completenessDeferrals: sql`${meetingTurns.completenessDeferrals} + 1`,
      readyAt: new Date(Date.now() + MEETING_TURN_INCOMPLETE_RETRY_MS),
      participationDecision: null,
      prompt: null,
      claimToken: null,
      claimedAt: null,
      claimExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      writableMeeting(
        principal,
        and(
          eq(meetingTurns.id, turn.id),
          eq(meetingTurns.revision, turn.revision),
          eq(meetingTurns.claimToken, turn.claimToken || ""),
          eq(meetingTurns.participationStatus, "claimed"),
        ),
      ),
    )
    .returning({ id: meetingTurns.id });
  return Boolean(updated);
}

export async function recordMeetingParticipation(
  turn: MeetingTurnRecord,
  decision: MeetingParticipationDecision,
): Promise<"recorded" | "superseded"> {
  const principal = requireMeetingOwnerPrincipal();
  const shouldRespond = decision.shouldRespond && Boolean(decision.prompt);
  const [updated] = await db
    .update(meetingTurns)
    .set({
      participationStatus: shouldRespond ? "respond" : "silent",
      executionStatus: shouldRespond ? "pending" : "not_applicable",
      participationDecision: decision,
      prompt: shouldRespond ? decision.prompt : null,
      claimToken: null,
      claimedAt: null,
      claimExpiresAt: null,
      completedAt: shouldRespond ? null : new Date(),
      updatedAt: new Date(),
    })
    .where(
      writableMeeting(
        principal,
        and(
          eq(meetingTurns.id, turn.id),
          eq(meetingTurns.revision, turn.revision),
          eq(meetingTurns.claimToken, turn.claimToken || ""),
          eq(meetingTurns.participationStatus, "claimed"),
        ),
      ),
    )
    .returning({ id: meetingTurns.id });
  return updated ? "recorded" : "superseded";
}

export async function claimPendingMeetingTurnExecution(
  sessionId: string,
): Promise<MeetingTurnRecord | null> {
  const principal = requireMeetingOwnerPrincipal();
  return db.transaction(async (tx) => {
    await lockSession(tx, sessionId);
    const [active] = await tx
      .select({ id: meetingTurns.id })
      .from(meetingTurns)
      .where(
        writableMeeting(
          principal,
          and(
            eq(meetingTurns.sessionId, sessionId),
            eq(meetingTurns.executionStatus, "claimed"),
          ),
        ),
      )
      .limit(1)
      .for("update");
    if (active) return null;

    const [candidate] = await tx
      .select()
      .from(meetingTurns)
      .where(
        writableMeeting(
          principal,
          and(
            eq(meetingTurns.sessionId, sessionId),
            eq(meetingTurns.participationStatus, "respond"),
            eq(meetingTurns.executionStatus, "pending"),
            lte(meetingTurns.readyAt, new Date()),
            executableOnThisBoot(),
          ),
        ),
      )
      .orderBy(asc(meetingTurns.createdAt))
      .limit(1)
      .for("update");
    if (!candidate) return null;

    const token = randomUUID();
    const [claimed] = await tx
      .update(meetingTurns)
      .set({
        executionStatus: "claimed",
        claimToken: token,
        claimedAt: new Date(),
        claimExpiresAt: new Date(Date.now() + EXECUTION_LEASE_MS),
        attemptCount: sql`${meetingTurns.attemptCount} + 1`,
        updatedAt: new Date(),
      })
      .where(
        writableMeeting(
          principal,
          and(
            eq(meetingTurns.id, candidate.id),
            eq(meetingTurns.executionStatus, "pending"),
          ),
        ),
      )
      .returning();
    return claimed ? mapTurn(claimed) : null;
  });
}

export async function releaseMeetingTurnExecutionClaim(
  turn: MeetingTurnRecord,
  reason: string,
): Promise<boolean> {
  const principal = requireMeetingOwnerPrincipal();
  const [updated] = await db
    .update(meetingTurns)
    .set({
      executionStatus: "pending",
      claimToken: null,
      claimedAt: null,
      claimExpiresAt: null,
      attemptCount: sql`GREATEST(${meetingTurns.attemptCount} - 1, 0)`,
      readyAt: new Date(Date.now() + CONTENTION_RETRY_MS),
      error: reason.slice(0, 1000),
      updatedAt: new Date(),
    })
    .where(
      writableMeeting(
        principal,
        and(
          eq(meetingTurns.id, turn.id),
          eq(meetingTurns.claimToken, turn.claimToken || ""),
          eq(meetingTurns.executionStatus, "claimed"),
        ),
      ),
    )
    .returning({ id: meetingTurns.id });
  return Boolean(updated);
}

export async function finishMeetingTurnExecution(input: {
  turn: MeetingTurnRecord;
  status: "completed" | "failed";
  assistantMessageId?: string;
  error?: string;
}): Promise<boolean> {
  const principal = requireMeetingOwnerPrincipal();
  const [updated] = await db
    .update(meetingTurns)
    .set({
      executionStatus: input.status,
      assistantMessageId: input.assistantMessageId || null,
      error: input.error?.slice(0, 1000) || null,
      completedAt: new Date(),
      claimExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      writableMeeting(
        principal,
        and(
          eq(meetingTurns.id, input.turn.id),
          eq(meetingTurns.claimToken, input.turn.claimToken || ""),
          eq(meetingTurns.executionStatus, "claimed"),
        ),
      ),
    )
    .returning({ id: meetingTurns.id });
  return Boolean(updated);
}

export async function failMeetingParticipation(
  turn: MeetingTurnRecord,
  error: string,
): Promise<void> {
  const principal = requireMeetingOwnerPrincipal();
  await db
    .update(meetingTurns)
    .set({
      participationStatus: "failed",
      executionStatus: "not_applicable",
      error: error.slice(0, 1000),
      claimToken: null,
      claimedAt: null,
      claimExpiresAt: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      writableMeeting(
        principal,
        and(
          eq(meetingTurns.id, turn.id),
          eq(meetingTurns.revision, turn.revision),
          eq(meetingTurns.claimToken, turn.claimToken || ""),
          eq(meetingTurns.participationStatus, "claimed"),
        ),
      ),
    );
}

export async function recoverStaleMeetingTurnClaims(): Promise<number> {
  const principal = requireMeetingWorkerPrincipal();
  const now = new Date();
  const participationRows = await db
    .update(meetingTurns)
    .set({
      assemblyStatus: "collecting",
      participationStatus: "pending",
      executionStatus: "waiting",
      claimToken: null,
      claimedAt: null,
      claimExpiresAt: null,
      readyAt: now,
      error: "Recovered expired participation claim",
      updatedAt: now,
    })
    .where(
      writableMeeting(
        principal,
        and(
          eq(meetingTurns.participationStatus, "claimed"),
          lte(meetingTurns.claimExpiresAt, now),
          executableOnThisBoot(),
        ),
      ),
    )
    .returning({ id: meetingTurns.id });

  const executionRows = await db
    .update(meetingTurns)
    .set({
      executionStatus: sql`CASE WHEN ${meetingTurns.attemptCount} < ${MAX_EXECUTION_ATTEMPTS} THEN 'pending' ELSE 'failed' END`,
      claimToken: null,
      claimedAt: null,
      claimExpiresAt: null,
      error: sql`CASE WHEN ${meetingTurns.attemptCount} < ${MAX_EXECUTION_ATTEMPTS} THEN 'Recovered expired execution claim' ELSE 'Execution claim expired too many times' END`,
      completedAt: sql`CASE WHEN ${meetingTurns.attemptCount} < ${MAX_EXECUTION_ATTEMPTS} THEN ${meetingTurns.completedAt} ELSE CURRENT_TIMESTAMP END`,
      updatedAt: now,
    })
    .where(
      writableMeeting(
        principal,
        and(
          eq(meetingTurns.executionStatus, "claimed"),
          lte(meetingTurns.claimExpiresAt, now),
          executableOnThisBoot(),
        ),
      ),
    )
    .returning({ id: meetingTurns.id });
  const recovered = participationRows.length + executionRows.length;
  if (recovered > 0) {
    log.warn(
      `recovered meeting turn claims participation=${participationRows.length} execution=${executionRows.length}`,
    );
  }
  return recovered;
}

export async function failPendingAffinityMeetingTurns(
  sessionId: string,
  bootId: string,
  reason: string,
): Promise<number> {
  const principal = requireMeetingOwnerPrincipal();
  const rows = await db
    .update(meetingTurns)
    .set({
      participationStatus: "failed",
      executionStatus: "failed",
      claimToken: null,
      claimedAt: null,
      claimExpiresAt: null,
      error: reason.slice(0, 1000),
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      writableMeeting(
        principal,
        and(
          eq(meetingTurns.sessionId, sessionId),
          eq(meetingTurns.executionAffinityBootId, bootId),
          inArray(meetingTurns.executionStatus, ["waiting", "pending"]),
        ),
      ),
    )
    .returning({ id: meetingTurns.id });
  return rows.length;
}

export async function listActionableMeetingSessions(limit = 20): Promise<MeetingTurnOwnerIdentity[]> {
  const principal = requireMeetingWorkerPrincipal();
  const bounded = Math.max(1, Math.min(limit, 100));
  const rows = await db
    .select({
      sessionId: meetingTurns.sessionId,
      ownerUserId: meetingTurns.ownerUserId,
      accountId: meetingTurns.accountId,
      readyAt: meetingTurns.readyAt,
    })
    .from(meetingTurns)
    .where(
      visibleMeeting(
        principal,
        and(
          executableOnThisBoot(),
          or(
            and(
              eq(meetingTurns.assemblyStatus, "collecting"),
              eq(meetingTurns.participationStatus, "pending"),
              lte(meetingTurns.readyAt, new Date()),
            ),
            and(
              eq(meetingTurns.participationStatus, "respond"),
              eq(meetingTurns.executionStatus, "pending"),
              lte(meetingTurns.readyAt, new Date()),
            ),
          ),
        ),
      ),
    )
    .orderBy(asc(meetingTurns.readyAt))
    .limit(bounded * 4);

  const unique = new Map<string, MeetingTurnOwnerIdentity>();
  for (const row of rows) {
    if (!unique.has(row.sessionId)) {
      unique.set(row.sessionId, {
        sessionId: row.sessionId,
        ownerUserId: row.ownerUserId,
        accountId: row.accountId,
      });
      if (unique.size >= bounded) break;
    }
  }
  return Array.from(unique.values());
}
