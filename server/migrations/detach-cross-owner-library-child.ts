import { sql } from "drizzle-orm";
import { db } from "../db";
import { createLogger } from "../log";
import { setSetting } from "../system-settings";

const log = createLogger("DetachCrossOwnerLibraryChild");

const REPAIR_KEY = "library:detach-cross-owner-child:33162f5f";
const REPAIR_STATUS_KEY = "system.library_integrity_repair.detach_cross_owner_child_33162f5f";
const CHILD_PAGE_ID = "33162f5f-d8e2-4200-abcc-4c426d9c69d0";
const CHILD_TITLE = "2026-06-26";
const CHILD_VAULT_ID = "ed444de0-a5a4-4ae8-83d1-502ec5549637";
const PARENT_PAGE_ID = "2f448d63-ea31-4919-92e3-a45619968107";
const PARENT_TITLE = "Journal";
const PARENT_VAULT_ID = "5097b85a-793b-4811-98e7-95621003eb7a";
const PARENT_OWNER_USER_ID = "f6de5710-5f8a-4e91-afa2-c673a997ce2d";
const PARENT_ACCOUNT_ID = "1d52cbc6-d922-4afd-b5e8-0eeeb5babd47";

const RETRY_DELAY_MS = 30_000;
const MAX_ATTEMPTS = 10;

export type RepairOutcome = "detached" | "already_detached" | "blocked";
export interface RepairResult {
  outcome: RepairOutcome;
  blockingReasons: string[];
}
type RepairRunnerState = "idle" | "scheduled" | "running" | "terminal";

interface RepairStateRow {
  child_exists: boolean;
  child_parent_id: string | null;
  child_vault_id: string | null;
  child_title_matches: boolean;
  child_parent_matches: boolean;
  child_vault_matches: boolean;
  child_scope_matches: boolean;
  child_identity_present: boolean;
  parent_exists: boolean;
  parent_title_matches: boolean;
  parent_vault_matches: boolean;
  parent_scope_matches: boolean;
  parent_owner_matches: boolean;
  parent_account_matches: boolean;
  ownership_mismatch: boolean;
}

interface DurableRepairStatus {
  outcome: RepairOutcome | "retry_exhausted";
  attempt: number;
  completedAt: string;
  childPageId: string;
  expectedParentPageId: string;
  blockingReasons?: string[];
  errorName?: string;
}

async function persistTerminalStatus(status: DurableRepairStatus): Promise<void> {
  await setSetting(REPAIR_STATUS_KEY, status);
}

function collectBlockingReasons(row: RepairStateRow | undefined): string[] {
  if (!row) return ["state_query_returned_no_row"];

  const checks: Array<[boolean, string]> = [
    [row.child_exists, "child_missing"],
    [row.child_title_matches, "child_title_changed"],
    [row.child_parent_matches, "child_parent_changed"],
    [row.child_vault_matches, "child_vault_changed"],
    [row.child_scope_matches, "child_scope_changed"],
    [row.child_identity_present, "child_identity_missing"],
    [row.parent_exists, "parent_missing"],
    [row.parent_title_matches, "parent_title_changed"],
    [row.parent_vault_matches, "parent_vault_changed"],
    [row.parent_scope_matches, "parent_scope_changed"],
    [row.parent_owner_matches, "parent_owner_changed"],
    [row.parent_account_matches, "parent_account_changed"],
    [row.ownership_mismatch, "ownership_mismatch_no_longer_present"],
  ];

  return checks.filter(([passes]) => !passes).map(([, reason]) => reason);
}

/**
 * Repairs one evidenced cross-owner Library hierarchy edge without expanding
 * ordinary user authority. Exact identity and state guards make the mutation
 * replay-safe and ensure unrelated or subsequently edited pages fail closed.
 */
export async function detachDiagnosedCrossOwnerLibraryChild(): Promise<RepairResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${REPAIR_KEY}))`);

    const updated = await tx.execute<{ id: string }>(sql`
      UPDATE library_pages AS child
      SET
        parent_id = NULL,
        updated_at = CURRENT_TIMESTAMP
      FROM library_pages AS parent
      WHERE child.id = ${CHILD_PAGE_ID}
        AND child.title = ${CHILD_TITLE}
        AND child.parent_id = parent.id
        AND parent.id = ${PARENT_PAGE_ID}
        AND parent.title = ${PARENT_TITLE}
        AND child.scope = 'user'
        AND parent.scope = 'user'
        AND child.owner_user_id IS NOT NULL
        AND child.account_id IS NOT NULL
        AND parent.owner_user_id = ${PARENT_OWNER_USER_ID}
        AND parent.account_id = ${PARENT_ACCOUNT_ID}
        AND child.vault_id = ${CHILD_VAULT_ID}
        AND parent.vault_id = ${PARENT_VAULT_ID}
        AND (
          child.owner_user_id IS DISTINCT FROM parent.owner_user_id
          OR child.account_id IS DISTINCT FROM parent.account_id
        )
      RETURNING child.id
    `);

    if ((updated.rows ?? []).length === 1) {
      log.info("library integrity repair detached diagnosed cross-owner child", {
        event: "library_integrity_repair.detached",
        repairKey: REPAIR_KEY,
        childPageId: CHILD_PAGE_ID,
        formerParentPageId: PARENT_PAGE_ID,
        childVaultId: CHILD_VAULT_ID,
        parentVaultId: PARENT_VAULT_ID,
      });
      return { outcome: "detached", blockingReasons: [] };
    }

    const state = await tx.execute<RepairStateRow>(sql`
      SELECT
        child.id IS NOT NULL AS child_exists,
        child.parent_id AS child_parent_id,
        child.vault_id AS child_vault_id,
        COALESCE(child.title = ${CHILD_TITLE}, FALSE) AS child_title_matches,
        COALESCE(child.parent_id = ${PARENT_PAGE_ID}, FALSE) AS child_parent_matches,
        COALESCE(child.vault_id = ${CHILD_VAULT_ID}, FALSE) AS child_vault_matches,
        COALESCE(child.scope = 'user', FALSE) AS child_scope_matches,
        COALESCE(child.owner_user_id IS NOT NULL AND child.account_id IS NOT NULL, FALSE) AS child_identity_present,
        parent.id IS NOT NULL AS parent_exists,
        COALESCE(parent.title = ${PARENT_TITLE}, FALSE) AS parent_title_matches,
        COALESCE(parent.vault_id = ${PARENT_VAULT_ID}, FALSE) AS parent_vault_matches,
        COALESCE(parent.scope = 'user', FALSE) AS parent_scope_matches,
        COALESCE(parent.owner_user_id = ${PARENT_OWNER_USER_ID}, FALSE) AS parent_owner_matches,
        COALESCE(parent.account_id = ${PARENT_ACCOUNT_ID}, FALSE) AS parent_account_matches,
        COALESCE(
          child.id IS NOT NULL
          AND parent.id IS NOT NULL
          AND (
            child.owner_user_id IS DISTINCT FROM parent.owner_user_id
            OR child.account_id IS DISTINCT FROM parent.account_id
          ),
          FALSE
        ) AS ownership_mismatch
      FROM (SELECT 1) AS _sentinel
      LEFT JOIN library_pages AS child ON child.id = ${CHILD_PAGE_ID}
      LEFT JOIN library_pages AS parent ON parent.id = ${PARENT_PAGE_ID}
      LIMIT 1
    `);
    const row = state.rows?.[0];

    if (row?.child_exists && row.child_parent_id === null) {
      log.info("library integrity repair skipped because diagnosed child is already detached", {
        event: "library_integrity_repair.skipped",
        repairKey: REPAIR_KEY,
        outcome: "already_detached",
        childPageId: CHILD_PAGE_ID,
        childVaultId: row.child_vault_id,
      });
      return { outcome: "already_detached", blockingReasons: [] };
    }

    const blockingReasons = collectBlockingReasons(row);
    log.error("library integrity repair blocked by exact state guard", {
      event: "library_integrity_repair.blocked",
      repairKey: REPAIR_KEY,
      childPageId: CHILD_PAGE_ID,
      expectedParentPageId: PARENT_PAGE_ID,
      blockingReasons,
      childExists: row?.child_exists ?? false,
      childParentId: row?.child_parent_id ?? null,
      parentExists: row?.parent_exists ?? false,
    });
    return { outcome: "blocked", blockingReasons };
  });
}

let runnerState: RepairRunnerState = "idle";
let attempt = 0;

/**
 * Registers the exact post-ready repair once per process. Database failures
 * receive bounded retries; CAS guard drift remains a terminal, visible block.
 * Every deployment replays the registration, while the repair itself remains
 * idempotent across processes and replicas.
 */
export function startDiagnosedCrossOwnerLibraryChildRepair(): void {
  if (runnerState !== "idle") {
    log.info("library integrity repair registration skipped", {
      event: "library_integrity_repair.registration_skipped",
      repairKey: REPAIR_KEY,
      reason: "already_started",
      runnerState,
      attempt,
    });
    return;
  }

  runnerState = "scheduled";
  log.info("library integrity repair registered for post-ready execution", {
    event: "library_integrity_repair.registered",
    repairKey: REPAIR_KEY,
    childPageId: CHILD_PAGE_ID,
    expectedParentPageId: PARENT_PAGE_ID,
    maxAttempts: MAX_ATTEMPTS,
    retryDelayMs: RETRY_DELAY_MS,
  });

  const run = async (): Promise<void> => {
    attempt += 1;
    runnerState = "running";
    log.info("library integrity repair attempt started", {
      event: "library_integrity_repair.attempt_started",
      repairKey: REPAIR_KEY,
      attempt,
      maxAttempts: MAX_ATTEMPTS,
    });

    try {
      const result = await detachDiagnosedCrossOwnerLibraryChild();
      await persistTerminalStatus({
        outcome: result.outcome,
        attempt,
        completedAt: new Date().toISOString(),
        childPageId: CHILD_PAGE_ID,
        expectedParentPageId: PARENT_PAGE_ID,
        ...(result.blockingReasons.length > 0
          ? { blockingReasons: result.blockingReasons }
          : {}),
      });
      runnerState = "terminal";

      if (result.outcome === "blocked") {
        log.error("library integrity repair reached terminal blocked outcome", {
          event: "library_integrity_repair.terminal",
          repairKey: REPAIR_KEY,
          outcome: result.outcome,
          blockingReasons: result.blockingReasons,
          attempt,
          durableStatusKey: REPAIR_STATUS_KEY,
        });
        return;
      }

      log.info("library integrity repair reached terminal success outcome", {
        event: "library_integrity_repair.terminal",
        repairKey: REPAIR_KEY,
        outcome: result.outcome,
        attempt,
        durableStatusKey: REPAIR_STATUS_KEY,
      });
    } catch (error) {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (attempt >= MAX_ATTEMPTS) {
        try {
          await persistTerminalStatus({
            outcome: "retry_exhausted",
            attempt,
            completedAt: new Date().toISOString(),
            childPageId: CHILD_PAGE_ID,
            expectedParentPageId: PARENT_PAGE_ID,
            errorName,
          });
        } catch (statusError) {
          log.error("library integrity repair could not persist exhausted status", {
            event: "library_integrity_repair.status_persist_failed",
            repairKey: REPAIR_KEY,
            attempt,
            statusErrorName: statusError instanceof Error ? statusError.name : "UnknownError",
            statusErrorMessage: statusError instanceof Error ? statusError.message : String(statusError),
          });
        }

        runnerState = "terminal";
        log.error("library integrity repair exhausted bounded retries", {
          event: "library_integrity_repair.retry_exhausted",
          repairKey: REPAIR_KEY,
          attempt,
          maxAttempts: MAX_ATTEMPTS,
          errorName,
          errorMessage,
          durableStatusKey: REPAIR_STATUS_KEY,
        });
        return;
      }

      runnerState = "scheduled";
      log.warn("library integrity repair attempt failed; retry scheduled", {
        event: "library_integrity_repair.retry_scheduled",
        repairKey: REPAIR_KEY,
        attempt,
        maxAttempts: MAX_ATTEMPTS,
        retryDelayMs: RETRY_DELAY_MS,
        errorName,
        errorMessage,
      });
      setTimeout(run, RETRY_DELAY_MS).unref();
    }
  };

  setTimeout(run, 0).unref();
}
