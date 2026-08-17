import type { ToolHandler, ToolHandlerResult } from "../contracts";
import { inputFailure } from "../../tool-failure";
import { contractReject } from "../shared/failures";

/** Stamp bare contract rejects so Executor does not page uncoded TOOL_FAILED_DECISIONS. */
function stampDecisionReject(
  outcome: { result: string; error?: boolean; failure?: import("../../tool-failure").ToolFailure },
): ToolHandlerResult {
  if (!outcome.error || outcome.failure) return outcome as ToolHandlerResult;
  return contractReject(outcome.result, "decision_input_invalid", String(outcome.result).slice(0, 200));
}

function decisionClientErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const status = (error as { status?: unknown }).status;
  if (typeof status !== "number" || !Number.isFinite(status)) return null;
  if (status < 400 || status >= 500) return null;
  return status;
}

/** Decision-domain adapter extracted from bridge-tools without changing storage, event, rich-text, or authority boundaries. */
export const decisionsHandler: ToolHandler = async (args) => {
  const { decisionsStorage } = await import("../../decisions-storage");
  const { eventBus } = await import("../../event-bus");
  const { markdownToTiptap } = await import("../../../shared/markdown-tiptap");
  const { decisionStatuses, decisionTrafficLights } = await import("@shared/schema");
  type DecisionRow = Awaited<ReturnType<typeof decisionsStorage.getDecision>>;
  type DecisionFull = NonNullable<DecisionRow>;

  const action = (args.action as string | undefined) || "list";

  const sectionToFields = (section: "data" | "scenarios" | "plan", markdown: string): Record<string, unknown> => {
    const json = markdownToTiptap(markdown || "");
    if (section === "data") return { dataContent: json, dataPlainText: markdown };
    if (section === "scenarios") return { scenariosContent: json, scenariosPlainText: markdown };
    return { planContent: json, planPlainText: markdown };
  };

  const summarize = (d: DecisionFull): string => {
    const lines = [
      `[${d.id}] ${d.title}`,
      `  status=${d.status}${d.trafficLight ? ` trafficLight=${d.trafficLight}` : ""}`,
      d.description ? `  ${d.description}` : null,
      d.dataPlainText ? `  data: ${d.dataPlainText.slice(0, 120)}` : null,
      d.scenariosPlainText ? `  scenarios: ${d.scenariosPlainText.slice(0, 120)}` : null,
      d.planPlainText ? `  plan: ${d.planPlainText.slice(0, 120)}` : null,
    ].filter((l): l is string => Boolean(l));
    return lines.join("\n");
  };

  const publish = (source: string): void => {
    eventBus.publish({ category: "system", event: "data:decisions_changed", payload: { source: `bridge_tool:${source}` } });
  };

  const requireString = (v: unknown, name: string): string => {
    if (typeof v !== "string" || !v) throw new Error(`Missing required: ${name}`);
    return v;
  };

  type DecisionsArgs = {
    action?: string;
    id?: string;
    title?: string;
    description?: string;
    status?: string;
    dataContent?: string;
    scenariosContent?: string;
    planContent?: string;
    trafficLight?: string;
    content?: string;
    updateId?: string;
    targetAddress?: string;
    targetType?: string;
    targetId?: string | number;
    predicate?: "relates_to" | "governs" | "guided_by" | "governed_by" | "decided_by" | "evidence_for" | "triggered_by" | "produced";
    linkId?: string;
    reasoning?: string;
    ownerPersonRole?: "self" | "partner";
    principleRevisionIds?: string[];
    sourceSessionId?: string;
    sourceToolCallId?: string;
    triggeredByAddress?: string;
    answerPayload?: Record<string, unknown>;
  };
  const a = args as DecisionsArgs;

  try {
    switch (action) {
      case "list": {
        const statusRaw = a.status;
        let status: "open" | "closed" | undefined;
        if (statusRaw && statusRaw !== "all") {
          if (!(decisionStatuses as readonly string[]).includes(statusRaw)) {
            return stampDecisionReject({ result: `Invalid status: ${statusRaw}. Use open, closed, or all.`, error: true });
          }
          status = statusRaw as "open" | "closed";
        }
        const list = await decisionsStorage.listDecisions(status ? { status } : undefined);
        if (list.length === 0) return { result: status ? `No ${status} decisions.` : "No decisions found." };
        return { result: `${list.length} decision(s):\n${list.map(summarize).join("\n\n")}` };
      }
      case "get": {
        const id = requireString(a.id, "id");
        const d = await decisionsStorage.getDecision(id);
        if (!d) return stampDecisionReject({ result: `Decision ${id} not found`, error: true });
        const updates = await decisionsStorage.listUpdates(id);
        const links = await decisionsStorage.listLinks(id);
        const sections = [
          summarize(d),
          d.dataPlainText ? `\nData:\n${d.dataPlainText}` : "",
          d.scenariosPlainText ? `\nScenarios:\n${d.scenariosPlainText}` : "",
          d.planPlainText ? `\nPlan:\n${d.planPlainText}` : "",
          links.length ? `\nLinks:\n${links.map(l => `  - ${l.targetType}:${l.targetId}`).join("\n")}` : "",
          updates.length ? `\nUpdates (${updates.length}):\n${updates.map(u => `  - [${u.id}] ${u.createdAt.toISOString?.() ?? u.createdAt} ${u.content.slice(0, 200)}`).join("\n")}` : "",
        ].filter(Boolean).join("\n");
        return { result: sections };
      }
      case "create": {
        const title = requireString(a.title, "title");
        const fields: Record<string, unknown> = { title };
        if (typeof a.description === "string") fields.description = a.description;
        if (typeof a.dataContent === "string") Object.assign(fields, sectionToFields("data", a.dataContent));
        if (typeof a.scenariosContent === "string") Object.assign(fields, sectionToFields("scenarios", a.scenariosContent));
        if (typeof a.planContent === "string") Object.assign(fields, sectionToFields("plan", a.planContent));
        const row = await decisionsStorage.createDecision(fields as Parameters<typeof decisionsStorage.createDecision>[0]);
        publish("create");
        return { result: `Created decision ${row.id} "${row.title}" (${row.status}).` };
      }
      case "record_judgment": {
        const title = requireString(a.title, "title");
        const ownerPersonRole = a.ownerPersonRole === "partner" || a.ownerPersonRole === "self" ? a.ownerPersonRole : "self";
        const principleRevisionIds = Array.isArray(a.principleRevisionIds)
          ? a.principleRevisionIds.filter((id: unknown): id is string => typeof id === "string" && id.trim().length > 0)
          : undefined;
        const answerPayload = a.answerPayload && typeof a.answerPayload === "object" && !Array.isArray(a.answerPayload)
          ? a.answerPayload as Record<string, unknown>
          : undefined;
        const result = await decisionsStorage.recordJudgment({
          title,
          description: typeof a.description === "string" ? a.description : undefined,
          reasoning: typeof a.reasoning === "string" ? a.reasoning : undefined,
          ownerPersonRole,
          principleRevisionIds,
          sourceSessionId: typeof a.sourceSessionId === "string" ? a.sourceSessionId : undefined,
          sourceToolCallId: typeof a.sourceToolCallId === "string" ? a.sourceToolCallId : undefined,
          triggeredByAddress: typeof a.triggeredByAddress === "string" ? a.triggeredByAddress : undefined,
          answerPayload,
          status: "closed",
        });
        publish("record_judgment");
        const links = await decisionsStorage.listLinks(result.decision.id);
        return {
          result: [
            `${result.outcome === "replayed" ? "Replayed" : "Recorded"} judgment ${result.decision.id} "${result.decision.title}" (${result.decision.status}).`,
            result.decision.ownerPersonId ? `ownerPerson=${result.decision.ownerPersonId}` : null,
            result.decision.reasoning ? `reasoning=${result.decision.reasoning}` : null,
            links.length ? `links:\n${links.map((l) => `  - ${l.predicate} -> ${l.targetAddress}`).join("\n")}` : "links: none",
          ].filter(Boolean).join("\n"),
        };
      }
      case "update": {
        const id = requireString(a.id, "id");
        const updates: Record<string, unknown> = {};
        if (a.title !== undefined) updates.title = String(a.title);
        if (a.description !== undefined) updates.description = String(a.description);
        if (a.trafficLight !== undefined) {
          if (a.trafficLight !== null && !(decisionTrafficLights as readonly string[]).includes(a.trafficLight)) {
            return stampDecisionReject({ result: `Invalid trafficLight: ${a.trafficLight}. Use green, yellow, or red.`, error: true });
          }
          updates.trafficLight = a.trafficLight;
        }
        if (typeof a.dataContent === "string") Object.assign(updates, sectionToFields("data", a.dataContent));
        if (typeof a.scenariosContent === "string") Object.assign(updates, sectionToFields("scenarios", a.scenariosContent));
        if (typeof a.planContent === "string") Object.assign(updates, sectionToFields("plan", a.planContent));
        const row = await decisionsStorage.updateDecision(id, updates);
        if (!row) return stampDecisionReject({ result: `Decision ${id} not found`, error: true });
        publish("update");
        return { result: `Updated decision ${row.id}.` };
      }
      case "delete": {
        const id = requireString(a.id, "id");
        const ok = await decisionsStorage.deleteDecision(id);
        if (!ok) return stampDecisionReject({ result: `Decision ${id} not found`, error: true });
        publish("delete");
        return { result: `Deleted decision ${id}.` };
      }
      case "lock": {
        const id = requireString(a.id, "id");
        const row = await decisionsStorage.lockDecision(id);
        if (!row) return stampDecisionReject({ result: `Decision ${id} not found`, error: true });
        publish("lock");
        return { result: `Locked decision ${id}. trafficLight=${row.trafficLight ?? "green"}.` };
      }
      case "reopen": {
        const id = requireString(a.id, "id");
        const row = await decisionsStorage.reopenDecision(id);
        if (!row) return stampDecisionReject({ result: `Decision ${id} not found`, error: true });
        publish("reopen");
        return { result: `Reopened decision ${id}.` };
      }
      case "add_update": {
        const id = requireString(a.id, "id");
        const content = requireString(a.content, "content");
        const d = await decisionsStorage.getDecision(id);
        if (!d) return stampDecisionReject({ result: `Decision ${id} not found`, error: true });
        if (d.status !== "closed") {
          return stampDecisionReject({
            result: `Decision ${id} is not closed; updates only allowed on closed decisions.`,
            error: true,
          });
        }
        const row = await decisionsStorage.addUpdate({ decisionId: id, content });
        publish("add_update");
        return { result: `Added update ${row.id} to decision ${id}.` };
      }
      case "edit_update": {
        const updateId = requireString(a.updateId, "updateId");
        const content = requireString(a.content, "content");
        const row = await decisionsStorage.editUpdate(updateId, content);
        if (!row) return stampDecisionReject({ result: `Update ${updateId} not found`, error: true });
        publish("edit_update");
        return { result: `Edited update ${updateId}.` };
      }
      case "delete_update": {
        const updateId = requireString(a.updateId, "updateId");
        const ok = await decisionsStorage.deleteUpdate(updateId);
        if (!ok) return stampDecisionReject({ result: `Update ${updateId} not found`, error: true });
        publish("delete_update");
        return { result: `Deleted update ${updateId}.` };
      }
      case "add_link": {
        const id = requireString(a.id, "id");
        const targetAddress = a.targetAddress ?? (a.targetType && a.targetId !== undefined ? `@${a.targetType}:${String(a.targetId)}` : undefined);
        if (!targetAddress) return stampDecisionReject({ result: "Missing required: targetAddress", error: true });
        const row = await decisionsStorage.addLink({ decisionId: id, targetAddress, predicate: a.predicate });
        publish("add_link");
        return { result: `Linked @decision:${id} → ${row.targetAddress} via ${row.predicate} (link ${row.id}).` };
      }
      case "remove_link": {
        const linkId = requireString(a.linkId, "linkId");
        const ok = await decisionsStorage.deleteLink(linkId);
        if (!ok) return stampDecisionReject({ result: `Link ${linkId} not found`, error: true });
        publish("remove_link");
        return { result: `Removed link ${linkId}.` };
      }
      default:
        return stampDecisionReject({
          result: `Unknown decisions action: ${action}. Available: list, get, create, update, delete, lock, reopen, add_update, edit_update, delete_update, add_link, remove_link, record_judgment`,
          error: true,
        });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Storage throws status:400 for caller-correctable contract rejects
    // (stale principle revision, bad link target/predicate, missing required).
    if (decisionClientErrorStatus(err) !== null || /^Missing required:/.test(message)) {
      return {
        result: `Decisions tool error: ${message}`,
        error: true,
        failure: inputFailure("decision_input_invalid", message.slice(0, 200)),
      };
    }
    return { result: `Decisions tool error: ${message}`, error: true };
  }
};
