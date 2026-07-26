import { sql } from "drizzle-orm";
import { db } from "../db";
import { createLogger } from "../log";
import { setSetting } from "../system-settings";

const log = createLogger("DetachCrossOwnerLibraryChild");

const REPAIR_KEY = "library:detach-cross-owner-child:33162f5f";
const REPAIR_STATUS_KEY = "system.library_repair.detach_cross_owner_33162f5f";
const CHILD_PAGE_ID = "33162f5f-d8e2-4200-abcc-4c426d9c69d0";
const CHILD_TITLE = "2026-06-26";
const CHILD_VAULT_ID = "ed444de0-a5a4-4ae8-83d1-502ec5549637";
const PARENT_PAGE_ID = "2f448d63-ea31-4919-92e3-a45619968107";
const PARENT_TITLE = "Journal";
const PARENT_VAULT_ID = "5097b85a-793b-4811-98e7-95621003eb7a";
const PARENT_OWNER_USER_ID = "f6de5710-5f8a-4e91-afa2-c673a997ce2d";
const PARENT_ACCOUNT_ID = "1d52cbc6-d922-4afd-b5e8-0eeeb5babd47";
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5_000;

type RepairOutcome = "detached" | "already_detached" | "blocked" | "busy";
type TerminalRepairOutcome = Exclude<RepairOutcome, "busy"> | "failed";

interface RepairLockRow {
  acquired: boolean;
}

interface RepairStateRow {
  child_exists: boolean;
  child_parent_id: string | null;
  child_vault_id: string | null;
  child_scope: string | null;
  parent_exists: boolean;
  parent_vault_id: string | null;
  parent_scope: string | null;
  ownership_mismatch: boolean;
}

interface RepairStatus {
  outcome: TerminalRepairOutcome;
  attempt: number;
  recordedAt: string;
  childPageId: string;
  expectedParentPageId: string;
  errorName?: string;
  errorCode?: string;
  errorMessage?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(error: unknown): Pick<RepairStatus, "errorName" | "errorCode" | "errorMessage"> {
  const errorRecord = error && typeof error === "object" ? error as Record<string, unknown> : null;
  const message = error instanceof Error ? error.message : String(error);
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    errorCode: typeof errorRecord?.code === "string" ? errorRecord.code.slice(0, 80) : undefined,
    errorMessage: message.slice(0, 500),
  };
}

async function persistRepairStatus(status: RepairStatus): Promise<void> {
  try {
    await setSetting(REPAIR_STATUS_KEY, status);
  } catch (error) {
    log.error("failed to persist cross-owner Library child repair status", {
      outcome: status.outcome,
      attempt: status.attempt,
      ...describeError(error),
    });
  }
}

/**
 * Repairs one evidenced cross-owner Library hierarchy edge without expanding
 * ordinary user authority. Exact identity and state guards make the mutation
 * replay-safe and ensure unrelated or subsequently edited pages fail closed.
 */
export async function detachDiagnosedCrossOwnerLibraryChild(attempt = 1): Promise<RepairOutcome> {
  log.info("cross-owner Library child repair attempt started", {
    attempt,
    childPageId: CHILD_PAGE_ID,
    expectedParentPageId: PARENT_PAGE_ID,
  });

  return db.transaction(async (tx) => {
    const lockResult = await tx.execute<RepairLockRow>(sql`
      SELECT pg_try_advisory_xact_lock(hashtext(${REPAIR_KEY})) AS acquired
    `);
    if (lockResult.rows?.[0]?.acquired !== true) {
      log.warn("cross-owner Library child repair attempt skipped because lock is busy", {
        attempt,
        childPageId: CHILD_PAGE_ID,
      });
      return "busy";
    }

    log.info("cross-owner Library child repair lock acquired", {
      attempt,
      childPageId: CHILD_PAGE_ID,
    });

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
      log.info("detached diagnosed cross-owner Library child", {
        attempt,
        childPageId: CHILD_PAGE_ID,
        formerParentPageId: PARENT_PAGE_ID,
        childVaultId: CHILD_VAULT_ID,
        parentVaultId: PARENT_VAULT_ID,
      });
      return "detached";
    }

    const state = await tx.execute<RepairStateRow>(sql`
      SELECT
        child.id IS NOT NULL AS child_exists,
        child.parent_id AS child_parent_id,
        child.vault_id AS child_vault_id,
        child.scope AS child_scope,
        parent.id IS NOT NULL AS parent_exists,
        parent.vault_id AS parent_vault_id,
        parent.scope AS parent_scope,
        COALESCE(
          child.owner_user_id IS DISTINCT FROM parent.owner_user_id
          OR child.account_id IS DISTINCT FROM parent.account_id,
          FALSE
        ) AS ownership_mismatch
      FROM (SELECT 1) AS _sentinel
      LEFT JOIN library_pages AS child ON child.id = ${CHILD_PAGE_ID}
      LEFT JOIN library_pages AS parent ON parent.id = ${PARENT_PAGE_ID}
      LIMIT 1
    `);
    const row = state.rows?.[0];

    if (row?.child_exists && row.child_parent_id === null) {
      log.info("diagnosed cross-owner Library child already detached", {
        attempt,
        childPageId: CHILD_PAGE_ID,
        childVaultId: row.child_vault_id,
      });
      return "already_detached";
    }

    log.warn("diagnosed cross-owner Library child repair blocked by state drift", {
      attempt,
      childPageId: CHILD_PAGE_ID,
      expectedParentPageId: PARENT_PAGE_ID,
      childExists: row?.child_exists ?? false,
      childParentId: row?.child_parent_id ?? null,
      childVaultId: row?.child_vault_id ?? null,
      childScope: row?.child_scope ?? null,
      parentExists: row?.parent_exists ?? false,
      parentVaultId: row?.parent_vault_id ?? null,
      parentScope: row?.parent_scope ?? null,
      ownershipMismatch: row?.ownership_mismatch ?? false,
    });
    return "blocked";
  });
}

/**
 * Runs the post-ready repair with bounded retry for transient failures and
 * replica lock contention. Every terminal result is durable and every stage is
 * logged, so absence of the mutation can be distinguished from non-registration,
 * contention, state drift, and database failure.
 */
export async function runDiagnosedCrossOwnerLibraryChildRepair(): Promise<void> {
  log.info("cross-owner Library child repair registered", {
    childPageId: CHILD_PAGE_ID,
    expectedParentPageId: PARENT_PAGE_ID,
    maxAttempts: MAX_ATTEMPTS,
  });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const outcome = await detachDiagnosedCrossOwnerLibraryChild(attempt);
      if (outcome === "busy") {
        if (attempt < MAX_ATTEMPTS) {
          log.warn("cross-owner Library child repair will retry after lock contention", {
            attempt,
            nextAttempt: attempt + 1,
            retryDelayMs: RETRY_DELAY_MS,
          });
          await delay(RETRY_DELAY_MS);
          continue;
        }

        const status: RepairStatus = {
          outcome: "failed",
          attempt,
          recordedAt: new Date().toISOString(),
          childPageId: CHILD_PAGE_ID,
          expectedParentPageId: PARENT_PAGE_ID,
          errorName: "RepairLockContention",
          errorCode: "repair_lock_busy",
          errorMessage: "Repair lock remained busy through the bounded retry window.",
        };
        await persistRepairStatus(status);
        log.error("cross-owner Library child repair exhausted retries after lock contention", status);
        return;
      }

      const status: RepairStatus = {
        outcome,
        attempt,
        recordedAt: new Date().toISOString(),
        childPageId: CHILD_PAGE_ID,
        expectedParentPageId: PARENT_PAGE_ID,
      };
      await persistRepairStatus(status);
      log.info("cross-owner Library child repair finished", status);
      return;
    } catch (error) {
      const errorDetails = describeError(error);
      log.error("cross-owner Library child repair attempt failed", {
        attempt,
        willRetry: attempt < MAX_ATTEMPTS,
        ...errorDetails,
      });

      if (attempt < MAX_ATTEMPTS) {
        await delay(RETRY_DELAY_MS);
        continue;
      }

      const status: RepairStatus = {
        outcome: "failed",
        attempt,
        recordedAt: new Date().toISOString(),
        childPageId: CHILD_PAGE_ID,
        expectedParentPageId: PARENT_PAGE_ID,
        ...errorDetails,
      };
      await persistRepairStatus(status);
      log.error("cross-owner Library child repair exhausted retries", status);
    }
  }
}
