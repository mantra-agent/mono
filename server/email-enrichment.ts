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

export async function fireEnrichmentSkillRun(): Promise<boolean> {
  try {
    const { executeAutonomousSkillRun } = await import("./autonomous-skill-runner");
    executeAutonomousSkillRun("enrich-email").catch(err => {
      log.error(`Enrichment skill run failed: ${err.message}`);
    });
    return true;
  } catch (err: any) {
    log.error(`Failed to start enrichment skill run: ${err.message}`);
    return false;
  }
}

export async function runEnrichment(): Promise<{ dismissed: number; skillRunStarted: boolean }> {
  const { dismissed } = await runDeterministicDismissal();
  const skillRunStarted = await fireEnrichmentSkillRun();
  return { dismissed, skillRunStarted };
}
