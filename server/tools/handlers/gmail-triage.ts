import type { ToolHandlerResult } from "../contracts";
import { TRIAGE_LOOKBACK_HOURS } from "../../skill-defaults";
import { gmailInput } from "./gmail-boundary";

export async function handleGmailTriageLog(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { storage } = await import("../../storage");
  const subAction = args.triage_action || "get_triaged_ids";

  if (subAction === "get_triaged_ids") {
    const sinceHours = args.sinceHours || TRIAGE_LOOKBACK_HOURS;
    const ids = await storage.getTriagedMessageIds(sinceHours);
    return { result: ids.length > 0 ? `${ids.length} previously triaged message IDs:\n${ids.join("\n")}` : "No previously triaged messages found." };
  }

  if (subAction === "record") {
    const validTiers = new Set(["🔴", "🟡", "🟢", "📋", "🗑️", "respond_now", "respond_today", "acknowledge", "fyi", "noise"]);
    const tierNormalize: Record<string, string> = { respond_now: "🔴", respond_today: "🟡", acknowledge: "🟢", fyi: "📋", noise: "🗑️" };
    const entries: Array<{ gmailMessageId: string; accountId: string; tier: string; senderEmail?: string; subject?: string; cachedMessageId?: number }> = args.entries;
    if (!entries || !Array.isArray(entries) || entries.length === 0) {
      return gmailInput("Missing or empty 'entries' array. Each entry needs: gmailMessageId, accountId, tier.", "missing_entries");
    }
    for (const entry of entries) {
      if (!entry.gmailMessageId || !entry.accountId || !entry.tier) {
        return gmailInput(`Invalid entry — each needs gmailMessageId, accountId, and tier. Got: ${JSON.stringify(entry)}`, "invalid_entry");
      }
      if (!validTiers.has(entry.tier)) {
        return gmailInput(`Invalid tier "${entry.tier}". Valid: 🔴, 🟡, 🟢, 📋, 🗑️ (or respond_now, respond_today, acknowledge, fyi, noise)`, "invalid_tier");
      }
      entry.tier = tierNormalize[entry.tier] || entry.tier;
    }
    await storage.recordTriagedEmails(entries.map((entry) => ({
      gmailMessageId: entry.gmailMessageId,
      accountId: entry.accountId,
      tier: entry.tier,
      senderEmail: entry.senderEmail || null,
      subject: entry.subject || null,
      cachedMessageId: entry.cachedMessageId ?? null,
    })));
    return { result: `Recorded ${entries.length} triaged email(s) in triage log.` };
  }

  return gmailInput(`Unknown triage_action "${subAction}". Use "get_triaged_ids" or "record".`, String(subAction));
}
