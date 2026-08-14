import { and, asc, eq, gt, isNotNull } from "drizzle-orm";
import { accounts, agentInstanceMemberships, memberships, users, vaults, type User } from "@shared/schema";
import { db, pool, withAdmissionTier } from "./db";
import { createLogger } from "./log";
import {
  AccountLifecycleError,
  createUserPrincipalFromUser,
  type Principal,
  type UserIdentityFoundation,
} from "./principal";
import { requireCurrentUserPrincipal, runWithPrincipal } from "./principal-context";
import { getSetting, setSetting } from "./system-settings";

const log = createLogger("EmailSyncTimer");

const CURSOR_SETTING_KEY = "timer.email_sync.user_cursor";
const ADVISORY_LOCK_KEY = "timer.email_sync.owner_pipeline";
const USER_PAGE_SIZE = 50;
const MAX_VAULTS_PER_OWNER = 20;
const MAX_CYCLE_MS = 45 * 60 * 1000;

type EmailSyncTimerOperation =
  | "owner_pipeline"
  | "load_owner_vaults"
  | "cycle_budget"
  | "manual_vault_sync";

type EmailSyncTimerOperationError = Error & {
  code?: string;
  operation?: EmailSyncTimerOperation;
  ownerUserId?: string;
  vaultId?: string | null;
  ownersScanned?: number;
};

function normalizeEmailSyncTimerError(
  value: unknown,
  operation: EmailSyncTimerOperation,
  fallbackCode: string,
  message?: string,
): EmailSyncTimerOperationError {
  let error: EmailSyncTimerOperationError;
  if (value instanceof Error) {
    error = value as EmailSyncTimerOperationError;
  } else if (typeof value === "string" && value.trim()) {
    error = new Error(message || value) as EmailSyncTimerOperationError;
  } else {
    error = new Error(message || "EmailSyncTimer operation failed", {
      cause: value,
    }) as EmailSyncTimerOperationError;
  }
  if (!error.code || !/^[A-Z][A-Z0-9_]{1,47}$/.test(String(error.code))) {
    error.code = fallbackCode;
  }
  error.operation = operation;
  return error;
}

function emailSyncTimerLogContext(options: {
  operation: EmailSyncTimerOperation;
  ownerUserId?: string;
  vaultId?: string | null;
  ownersScanned?: number;
}) {
  return {
    operation: options.operation,
    ownerUserId: options.ownerUserId,
    vaultId: options.vaultId ?? undefined,
    ownersScanned: options.ownersScanned,
  };
}

interface EmailSyncCursor {
  lastUserId: string | null;
}

interface OwnerPipelineResult {
  accountsDiscovered: number;
  accountsSynced: number;
  syncErrors: string[];
  triageProcessed: number;
  triageTriaged: number;
  triageDismissed: number;
  enrichmentRunStatus: "not_needed" | "completed" | "deferred" | "failed";
  enrichmentDismissed: number;
  degradedReason: string | null;
}

export interface EmailSyncTimerResult {
  status: "completed" | "already_running";
  ownersScanned: number;
  ownersWithAccounts: number;
  vaultsScanned: number;
  accountsDiscovered: number;
  accountsSynced: number;
  errors: string[];
  triageProcessed: number;
  triageTriaged: number;
  triageDismissed: number;
  enrichmentCompleted: number;
  enrichmentDeferred: number;
  enrichmentFailed: number;
  enrichmentDismissed: number;
  cursor: string | null;
  wrapped: boolean;
}

/**
 * Page only owners with active personal-account identity foundation.
 * Suspended/archived/orphan users never enter the round-robin set — that is
 * the producer filter that prevents AccountLifecycleError ERROR thrash.
 */
async function loadUserPage(
  cursor: string | null,
): Promise<{ owners: Array<{ user: User; foundation: UserIdentityFoundation }>; wrapped: boolean }> {
  const selectOwners = (afterId: string | null) =>
    db
      .select({
        user: users,
        accountId: accounts.id,
        role: memberships.role,
        activeVaultId: users.activeVaultId,
        visibleVaultIds: users.visibleVaultIds,
        instanceId: agentInstanceMemberships.instanceId,
      })
      .from(users)
      .innerJoin(memberships, eq(memberships.userId, users.id))
      .innerJoin(
        accounts,
        and(
          eq(accounts.id, memberships.accountId),
          eq(accounts.kind, "personal"),
          eq(accounts.ownerUserId, users.id),
          eq(accounts.status, "active"),
        ),
      )
      .innerJoin(
        agentInstanceMemberships,
        and(
          eq(agentInstanceMemberships.accountId, accounts.id),
          eq(agentInstanceMemberships.userId, users.id),
        ),
      )
      .where(
        afterId
          ? and(isNotNull(users.activeVaultId), gt(users.id, afterId))
          : isNotNull(users.activeVaultId),
      )
      .orderBy(asc(users.id))
      .limit(USER_PAGE_SIZE);

  const mapRows = (
    rows: Awaited<ReturnType<typeof selectOwners>>,
  ): Array<{ user: User; foundation: UserIdentityFoundation }> => {
    const out: Array<{ user: User; foundation: UserIdentityFoundation }> = [];
    for (const row of rows) {
      if (!row.accountId || !row.activeVaultId || !row.instanceId) continue;
      const role =
        row.role === "owner" || row.role === "admin" || row.role === "member" || row.role === "viewer"
          ? row.role
          : "member";
      out.push({
        user: row.user,
        foundation: {
          accountId: row.accountId,
          role,
          activeVaultId: row.activeVaultId,
          visibleVaultIds: row.visibleVaultIds ?? [],
          instanceId: row.instanceId,
        },
      });
    }
    return out;
  };

  const page = mapRows(await selectOwners(cursor));
  if (page.length > 0 || cursor === null) return { owners: page, wrapped: false };

  const wrapped = mapRows(await selectOwners(null));
  return { owners: wrapped, wrapped: true };
}

async function loadOwnerVaultPrincipals(
  user: User,
  foundation: UserIdentityFoundation,
): Promise<Principal[]> {
  const ownedVaults = await db
    .select({ id: vaults.id })
    .from(vaults)
    .where(and(eq(vaults.accountId, foundation.accountId), eq(vaults.isArchived, false)))
    .orderBy(asc(vaults.position), asc(vaults.createdAt))
    .limit(MAX_VAULTS_PER_OWNER + 1);

  if (ownedVaults.length > MAX_VAULTS_PER_OWNER) {
    const error = normalizeEmailSyncTimerError(
      new Error(`owner exceeds ${MAX_VAULTS_PER_OWNER} active Vaults`),
      "load_owner_vaults",
      "EMAIL_SYNC_TIMER_VAULT_LIMIT",
    );
    error.ownerUserId = user.id;
    throw error;
  }

  return ownedVaults.map(({ id: vaultId }) => {
    const principal = createUserPrincipalFromUser(user, foundation.accountId, foundation.instanceId);
    principal.visibleVaultIds = [vaultId];
    principal.activeVaultId = vaultId;
    principal.impersonation = {
      impersonatedByActorType: "system",
      reason: "timer:email-sync owner/Vault fan-out",
    };
    return principal;
  });
}

async function runOwnerVaultPipeline(): Promise<OwnerPipelineResult> {
  const { runEmailSync } = await import("./email-sync");
  const { storage } = await import("./storage");

  const sync = await withAdmissionTier("realtime", () => runEmailSync());
  if (sync.accountsDiscovered === 0 || sync.accountsSynced === 0) {
    return {
      accountsDiscovered: sync.accountsDiscovered,
      accountsSynced: sync.accountsSynced,
      syncErrors: sync.errors,
      triageProcessed: 0,
      triageTriaged: 0,
      triageDismissed: 0,
      enrichmentRunStatus: "not_needed",
      enrichmentDismissed: 0,
      degradedReason: sync.errors.length > 0 ? "email_sync_failed" : null,
    };
  }

  const before = await storage.getEmailPipelineCounts();
  if (before.awaitingEnrichment === 0) {
    const unenrichedRows = await storage.getUnenrichedTriagedEmails(10);
    if (unenrichedRows.length > 0) {
      log.warn(`pipeline count divergence: awaitingEnrichment=0 queryRows=${unenrichedRows.length}`);
    }
  }

  let degradedReason: string | null = sync.errors.length > 0
    ? "email_sync_partial_failure"
    : null;
  let triageProcessed = 0;
  let triageTriaged = 0;
  let triageDismissed = 0;

  if (before.untriaged > 0) {
    const { runTriagePipeline } = await import("./triage-runner");
    const triage = await runTriagePipeline();
    triageProcessed = triage.processed;
    triageTriaged = triage.triaged;
    triageDismissed = triage.dismissed;
    if (triage.status !== "succeeded") {
      degradedReason = triage.error || "triage_failed";
    }
  }

  const afterTriage = await storage.getEmailPipelineCounts();
  let enrichmentRunStatus: OwnerPipelineResult["enrichmentRunStatus"] = "not_needed";
  let enrichmentDismissed = 0;
  if (afterTriage.awaitingEnrichment > 0) {
    const { runEnrichment } = await import("./email-enrichment");
    const enrichment = await runEnrichment();
    enrichmentRunStatus = enrichment.runStatus;
    enrichmentDismissed = enrichment.dismissed;
    if (enrichmentRunStatus !== "completed") {
      degradedReason = `enrichment_${enrichmentRunStatus}`;
    }
  }

  const feedMutated =
    sync.mutated ||
    triageTriaged > 0 ||
    triageDismissed > 0 ||
    enrichmentRunStatus === "completed" ||
    enrichmentDismissed > 0;
  log.info(
    `Vault pipeline complete accounts=${sync.accountsSynced}/${sync.accountsDiscovered} ` +
      `untriagedBefore=${before.untriaged} triaged=${triageTriaged} ` +
      `awaitingAfter=${afterTriage.awaitingEnrichment} enrichment=${enrichmentRunStatus} ` +
      `feedMutated=${feedMutated}`,
  );

  return {
    accountsDiscovered: sync.accountsDiscovered,
    accountsSynced: sync.accountsSynced,
    syncErrors: sync.errors,
    triageProcessed,
    triageTriaged,
    triageDismissed,
    enrichmentRunStatus,
    enrichmentDismissed,
    degradedReason,
  };
}

function emptyResult(status: EmailSyncTimerResult["status"]): EmailSyncTimerResult {
  return {
    status,
    ownersScanned: 0,
    ownersWithAccounts: 0,
    vaultsScanned: 0,
    accountsDiscovered: 0,
    accountsSynced: 0,
    errors: [],
    triageProcessed: 0,
    triageTriaged: 0,
    triageDismissed: 0,
    enrichmentCompleted: 0,
    enrichmentDeferred: 0,
    enrichmentFailed: 0,
    enrichmentDismissed: 0,
    cursor: null,
    wrapped: false,
  };
}

async function withEmailSyncPipelineLock<T>(
  onBusy: () => T,
  operation: () => Promise<T>,
): Promise<T> {
  const lockClient = await pool.connect();
  try {
    const lock = await lockClient.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
      [ADVISORY_LOCK_KEY],
    );
    if (!lock.rows[0]?.acquired) return onBusy();
    try {
      return await operation();
    } finally {
      await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [ADVISORY_LOCK_KEY]);
    }
  } finally {
    lockClient.release();
  }
}

export interface CurrentUserEmailSyncResult {
  status: "completed" | "already_running";
  vaultsScanned: number;
  accountsDiscovered: number;
  accountsSynced: number;
  errors: string[];
}

export async function runCurrentUserEmailSync(): Promise<CurrentUserEmailSyncResult> {
  const outer = requireCurrentUserPrincipal();
  return withEmailSyncPipelineLock(
    () => ({
      status: "already_running",
      vaultsScanned: 0,
      accountsDiscovered: 0,
      accountsSynced: 0,
      errors: [],
    }),
    async () => {
      const ownedVisibleVaults = await db
        .select({ id: vaults.id })
        .from(vaults)
        .where(
          and(
            eq(vaults.accountId, outer.accountId),
            eq(vaults.isArchived, false),
          ),
        )
        .orderBy(asc(vaults.position), asc(vaults.createdAt))
        .limit(MAX_VAULTS_PER_OWNER + 1);
      const visible = outer.visibleVaultIds.length === 0
        ? ownedVisibleVaults
        : ownedVisibleVaults.filter(({ id }) => outer.visibleVaultIds.includes(id));
      if (visible.length > MAX_VAULTS_PER_OWNER) {
        const error = normalizeEmailSyncTimerError(
          new Error(`Email sync exceeds ${MAX_VAULTS_PER_OWNER} visible active Vaults`),
          "manual_vault_sync",
          "EMAIL_SYNC_TIMER_VAULT_LIMIT",
        );
        error.ownerUserId = outer.userId;
        throw error;
      }

      const result: CurrentUserEmailSyncResult = {
        status: "completed",
        vaultsScanned: 0,
        accountsDiscovered: 0,
        accountsSynced: 0,
        errors: [],
      };
      const { runEmailSync } = await import("./email-sync");
      for (const { id: vaultId } of visible) {
        const principal: Principal = {
          ...outer,
          visibleVaultIds: [vaultId],
          activeVaultId: vaultId,
        };
        result.vaultsScanned++;
        try {
          const vaultResult = await runWithPrincipal(principal, async () => {
            const { admissionController } = await import("./run-admission");
            return admissionController.withResourcePool(
              "short_worker",
              `email-sync:manual:${principal.activeVaultId ?? "none"}:${Date.now()}`,
              () => withAdmissionTier("realtime", () => runEmailSync()),
              { activity: "request.email_sync", tier: "realtime" },
            );
          });
          result.accountsDiscovered += vaultResult.accountsDiscovered;
          result.accountsSynced += vaultResult.accountsSynced;
          result.errors.push(...vaultResult.errors);
        } catch (error) {
          const normalized = normalizeEmailSyncTimerError(
            error,
            "manual_vault_sync",
            "EMAIL_SYNC_TIMER_MANUAL_VAULT_FAILED",
            "Manual email sync vault pipeline failed",
          );
          normalized.ownerUserId = outer.userId;
          normalized.vaultId = vaultId;
          result.errors.push(normalized.message);
          log.error(
            "email_sync_timer.manual_vault_failed",
            normalized,
            emailSyncTimerLogContext({
              operation: "manual_vault_sync",
              ownerUserId: outer.userId,
              vaultId,
            }),
          );
        }
      }
      return result;
    },
  );
}

export async function runEmailSyncTimer(): Promise<EmailSyncTimerResult> {
  return withEmailSyncPipelineLock(
    () => {
      log.warn("cycle skipped: another email-sync pipeline owns the advisory lock");
      return emptyResult("already_running");
    },
    async () => {
      const cycleStartedAt = Date.now();
      const savedCursor = await getSetting<EmailSyncCursor>(CURSOR_SETTING_KEY);
      const page = await loadUserPage(savedCursor?.lastUserId ?? null);
      const result = emptyResult("completed");
      result.wrapped = page.wrapped;

      const ownersWithAccounts = new Set<string>();
      for (const { user, foundation } of page.owners) {
        if (Date.now() - cycleStartedAt >= MAX_CYCLE_MS) {
          result.errors.push(`cycle budget exhausted after ${MAX_CYCLE_MS}ms`);
          break;
        }
        result.ownersScanned++;
        result.cursor = user.id;
        try {
          const principals = await loadOwnerVaultPrincipals(user, foundation);
          for (const principal of principals) {
            result.vaultsScanned++;
            const vaultResult = await runWithPrincipal(principal, async () => {
              const { admissionController } = await import("./run-admission");
              return admissionController.withResourcePool(
                "short_worker",
                `email-sync:${user.id}:${principal.activeVaultId ?? "none"}:${Date.now()}`,
                runOwnerVaultPipeline,
                { activity: "timer.email_sync" },
              );
            });
            if (vaultResult.accountsDiscovered === 0) continue;

            ownersWithAccounts.add(user.id);
            result.accountsDiscovered += vaultResult.accountsDiscovered;
            result.accountsSynced += vaultResult.accountsSynced;
            result.errors.push(...vaultResult.syncErrors);
            result.triageProcessed += vaultResult.triageProcessed;
            result.triageTriaged += vaultResult.triageTriaged;
            result.triageDismissed += vaultResult.triageDismissed;
            result.enrichmentDismissed += vaultResult.enrichmentDismissed;
            if (vaultResult.enrichmentRunStatus === "completed") result.enrichmentCompleted++;
            if (vaultResult.enrichmentRunStatus === "deferred") result.enrichmentDeferred++;
            if (vaultResult.enrichmentRunStatus === "failed") result.enrichmentFailed++;
            if (vaultResult.degradedReason) {
              result.errors.push(`Vault pipeline: ${vaultResult.degradedReason}`);
            }
          }
        } catch (error) {
          // Race: account archived/suspended between page load and vault work.
          // Same class as the producer filter — skip without ERROR thrash.
          if (error instanceof AccountLifecycleError) {
            log.debug("email_sync_timer.owner_skipped_lifecycle", {
              ownerUserId: user.id,
              code: error.code,
            });
            continue;
          }
          const normalized = normalizeEmailSyncTimerError(
            error,
            "owner_pipeline",
            "EMAIL_SYNC_TIMER_OWNER_FAILED",
            "Email sync timer owner pipeline failed",
          );
          normalized.ownerUserId = user.id;
          normalized.ownersScanned = result.ownersScanned;
          result.errors.push(`owner ${user.id} failed: ${normalized.message}`);
          log.error(
            "email_sync_timer.owner_failed",
            normalized,
            emailSyncTimerLogContext({
              operation: "owner_pipeline",
              ownerUserId: user.id,
              ownersScanned: result.ownersScanned,
            }),
          );
        } finally {
          await setSetting(CURSOR_SETTING_KEY, { lastUserId: user.id });
        }
      }
      result.ownersWithAccounts = ownersWithAccounts.size;

      log.info(
        `cycle complete owners=${result.ownersWithAccounts}/${result.ownersScanned} ` +
          `vaults=${result.vaultsScanned} accounts=${result.accountsSynced}/${result.accountsDiscovered} ` +
          `errors=${result.errors.length} cursor=${result.cursor ?? "none"} wrapped=${result.wrapped}`,
      );
      return result;
    },
  );
}
