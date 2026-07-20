import { createLogger } from "./log";
import { storage } from "./storage";
import type { EmailMessage } from "@shared/schema";
import { createUserPrincipalFromUser, resolveUserIdentityFoundation } from "./principal";
import { getCurrentPrincipal, runWithPrincipal } from "./principal-context";

const log = createLogger("EmailEnrichment");

const AUTO_DISMISS_TIERS = new Set(["🗑️", "📋"]);
const NEVER_AUTO_DISMISS_TIERS = new Set(["🟡", "🔴"]);

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
  try {
    const { executeAutonomousSkillRun } = await import("./autonomous-skill-runner");
    const result = await executeAutonomousSkillRun("enrich-email");
    if (!result) {
      log.warn("Enrichment skill run deferred or already active");
      return "deferred";
    }
    if (result.status !== "succeeded") {
      log.error(`Enrichment skill run ${result.status}: ${result.error || result.summary || "unknown"}`);
      return "failed";
    }
    return "completed";
  } catch (err: any) {
    log.error(`Enrichment skill run failed: ${err.message}`);
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
      log.error(`Skipping enrichment candidate id=${email.id}: ownership is incomplete`);
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
      const principal = createUserPrincipalFromUser(user, identity.accountId);
      if (identity.vaultId) {
        principal.activeVaultId = identity.vaultId;
        principal.visibleVaultIds = [identity.vaultId];
      }
      const result = await runWithPrincipal(principal, runEnrichmentForCurrentPrincipal);
      dismissed += result.dismissed;
      if (result.runStatus === "completed") completed++;
      else if (result.runStatus === "deferred") deferred++;
      else failed++;
    } catch (error) {
      failed++;
      log.error(`Owner-scoped enrichment failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const runStatus: EnrichmentRunStatus = failed > 0
    ? "failed"
    : completed > 0
      ? "completed"
      : "deferred";
  log.log(`Owner-scoped enrichment: owners=${ownerKeys.size} completed=${completed} deferred=${deferred} failed=${failed}`);
  return { dismissed, runStatus };
}
