import { and, asc, eq, gt } from "drizzle-orm";
import { users, vaults, type User } from "@shared/schema";
import { db, pool, withAdmissionTier } from "./db";
import { createLogger } from "./log";
import {
  createUserPrincipalFromUser,
  resolveUserIdentityFoundation,
  type Principal,
} from "./principal";
import { requireCurrentUserPrincipal, runWithPrincipal } from "./principal-context";
import { getSetting, setSetting } from "./system-settings";

const log = createLogger("EmailSyncTimer");

const CURSOR_SETTING_KEY = "timer.email_sync.user_cursor";
const ADVISORY_LOCK_KEY = "timer.email_sync.owner_pipeline";
const USER_PAGE_SIZE = 50;
const MAX_VAULTS_PER_OWNER = 20;
const MAX_CYCLE_MS = 45 * 60 * 1000;

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

async function loadUserPage(cursor: string | null): Promise<{ users: User[]; wrapped: boolean }> {
  const page = await db
    .select()
    .from(users)
    .where(cursor ? gt(users.id, cursor) : undefined)
    .orderBy(asc(users.id))
    .limit(USER_PAGE_SIZE);
  if (page.length > 0 || cursor === null) return { users: page, wrapped: false };

  const wrapped = await db
    .select()
    .from(users)
    .orderBy(asc(users.id))
    .limit(USER_PAGE_SIZE);
  return { users: wrapped, wrapped: true };
}

async function loadOwnerVaultPrincipals(user: User): Promise<Principal[]> {
  const foundation = await resolveUserIdentityFoundation(user.id);
  const ownedVaults = await db
    .select({ id: vaults.id })
    .from(vaults)
    .where(and(eq(vaults.accountId, foundation.accountId), eq(vaults.isArchived, false)))
    .orderBy(asc(vaults.position), asc(vaults.createdAt))
    .limit(MAX_VAULTS_PER_OWNER + 1);

  if (ownedVaults.length > MAX_VAULTS_PER_OWNER) {
    throw new Error(`owner exceeds ${MAX_VAULTS_PER_OWNER} active Vaults`);
  }

  return ownedVaults.map(({ id: vaultId }) => {
    const principal = createUserPrincipalFromUser(user, foundation.accountId);
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

  log.info(
    `Vault pipeline complete accounts=${sync.accountsSynced}/${sync.accountsDiscovered} ` +
      `untriagedBefore=${before.untriaged} triaged=${triageTriaged} ` +
      `awaitingAfter=${afterTriage.awaitingEnrichment} enrichment=${enrichmentRunStatus}`,
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
        throw new Error(`Email sync exceeds ${MAX_VAULTS_PER_OWNER} visible active Vaults`);
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
          const vaultResult = await runWithPrincipal(
            principal,
            () => withAdmissionTier("realtime", () => runEmailSync()),
          );
          result.accountsDiscovered += vaultResult.accountsDiscovered;
          result.accountsSynced += vaultResult.accountsSynced;
          result.errors.push(...vaultResult.errors);
        } catch (error) {
          result.errors.push(error instanceof Error ? error.message : String(error));
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
      for (const user of page.users) {
        if (Date.now() - cycleStartedAt >= MAX_CYCLE_MS) {
          result.errors.push(`cycle budget exhausted after ${MAX_CYCLE_MS}ms`);
          break;
        }
        result.ownersScanned++;
        result.cursor = user.id;
        try {
          const principals = await loadOwnerVaultPrincipals(user);
          for (const principal of principals) {
            result.vaultsScanned++;
            const vaultResult = await runWithPrincipal(principal, runOwnerVaultPipeline);
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
          const message = error instanceof Error ? error.message : String(error);
          result.errors.push(`owner ${user.id} failed: ${message}`);
          log.error(`owner failed userId=${user.id}: ${message}`);
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
