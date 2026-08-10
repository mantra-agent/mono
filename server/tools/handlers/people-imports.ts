import type { ToolHandlerResult } from "../contracts";

/**
 * People import-triage handlers extracted from bridge-tools.ts: scan_imports,
 * the import decision-service API surface, and scan_ignored. Behavior, result
 * shapes, and error handling are preserved verbatim; public identity
 * (tool-registry), ownership/composition (domain-adapters), and the executeTool
 * invocation/authority boundary remain owned by their canonical modules.
 */

// Triage doctrine lives here — at the moment of use — not in the always-on
// people schema. scan_imports is the entry call for import triage, so the model
// reads how to triage well exactly when it is about to, and never carries it otherwise.
const IMPORT_TRIAGE_GUIDANCE =
  "Import triage: account for every candidate exactly once and name every skip. Generic, role-based, and automated senders should be skipped unless the user identifies a real relationship.";

async function handlePeopleScanImports(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { loadQueueState, getPendingCandidates } = await import("../../import-queue");
  const queueState = await loadQueueState();
  const pending = getPendingCandidates(queueState);
  if (pending.length === 0) return { result: "No pending import candidates." };
  const lines = pending.map(c => {
    const total = c.sentCount + c.receivedCount;
    const parts = [
      `- **${c.name}** <${c.email}>`,
      `  sent: ${c.sentCount}, received: ${c.receivedCount}, total: ${total}, threads: ${c.threadCount}`,
      `  first: ${c.firstInteraction}, last: ${c.lastInteraction}`,
    ];
    if (c.sampleSubjects && c.sampleSubjects.length > 0) {
      parts.push(`  subjects: ${c.sampleSubjects.slice(0, 5).join("; ")}`);
    }
    if (c.interactions && c.interactions.length > 0) {
      const recentIx = c.interactions.slice(0, 5);
      parts.push(`  recent interactions: ${recentIx.map(ix => `[${ix.date}] ${ix.direction}: ${ix.subject}`).join("; ")}`);
    }
    return parts.join("\n");
  });
  return { result: `${IMPORT_TRIAGE_GUIDANCE}\n\n${pending.length} pending import candidates:\n\n${lines.join("\n\n")}` };
}

async function handlePeopleImportApi(args: Record<string, any>): Promise<ToolHandlerResult> {
  const service = await import("../../people-import-decision-service");
  const action = String(args.action || "");
  if (action === "search_import_candidates") return { result: JSON.stringify(await service.searchImportCandidates({ query: args.query, candidateId: args.candidateId, decision: args.decision, limit: args.limit, offset: args.offset }), null, 2) };
  if (action === "list_import_candidates") return { result: JSON.stringify(await service.listImportCandidates({ limit: args.limit, offset: args.offset }), null, 2) };
  if (action === "get_import_candidate") return { result: JSON.stringify(await service.getImportCandidate(String(args.candidateId || "")), null, 2) };
  if (action === "find_import_matches") return { result: JSON.stringify(await service.findImportMatches(String(args.candidateId || ""), args.limit), null, 2) };
  if (action === "add_import_candidate") return { result: JSON.stringify(await service.addImportCandidate({ ...args, candidateId: String(args.candidateId || "") }), null, 2) };
  if (action === "merge_import_candidate") return { result: JSON.stringify(await service.mergeImportCandidate({ ...args, candidateId: String(args.candidateId || ""), mergePersonId: args.personId || args.mergePersonId }), null, 2) };
  if (action === "skip_import_candidate") return { result: JSON.stringify(await service.skipImportCandidate({ ...args, candidateId: String(args.candidateId || "") }), null, 2) };
  if (action === "undo_import_decision") return { result: JSON.stringify(await service.undoImportDecision(String(args.decisionId || ""), String(args.idempotencyKey || "")), null, 2) };
  if (action === "preview_import_batch") return { result: JSON.stringify(await service.previewImportBatch(args.decisions || []), null, 2) };
  if (action === "apply_import_batch") return { result: JSON.stringify(await service.applyImportBatch(String(args.batchId || ""), String(args.batchToken || ""), String(args.idempotencyKey || "")), null, 2) };
  if (action === "get_import_batch") return { result: JSON.stringify(await service.getImportBatch(String(args.batchId || "")), null, 2) };
  return { result: `Unsupported People import action: ${action}`, error: true };
}

async function handlePeopleScanIgnored(): Promise<ToolHandlerResult> {
  const { peopleStorage } = await import("../../people-storage");
  const skipList = await peopleStorage.getGmailSkipList();
  if (skipList.length === 0) return { result: "No entries on the Gmail skip/ignore list." };
  const lines = skipList.map(e => `- ${e.name || "(no name)"} <${e.email}> — skipped ${e.skippedAt}`);
  return { result: `${skipList.length} ignored contacts:\n${lines.join("\n")}` };
}

/** action → handler map for the people import-triage surface. */
export const peopleImportHandlers: Record<string, (args: Record<string, any>) => Promise<ToolHandlerResult>> = {
  scan_imports: handlePeopleScanImports,
  search_import_candidates: handlePeopleImportApi,
  list_import_candidates: handlePeopleImportApi,
  get_import_candidate: handlePeopleImportApi,
  find_import_matches: handlePeopleImportApi,
  add_import_candidate: handlePeopleImportApi,
  merge_import_candidate: handlePeopleImportApi,
  skip_import_candidate: handlePeopleImportApi,
  undo_import_decision: handlePeopleImportApi,
  preview_import_batch: handlePeopleImportApi,
  apply_import_batch: handlePeopleImportApi,
  get_import_batch: handlePeopleImportApi,
  scan_ignored: handlePeopleScanIgnored,
};
