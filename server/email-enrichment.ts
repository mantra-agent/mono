import { createLogger } from "./log";
import { storage } from "./storage";
import type { EmailMessage } from "@shared/schema";
import { createUserPrincipalFromUser, resolveUserIdentityFoundation } from "./principal";
import { getCurrentPrincipal, runWithPrincipal } from "./principal-context";

const log = createLogger("EmailEnrichment");

const AUTO_DISMISS_TIERS = new Set(["🗑️", "📋"]);
const NEVER_AUTO_DISMISS_TIERS = new Set(["🟡", "🔴"]);

type EnrichmentOperation =
  | "fire_skill_run"
  | "skip_incomplete_ownership"
  | "owner_scoped_run";

type EnrichmentOperationError = Error & {
  code?: string;
  operation?: EnrichmentOperation;
  skillStatus?: string;
  candidateId?: number;
  hasOwnerUserId?: boolean;
  hasPrincipalAccountId?: boolean;
  hasVaultId?: boolean;
};

function normalizeEnrichmentError(
  value: unknown,
  operation: EnrichmentOperation,
  fallbackCode: string,
  message?: string,
): EnrichmentOperationError {
  let error: EnrichmentOperationError;
  if (value instanceof Error) {
    error = value as EnrichmentOperationError;
  } else if (typeof value === "string" && value.trim()) {
    error = new Error(message || value) as EnrichmentOperationError;
  } else {
    error = new Error(message || "Email enrichment failed", { cause: value }) as EnrichmentOperationError;
  }
  if (!error.code || !/^[A-Z][A-Z0-9_]{1,47}$/.test(String(error.code))) {
    error.code = fallbackCode;
  }
  error.operation = operation;
  return error;
}

function enrichmentLogContext(options: {
  operation: EnrichmentOperation;
  skillStatus?: string;
  candidateId?: number;
  hasOwnerUserId?: boolean;
  hasPrincipalAccountId?: boolean;
  hasVaultId?: boolean;
  ownerCount?: number;
}) {
  return {
    operation: options.operation,
    skillStatus: options.skillStatus,
    candidateId: options.candidateId,
    hasOwnerUserId: options.hasOwnerUserId,
    hasPrincipalAccountId: options.hasPrincipalAccountId,
    hasVaultId: options.hasVaultId,
    ownerCount: options.ownerCount,
  };
}

export async function runDeterministicDismissal(): Promise<{ dismissed: number; dismissedThreadIds: string[] }> {
  const emails = await storage.getUnenrichedTriagedEmails(200);

  const threadMap = new Map<string, EmailMessage[]>();
  for (const email of emails) {
    const tid = email.providerThreadId || email.providerMessageId;
    if (!threadMap.has(tid)) threadMap.set(tid, []);
    threadMap.get(tid)!.push(email);
  }

  let dismissed = 0;
  const dismissedThreadIds: string[] = [];

  for (const [threadId, msgs] of threadMap) {
    const triaged = msgs.find(m => m.triageTier);
    if (!triaged) continue;
    const tier = triaged.triageTier || "";

    if (NEVER_AUTO_DISMISS_TIERS.has(tier)) continue;

    if (AUTO_DISMISS_TIERS.has(tier)) {
      for (const msg of msgs) {
        await storage.markEmailDone(msg.id, true);
        await storage.recordEmailDismissal({
          messageId: msg.id,
          providerThreadId: threadId,
          accountId: msg.accountId,
          tier,
          sender: msg.fromAddress || null,
          subject: msg.subject || null,
          reason: `Auto-dismissed: ${tier === "🗑️" ? "Noise" : "FYI"} tier`,
          dismissedBy: "auto",
        });
      }
      dismissed += msgs.length;
      dismissedThreadIds.push(threadId);
    }
  }

  log.log(`Deterministic dismissal: dismissed ${dismissed} emails across ${dismissedThreadIds.length} threads`);
  return { dismissed, dismissedThreadIds };
}

export type EnrichmentRunStatus = "completed" | "deferred" | "failed";

export async function fireEnrichmentSkillRun(): Promise<EnrichmentRunStatus> {
  const operation: EnrichmentOperation = "fire_skill_run";
  try {
    const { executeAutonomousSkillRun } = await import("./autonomous-skill-runner");
    const result = await executeAutonomousSkillRun("enrich-email");
    if (!result) {
      log.warn("Enrichment skill run deferred or already active", enrichmentLogContext({ operation }));
      return "deferred";
    }
    if (result.status !== "succeeded") {
      const detail = result.error || result.summary || "unknown";
      const error = normalizeEnrichmentError(
        detail,
        operation,
        "ENRICHMENT_SKILL_RUN_FAILED",
        `Enrichment skill run ${result.status}: ${detail}`,
      );
      error.skillStatus = result.status;
      log.error("Enrichment skill run failed", error, enrichmentLogContext({
        operation,
        skillStatus: result.status,
      }));
      return "failed";
    }
    return "completed";
  } catch (value) {
    const error = normalizeEnrichmentError(value, operation, "ENRICHMENT_SKILL_RUN_EXCEPTION");
    log.error("Enrichment skill run exception", error, enrichmentLogContext({ operation }));
    return "failed";
  }
}

async function runEnrichmentForCurrentPrincipal(): Promise<{ dismissed: number; runStatus: EnrichmentRunStatus }> {
  const { dismissed } = await runDeterministicDismissal();
  const runStatus = await fireEnrichmentSkillRun();
  return { dismissed, runStatus };
}

export async function runEnrichment(): Promise<{ dismissed: number; runStatus: EnrichmentRunStatus }> {
  const current = getCurrentPrincipal();
  if (current?.actorType === "user") {
    return runEnrichmentForCurrentPrincipal();
  }

  const candidates = await storage.getUnenrichedTriagedEmails(200);
  const ownerKeys = new Map<string, { ownerUserId: string; accountId: string; vaultId: string | null }>();
  for (const email of candidates) {
    if (!email.ownerUserId || !email.principalAccountId) {
      const operation: EnrichmentOperation = "skip_incomplete_ownership";
      const error = normalizeEnrichmentError(
        undefined,
        operation,
        "ENRICHMENT_CANDIDATE_OWNERSHIP_INCOMPLETE",
        "Skipping enrichment candidate: ownership is incomplete",
      );
      error.candidateId = email.id;
      error.hasOwnerUserId = Boolean(email.ownerUserId);
      error.hasPrincipalAccountId = Boolean(email.principalAccountId);
      error.hasVaultId = Boolean(email.vaultId);
      log.error("Enrichment candidate ownership incomplete", error, enrichmentLogContext({
        operation,
        candidateId: email.id,
        hasOwnerUserId: Boolean(email.ownerUserId),
        hasPrincipalAccountId: Boolean(email.principalAccountId),
        hasVaultId: Boolean(email.vaultId),
      }));
      continue;
    }
    const key = `${email.ownerUserId}:${email.principalAccountId}:${email.vaultId || "no-vault"}`;
    ownerKeys.set(key, {
      ownerUserId: email.ownerUserId,
      accountId: email.principalAccountId,
      vaultId: email.vaultId,
    });
  }

  let dismissed = 0;
  let completed = 0;
  let deferred = 0;
  let failed = 0;
  for (const identity of ownerKeys.values()) {
    const operation: EnrichmentOperation = "owner_scoped_run";
    try {
      const user = await storage.getUser(identity.ownerUserId);
      if (!user) throw new Error(`Email owner ${identity.ownerUserId} not found`);
      const foundation = await resolveUserIdentityFoundation(user.id);
      if (foundation.accountId !== identity.accountId) {
        throw new Error(`Email owner account mismatch for ${identity.ownerUserId}`);
      }
      if (
        identity.vaultId &&
        user.activeVaultId !== identity.vaultId &&
        !user.visibleVaultIds.includes(identity.vaultId)
      ) {
        throw new Error(`Email vault ${identity.vaultId} is not visible to owner ${identity.ownerUserId}`);
      }
      const principal = createUserPrincipalFromUser(
        user,
        identity.accountId,
        foundation.instanceId,
      );
      if (identity.vaultId) {
        principal.activeVaultId = identity.vaultId;
        principal.visibleVaultIds = [identity.vaultId];
      }
      const result = await runWithPrincipal(principal, runEnrichmentForCurrentPrincipal);
      dismissed += result.dismissed;
      if (result.runStatus === "completed") completed++;
      else if (result.runStatus === "deferred") deferred++;
      else failed++;
    } catch (value) {
      failed++;
      const error = normalizeEnrichmentError(value, operation, "ENRICHMENT_OWNER_SCOPED_FAILED");
      log.error("Owner-scoped enrichment failed", error, enrichmentLogContext({
        operation,
        hasOwnerUserId: true,
        hasPrincipalAccountId: true,
        hasVaultId: Boolean(identity.vaultId),
      }));
    }
  }

  const runStatus: EnrichmentRunStatus = failed > 0
    ? "failed"
    : completed > 0
      ? "completed"
      : "deferred";
  log.log(`Owner-scoped enrichment: owners=${ownerKeys.size} completed=${completed} deferred=${deferred} failed=${failed}`, enrichmentLogContext({
    operation: "owner_scoped_run",
    ownerCount: ownerKeys.size,
  }));
  return { dismissed, runStatus };
}
