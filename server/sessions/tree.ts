import { db, pool } from "../db";
import { sessionTree, type SessionTreeRow } from "@shared/schema";
import { eq, and, sql, isNull, inArray } from "drizzle-orm";
import { createLogger } from "../log";
import { createHash } from "node:crypto";
import type { TriggerType } from "@shared/models/chat";

const log = createLogger("SessionTree");

export interface SpawnRecord {
  sessionId: string;
  parentSessionId: string | null;
  spawnReason: string | null;
  spawnerTool: string | null;
  spawnerSkillRun: string | null;
}

export interface SpawnChildSessionOptions {
  /**
   * Identifier of the skill/model to invoke for the child session. This is
   * the "model" of behavior the child runs (e.g. a skill ID like "council").
   * `skillId` is accepted as a backwards-compatible alias.
   */
  model?: string;
  skillId?: string;
  spawnReason: string;
  spawnerTool?: string;
  spawnerSkillRun?: string;
  preContext?: string;
  waitForCompletion?: boolean;
  /**
   * Optional explicit model identifier (e.g. "anthropic/claude-opus-4-6").
   * When set, the runner will pin the agent executor to this model instead
   * of routing by the skill's activity tier. Used by Council to fan a
   * single skill ("advocate") into per-provider frontier-tier runs.
   */
  modelOverride?: string;
  /**
   * Optional override for the per-call `session_key` written to `api_calls`
   * by `cost-tracker`. Defaults to `auto:${skillId}` inside the runner.
   * Used by Council to scope cumulative cost/token aggregation per run.
   */
  sessionKeyOverride?: string;
  /**
   * Optional human-readable title for the spawned child session. Forwarded
   * to the runner which uses it in place of the skill's default label.
   * Used by Council to encode per-round role context (e.g. "Advocate A — Round 2")
   * directly in the sidebar.
   */
  titleOverride?: string;
  /** Provenance: override trigger type for the spawned session */
  hookTriggerId?: string;
  hookTriggerName?: string;
}

export interface SpawnChildSessionResult {
  sessionId: string;
  status?: "succeeded" | "failed" | "yielded";
  summary?: string;
  /** Final assistant message text from the child session (populated when awaited). */
  output?: string;
  error?: string;
  durationMs?: number;
  reused?: boolean;
}

type SessionTreeSqlRow = {
  session_id: string;
  parent_session_id: string | null;
  spawn_reason: string | null;
  spawner_tool: string | null;
  spawner_skill_run: string | null;
  spawn_status: string | null;
  created_at: Date;
  updated_at: Date;
} & Record<string, unknown>;

function sqlRowToTreeRow(r: SessionTreeSqlRow): SessionTreeRow {
  return {
    sessionId: r.session_id,
    parentSessionId: r.parent_session_id,
    spawnReason: r.spawn_reason,
    spawnerTool: r.spawner_tool,
    spawnerSkillRun: r.spawner_skill_run,
    spawnStatus: r.spawn_status ?? "succeeded",
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Hash a spawn tuple into a 63-bit signed integer suitable for
 * pg_advisory_lock. Uses sha256 for collision resistance and truncates to
 * 8 bytes interpreted as a bigint.
 */
function spawnLockKey(parentId: string, spawnReason: string, spawnerSkillRun: string): bigint {
  const hash = createHash("sha256").update(`${parentId}|${spawnReason}|${spawnerSkillRun}`).digest();
  // Use only the low 63 bits to stay within positive bigint range
  let n = 0n;
  for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(hash[i]);
  return n & 0x7fffffffffffffffn;
}

/**
 * Acquire a Postgres session-level advisory lock pinned to a single connection
 * for the duration of `fn`. Releases the lock on exit. When `spawnerSkillRun`
 * is missing the caller has opted out of idempotency, so we run unlocked.
 */
async function withSpawnLock<T>(
  parentId: string,
  spawnReason: string | undefined,
  spawnerSkillRun: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!spawnReason || !spawnerSkillRun) return fn();
  const key = spawnLockKey(parentId, spawnReason, spawnerSkillRun);
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [key.toString()]);
    return await fn();
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [key.toString()]);
    } catch {
      /* ignore */
    }
    client.release();
  }
}

export async function upsertSessionTreeRow(record: SpawnRecord): Promise<void> {
  try {
    await db
      .insert(sessionTree)
      .values({
        sessionId: record.sessionId,
        parentSessionId: record.parentSessionId,
        spawnReason: record.spawnReason,
        spawnerTool: record.spawnerTool,
        spawnerSkillRun: record.spawnerSkillRun,
      })
      .onConflictDoUpdate({
        target: sessionTree.sessionId,
        set: {
          parentSessionId: record.parentSessionId,
          spawnReason: record.spawnReason,
          spawnerTool: record.spawnerTool,
          spawnerSkillRun: record.spawnerSkillRun,
          updatedAt: new Date(),
        },
      });
  } catch (err: unknown) {
    log.warn(`upsertSessionTreeRow failed for ${record.sessionId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function deleteSessionTreeRow(sessionId: string): Promise<void> {
  try {
    await db.delete(sessionTree).where(eq(sessionTree.sessionId, sessionId));
  } catch (err: unknown) {
    log.warn(`deleteSessionTreeRow failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function getSessionTreeRow(sessionId: string): Promise<SessionTreeRow | null> {
  try {
    const rows = await db.select().from(sessionTree).where(eq(sessionTree.sessionId, sessionId)).limit(1);
    return rows[0] ?? null;
  } catch (err: unknown) {
    log.warn(`getSessionTreeRow failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export async function getSessionTreeRows(sessionIds: string[]): Promise<SessionTreeRow[]> {
  if (sessionIds.length === 0) return [];
  try {
    return await db.select().from(sessionTree).where(inArray(sessionTree.sessionId, sessionIds));
  } catch (err: unknown) {
    log.warn(`getSessionTreeRows failed count=${sessionIds.length}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

export async function getChildren(parentId: string): Promise<SessionTreeRow[]> {
  try {
    return await db.select().from(sessionTree).where(eq(sessionTree.parentSessionId, parentId));
  } catch (err: unknown) {
    log.warn(`getChildren failed for ${parentId}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

export async function getSubtree(rootId: string): Promise<SessionTreeRow[]> {
  try {
    const result = await db.execute<SessionTreeSqlRow>(sql`
      WITH RECURSIVE subtree AS (
        SELECT * FROM session_tree WHERE session_id = ${rootId}
        UNION ALL
        SELECT st.* FROM session_tree st
        INNER JOIN subtree s ON st.parent_session_id = s.session_id
      )
      SELECT * FROM subtree
    `);
    return (result.rows ?? []).map(sqlRowToTreeRow);
  } catch (err: unknown) {
    log.warn(`getSubtree failed for ${rootId}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

export async function getAncestry(sessionId: string): Promise<SessionTreeRow[]> {
  try {
    const result = await db.execute<SessionTreeSqlRow>(sql`
      WITH RECURSIVE ancestry AS (
        SELECT * FROM session_tree WHERE session_id = ${sessionId}
        UNION ALL
        SELECT st.* FROM session_tree st
        INNER JOIN ancestry a ON st.session_id = a.parent_session_id
      )
      SELECT * FROM ancestry
    `);
    return (result.rows ?? []).map(sqlRowToTreeRow);
  } catch (err: unknown) {
    log.warn(`getAncestry failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Look up an existing child session matching the idempotency tuple
 * (parentId, spawnReason, spawnerSkillRun). Returns null if none.
 */
/**
 * Find an existing non-terminal spawn matching the idempotency tuple.
 * Only matches rows with spawnStatus IN ('pending', 'running', 'succeeded').
 * Failed spawns are excluded so retries can proceed.
 */
export async function findExistingSpawn(
  parentId: string,
  spawnReason: string,
  spawnerSkillRun: string | null | undefined,
): Promise<SessionTreeRow | null> {
  try {
    const conditions = [
      eq(sessionTree.parentSessionId, parentId),
      eq(sessionTree.spawnReason, spawnReason),
    ];
    if (spawnerSkillRun) {
      conditions.push(eq(sessionTree.spawnerSkillRun, spawnerSkillRun));
    } else {
      conditions.push(isNull(sessionTree.spawnerSkillRun));
    }
    const rows = await db
      .select()
      .from(sessionTree)
      .where(and(...conditions))
      .limit(1);
    // Filter to non-failed spawn statuses
    const row = rows[0];
    if (row && row.spawnStatus === "failed") return null;
    return row ?? null;
  } catch (err: unknown) {
    log.warn(`findExistingSpawn failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Update the spawn status of a session tree row.
 * Transitions: pending → running → succeeded | failed
 */
export async function updateSpawnStatus(
  sessionId: string,
  status: "pending" | "running" | "succeeded" | "failed",
): Promise<void> {
  try {
    await db.update(sessionTree)
      .set({ spawnStatus: status, updatedAt: new Date() })
      .where(eq(sessionTree.sessionId, sessionId));
  } catch (err: unknown) {
    log.warn(`updateSpawnStatus failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Registry of in-flight skill runs keyed by child session ID. Lets a second
 * `spawnChildSession({ waitForCompletion: true })` call that hits the
 * idempotency tuple actually wait for the original run to finish instead of
 * immediately reading a half-written transcript.
 */
const inFlightRuns = new Map<string, Promise<unknown>>();

function trackRun(sessionId: string, promise: Promise<unknown>): void {
  inFlightRuns.set(sessionId, promise);
  promise.finally(() => {
    if (inFlightRuns.get(sessionId) === promise) inFlightRuns.delete(sessionId);
  });
}

/** Test-only access to the in-flight run registry. */
export const __testOnly = {
  inFlightRuns,
  trackRun,
};

async function waitForRunIfInFlight(sessionId: string, timeoutMs = 10 * 60 * 1000): Promise<void> {
  const p = inFlightRuns.get(sessionId);
  if (!p) return;
  await Promise.race([
    p.catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

async function readFinalAssistantOutput(sessionId: string): Promise<string | undefined> {
  try {
    const { chatFileStorage } = await import("../chat-file-storage");
    const messages = await chatFileStorage.getMessagesBySession(sessionId);
    if (!messages || messages.length === 0) return undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i] as { role?: string; content?: string };
      if (m.role === "assistant" && typeof m.content === "string" && m.content.trim().length > 0) return m.content;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run an arbitrary session-creation `creator` callback under the spawn
 * advisory lock, guaranteeing tuple-idempotency. If a matching spawn already
 * exists, the creator is NOT invoked — the existing session is returned. The
 * tree row is inserted/updated atomically with the lock held.
 *
 * This is the building block both `spawnChildSession` (skill-running children)
 * and non-skill child creators (e.g. converse.initiate) call into.
 */
export async function recordSpawn<T extends { sessionId: string }>(
  parentId: string,
  options: { spawnReason: string; spawnerTool?: string; spawnerSkillRun?: string; triggerType?: TriggerType; triggerId?: string; triggerName?: string },
  creator: () => Promise<T>,
): Promise<T & { reused: boolean }> {
  return withSpawnLock(parentId, options.spawnReason, options.spawnerSkillRun, async () => {
    if (options.spawnerSkillRun) {
      const existing = await findExistingSpawn(parentId, options.spawnReason, options.spawnerSkillRun);
      if (existing) {
        log.log(`recordSpawn: idempotent hit parent=${parentId} reason=${options.spawnReason} skillRun=${options.spawnerSkillRun} existing=${existing.sessionId}`);
        return { sessionId: existing.sessionId, reused: true } as T & { reused: boolean };
      }
    }
    const created = await creator();
    await upsertSessionTreeRow({
      sessionId: created.sessionId,
      parentSessionId: parentId,
      spawnReason: options.spawnReason,
      spawnerTool: options.spawnerTool ?? null,
      spawnerSkillRun: options.spawnerSkillRun ?? null,
    });
    try {
      const { chatFileStorage } = await import("../chat-file-storage");
      await chatFileStorage.setParentSessionId(created.sessionId, parentId, {
        spawnReason: options.spawnReason,
        spawnerTool: options.spawnerTool,
        spawnerSkillRun: options.spawnerSkillRun,
        triggerType: options.triggerType,
        triggerId: options.triggerId,
        triggerName: options.triggerName,
      });
    } catch (err: unknown) {
      log.warn(`recordSpawn: failed to mirror spawn metadata to chat session ${created.sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { ...created, reused: false };
  });
}

/**
 * Spawn a child session under the given parent, routing through the
 * autonomous skill runner. Idempotent on
 * (parentId, spawnReason, spawnerSkillRun): a Postgres advisory lock plus a
 * tree-row tuple unique constraint guarantee that concurrent calls with the
 * same tuple share a single child session.
 *
 * When `waitForCompletion` is true, the returned `output` field contains the
 * child's final assistant message text.
 */
export async function spawnChildSession(
  parentId: string,
  options: SpawnChildSessionOptions,
): Promise<SpawnChildSessionResult> {
  const model = options.model ?? options.skillId;
  if (!model && !options.preContext) throw new Error("spawnChildSession: either `model` (skill identifier) or `preContext` is required");
  const { spawnReason, spawnerTool, spawnerSkillRun, preContext, waitForCompletion, modelOverride, sessionKeyOverride, titleOverride, hookTriggerId, hookTriggerName } = options;

  const { executeAutonomousSkillRun } = await import("../autonomous-skill-runner");

  type RunnerHandle = {
    sessionId: string;
    runnerPromise: Promise<{ status: "succeeded" | "failed" | "yielded"; summary?: string; error?: string; durationMs: number; sessionId: string } | null>;
  };

  // Phase 1: under advisory lock, atomically lookup-or-start the runner.
  // The runner's `onSessionCreated` callback resolves a promise so we can
  // hold the lock just long enough to claim the tuple and write the tree row.
  const lockResult = await withSpawnLock(parentId, spawnReason, spawnerSkillRun, async () => {
    if (spawnerSkillRun) {
      const existing = await findExistingSpawn(parentId, spawnReason, spawnerSkillRun);
      if (existing) {
        log.log(`spawnChildSession: idempotent hit parent=${parentId} reason=${spawnReason} skillRun=${spawnerSkillRun} existing=${existing.sessionId}`);
        return { reused: true as const, sessionId: existing.sessionId };
      }
    }

    let resolveSession!: (id: string) => void;
    let rejectSession!: (err: Error) => void;
    const sessionPromise = new Promise<string>((res, rej) => {
      resolveSession = res;
      rejectSession = rej;
    });
    const timer = setTimeout(() => rejectSession(new Error("spawnChildSession: timed out waiting for session creation")), 15000);

    const runnerPromise = executeAutonomousSkillRun(model, {
      preContext,
      parentSessionId: parentId,
      spawnReason,
      spawnerTool,
      spawnerSkillRun,
      modelOverride,
      sessionKeyOverride,
      titleOverride,
      hookTriggerId,
      hookTriggerName,
      onSessionCreated: (id: string) => {
        clearTimeout(timer);
        resolveSession(id);
      },
    }).catch((err: unknown) => {
      rejectSession(err instanceof Error ? err : new Error(String(err)));
      return null;
    });

    const sessionId = await sessionPromise;
    // Idempotency reservation: the runner's createAutonomousSession will have
    // already dual-written a tree row via writeConv (because we passed
    // spawnReason/Tool/SkillRun above). The unique constraint on
    // (parent, reason, skillRun) makes that insert atomic with our
    // findExistingSpawn check inside the same advisory lock — no duplicate
    // tuple rows are possible.

    // Emit child_session_block event so parent UI renders an inline widget
    try {
      const { onChildSessionSpawned } = await import("./child-block-lifecycle");
      await onChildSessionSpawned(parentId, sessionId, {
        spawnReason,
        title: titleOverride,
        model: modelOverride,
      });
    } catch (err) {
      log.warn(`spawnChildSession: onChildSessionSpawned failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return { reused: false as const, sessionId, runnerHandle: { sessionId, runnerPromise } satisfies RunnerHandle };
  });

  if (lockResult.reused) {
    if (waitForCompletion) {
      // If the original spawn for this tuple is still running, block until it
      // finishes so we return the *final* output, not a half-written one.
      await waitForRunIfInFlight(lockResult.sessionId);
    }
    const output = waitForCompletion ? await readFinalAssistantOutput(lockResult.sessionId) : undefined;

    // Infer terminal outcome for callers that check result.status
    // (e.g. plan executor). Session status is the lifecycle source of truth.
    let status: "succeeded" | "failed" | "yielded" | undefined;
    if (waitForCompletion) {
      try {
        const { chatFileStorage } = await import("../chat-file-storage");
        const session = await chatFileStorage.getSession(lockResult.sessionId);
        if (session) {
          const sessionStatus = (session as { status?: string }).status;
          if (sessionStatus === "saved") status = "succeeded";
          else if (sessionStatus === "failed") status = "failed";
        }
      } catch { /* best effort */ }
    }

    return { sessionId: lockResult.sessionId, reused: true, output, status };
  }

  const { runnerHandle } = lockResult as { runnerHandle: RunnerHandle; sessionId: string };
  trackRun(runnerHandle.sessionId, runnerHandle.runnerPromise);
  if (waitForCompletion) {
    const result = await runnerHandle.runnerPromise;
    if (!result) {
      throw new Error(`spawnChildSession: ${model ? `model "${model}"` : "skillless session"} could not be started`);
    }

    // Emit completion event for inline widget
    try {
      const { onChildSessionCompleted } = await import("./child-block-lifecycle");
      await onChildSessionCompleted(parentId, result.sessionId, {
        status: result.status,
        summary: result.summary,
        error: result.error,
        durationMs: result.durationMs,
      });
    } catch (err) {
      log.warn(`spawnChildSession: onChildSessionCompleted failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const output = await readFinalAssistantOutput(result.sessionId);
    return {
      sessionId: result.sessionId,
      status: result.status,
      summary: result.summary,
      output,
      error: result.error,
      durationMs: result.durationMs,
    };
  }

  // Non-wait: let the runner continue in background; emit completion when done
  runnerHandle.runnerPromise
    .then(async (result) => {
      if (!result) return;
      try {
        const { onChildSessionCompleted } = await import("./child-block-lifecycle");
        await onChildSessionCompleted(parentId, result.sessionId, {
          status: result.status,
          summary: result.summary,
          error: result.error,
          durationMs: result.durationMs,
        });
      } catch (err) {
        log.warn(`spawnChildSession: background onChildSessionCompleted failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })
    .catch((err: unknown) => {
      log.warn(`spawnChildSession: background runner failed for ${runnerHandle.sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    });
  return { sessionId: runnerHandle.sessionId };
}
