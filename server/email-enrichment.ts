import { createLogger } from "./log";
import { storage } from "./storage";
import type { EmailMessage } from "@shared/schema";

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

export async function runEnrichment(): Promise<{ dismissed: number; runStatus: EnrichmentRunStatus }> {
  const { dismissed } = await runDeterministicDismissal();
  const runStatus = await fireEnrichmentSkillRun();
  return { dismissed, runStatus };
}
