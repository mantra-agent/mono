import type { ToolHandlerResult } from "../contracts";
import { createLogger } from "../../log";
import { safeStringify } from "../../utils/safe-stringify";

const log = createLogger("EmailCache");

export async function handleGmailPipelineAction(args: Record<string, any>): Promise<ToolHandlerResult | null> {
  const subAction = args.cache_action || "get_untriaged";
  if (!["sync_status", "pipeline_counts", "diagnose", "run_downstream"].includes(subAction)) return null;

  if (subAction === "sync_status") {
    const { getEmailPipelineHealth } = await import("../../email-sync");
    const health = await getEmailPipelineHealth();
    if (health.accounts.length === 0) return { result: "No email sync history found. Sync has not run yet." };
    const lines = health.accounts.map((account) => {
      const staleWarning = account.stale ? " ⚠️ STALE" : "";
      const lastSuccess = account.lastGoodAt || "never";
      return `- **${account.accountId}**: status=${account.status}, last success=${lastSuccess}${staleWarning}, total synced=${account.totalSynced}, total reconciled (Superhuman/done sweeps)=${account.totalReconciled}${account.currentError ? `, current error: ${account.currentError}` : ""}`;
    });
    return { result: `Email sync health: ${health.status}\n${lines.join("\n")}` };
  }

  const { storage } = await import("../../storage");

  if (subAction === "pipeline_counts") {
    const counts = await storage.getEmailPipelineCounts();
    return { result: safeStringify({ ...counts, description: "Pipeline counts from getEmailPipelineCounts(). untriaged=non-outbound emails with triageStatus='untriaged' (last 30 days), matching get_untriaged candidate scope. awaitingEnrichment=triageStatus='triaged' with no/stale enrichment (last 30 days). reviewReady=triageStatus='triaged' with current enrichment (last 30 days). triageStatus='dismissed' emails (auto-dismissed noise/FYI) are excluded from enrichment/review counts." }, { label: "bridge.gmail.pipeline_counts" }) };
  }

  if (subAction === "diagnose") {
    const counts = await storage.getEmailPipelineCounts();
    const sampleLimit = Math.min(Number(args.limit) || 50, 200);
    const unenriched = await storage.getUnenrichedTriagedEmails(sampleLimit);
    const emails = unenriched.map((email) => ({
      id: email.id,
      providerThreadId: email.providerThreadId,
      providerMessageId: email.providerMessageId,
      accountId: email.accountId,
      triageStatus: email.triageStatus,
      triageTier: email.triageTier,
      isDone: email.isDone,
      subject: email.subject?.slice(0, 80),
    }));
    const exactComparison = counts.awaitingEnrichment <= sampleLimit && unenriched.length < sampleLimit;
    const divergence = exactComparison && counts.awaitingEnrichment !== unenriched.length;
    const sampleNote = !exactComparison
      ? `Sample only: getUnenrichedTriagedEmails returned ${unenriched.length}/${sampleLimit} rows from ${counts.awaitingEnrichment} awaiting. No divergence conclusion from a capped sample.`
      : "Exact comparison: sample covers the full awaiting set.";
    return { result: safeStringify({
      pipelineCounts: counts,
      unenrichedQuery: { sampleCount: unenriched.length, sampleLimit, emails },
      exactComparison,
      divergence,
      divergenceNote: divergence
        ? `DIVERGENCE: getEmailPipelineCounts says ${counts.awaitingEnrichment} awaiting, getUnenrichedTriagedEmails returns ${unenriched.length}. These should agree when the sample is complete.`
        : sampleNote,
    }, { label: "bridge.gmail.diagnose" }) };
  }

  log.log("Manual run_downstream triggered via tool");
  const counts = await storage.getEmailPipelineCounts();
  log.log(`run_downstream counts: untriaged=${counts.untriaged} awaitingEnrichment=${counts.awaitingEnrichment} reviewReady=${counts.reviewReady}`);
  let triageResult = null;
  if (counts.untriaged > 0) {
    const { runTriagePipeline } = await import("../../triage-runner");
    triageResult = await runTriagePipeline();
    log.log(`run_downstream triage: processed=${triageResult.processed} triaged=${triageResult.triaged} status=${triageResult.status}`);
  }
  const afterCounts = await storage.getEmailPipelineCounts();
  let enrichmentResult = null;
  if (afterCounts.awaitingEnrichment > 0) {
    const { runEnrichment } = await import("../../email-enrichment");
    enrichmentResult = await runEnrichment();
    log.log(`run_downstream enrichment: dismissed=${enrichmentResult.dismissed} runStatus=${enrichmentResult.runStatus}`);
  }
  const finalCounts = await storage.getEmailPipelineCounts();
  return { result: safeStringify({
    beforeCounts: counts,
    triageResult: triageResult ? { processed: triageResult.processed, triaged: triageResult.triaged, status: triageResult.status } : "skipped (untriaged=0)",
    afterTriageCounts: afterCounts,
    enrichmentResult: enrichmentResult ? { dismissed: enrichmentResult.dismissed, runStatus: enrichmentResult.runStatus } : "skipped (awaitingEnrichment=0)",
    finalCounts,
  }, { label: "bridge.gmail.run_downstream" }) };
}
