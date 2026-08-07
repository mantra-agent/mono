import { safeStringify } from "../utils/safe-stringify";
import { businessPlanStorage } from "../business-plan-storage";
import { kpiStorage, metricsStorage } from "../metrics-storage";
import type { BusinessPlan } from "@shared/schema";
import type { Kpi, Metric, MetricSample } from "@shared/models/metrics";
import type { ToolHandler } from "../bridge-tools";

// The `business` tool owns three separate action groups behind one bounded
// context: Business Plans, KPIs, and Metrics. Plans compose goals + initiatives
// + KPI references; KPIs score a metric with bands; Metrics are the raw series.
// KPI/Metric persistence is delegated to the canonical vault-scoped storages.

function planResult(plan: BusinessPlan) {
  return {
    reference: `@business_plan:${plan.id}`,
    id: plan.id,
    name: plan.name,
    vaultId: plan.vaultId,
    thematicGoalId: plan.thematicGoalId,
    initiativeProjectIds: plan.initiativeProjectIds,
    kpiIds: plan.kpiIds,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

function kpiResult(kpi: Kpi) {
  return {
    reference: `@kpi:${kpi.id}`,
    id: kpi.id,
    metricId: kpi.metricId,
    name: kpi.name,
    slug: kpi.slug,
    description: kpi.description,
    targetLabel: kpi.targetLabel,
    cadence: kpi.cadence,
    ownerLabel: kpi.ownerLabel,
    direction: kpi.direction,
    bullThreshold: kpi.bullThreshold,
    onTrackThreshold: kpi.onTrackThreshold,
    bearThreshold: kpi.bearThreshold,
    staleAfterHours: kpi.staleAfterHours,
    standingObjectiveKey: kpi.standingObjectiveKey,
    status: kpi.status,
    vaultId: kpi.vaultId,
    score: kpi.score,
    createdAt: kpi.createdAt,
    updatedAt: kpi.updatedAt,
  };
}

function metricResult(metric: Metric) {
  return {
    reference: `@metric:${metric.id}`,
    id: metric.id,
    name: metric.name,
    slug: metric.slug,
    description: metric.description,
    unit: metric.unit,
    direction: metric.direction,
    samplePeriod: metric.samplePeriod,
    adapterKind: metric.adapterKind,
    status: metric.status,
    vaultId: metric.vaultId,
    latestSample: metric.latestSample,
    createdAt: metric.createdAt,
    updatedAt: metric.updatedAt,
  };
}

function sampleResult(sample: MetricSample) {
  return {
    id: sample.id,
    metricId: sample.metricId,
    value: sample.value,
    unit: sample.unit,
    observedAt: sample.observedAt,
    sourceRef: sample.sourceRef,
    evidence: sample.evidence,
    periodStart: sample.periodStart,
    periodEnd: sample.periodEnd,
  };
}

function requiredStr(args: Record<string, unknown>, field: string): string | null {
  const value = String(args[field] ?? "").trim();
  return value || null;
}

/** Read an optional finite number; returns undefined when absent/blank, null when explicitly null. */
function optionalNumber(args: Record<string, unknown>, field: string): number | null | undefined {
  const raw = args[field];
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function optionalStr(args: Record<string, unknown>, field: string): string | undefined {
  const raw = args[field];
  if (raw === undefined || raw === null) return undefined;
  const value = String(raw);
  return value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.map((v) => String(v)).filter((v) => v.length > 0);
  return out.length > 0 ? out : undefined;
}

function optionalStandingObjectiveKey(args: Record<string, unknown>): string | null | undefined {
  const value = optionalStr(args, "standingObjectiveKey");
  return value === "none" ? null : value;
}

function safeBusinessError(error: unknown): string {
  if (error && typeof error === "object") {
    const candidate = error as { status?: unknown; message?: unknown; issues?: unknown };
    if (Array.isArray(candidate.issues) && typeof candidate.message === "string") return candidate.message;
    if (typeof candidate.status === "number" && candidate.status >= 400 && candidate.status < 500 && typeof candidate.message === "string") {
      return candidate.message;
    }
  }
  return "Business operation failed";
}

async function handlePlanAction(action: string, args: Record<string, unknown>) {
  if (action === "list") {
    const plans = await businessPlanStorage.list();
    return { result: safeStringify({ total: plans.length, plans: plans.map(planResult) }, { label: "bridge.business.plans.list" }) };
  }
  if (action === "get") {
    const id = requiredStr(args, "id");
    if (!id) return { result: "business.get requires id", error: true };
    const plan = await businessPlanStorage.get(id);
    return plan
      ? { result: safeStringify(planResult(plan), { label: "bridge.business.plans.get" }) }
      : { result: `Business Plan "${id}" not found or not visible`, error: true };
  }
  if (action === "create") {
    const name = requiredStr(args, "name");
    if (!name) return { result: "business.create requires name", error: true };
    const plan = await businessPlanStorage.create({
      name,
      ...(requiredStr(args, "vaultId") ? { vaultId: requiredStr(args, "vaultId")! } : {}),
      ...(requiredStr(args, "goalId") ? { thematicGoalId: requiredStr(args, "goalId")! } : {}),
    });
    return { result: safeStringify(planResult(plan), { label: "bridge.business.plans.create" }) };
  }

  const id = requiredStr(args, "id");
  if (!id) return { result: `business.${action} requires id`, error: true };

  if (action === "rename") {
    const name = requiredStr(args, "name");
    if (!name) return { result: "business.rename requires name", error: true };
    return { result: safeStringify(planResult(await businessPlanStorage.update(id, { name })), { label: "bridge.business.plans.rename" }) };
  }
  if (action === "delete") {
    await businessPlanStorage.remove(id);
    return { result: `Deleted @business_plan:${id}` };
  }
  if (action === "set_thematic_goal") {
    const goalId = requiredStr(args, "goalId");
    if (!goalId) return { result: "business.set_thematic_goal requires goalId", error: true };
    return { result: safeStringify(planResult(await businessPlanStorage.update(id, { thematicGoalId: goalId })), { label: "bridge.business.plans.set_goal" }) };
  }
  if (action === "clear_thematic_goal") {
    return { result: safeStringify(planResult(await businessPlanStorage.update(id, { thematicGoalId: null })), { label: "bridge.business.plans.clear_goal" }) };
  }
  if (action === "assign_vault") {
    const vaultId = requiredStr(args, "vaultId");
    if (!vaultId) return { result: "business.assign_vault requires vaultId", error: true };
    return { result: safeStringify(planResult(await businessPlanStorage.update(id, { vaultId })), { label: "bridge.business.plans.assign_vault" }) };
  }
  if (action === "add_initiative" || action === "remove_initiative") {
    const projectId = Number(args.projectId);
    if (!Number.isInteger(projectId) || projectId <= 0) return { result: `business.${action} requires a positive projectId`, error: true };
    const plan = await businessPlanStorage.mutateInitiative(id, projectId, action === "add_initiative" ? "add" : "remove");
    return { result: safeStringify(planResult(plan), { label: `bridge.business.plans.${action}` }) };
  }
  if (action === "add_kpi" || action === "remove_kpi") {
    const kpiId = requiredStr(args, "kpiId");
    if (!kpiId) return { result: `business.${action} requires kpiId`, error: true };
    const plan = await businessPlanStorage.mutateKpi(id, kpiId, action === "add_kpi" ? "add" : "remove");
    return { result: safeStringify(planResult(plan), { label: `bridge.business.plans.${action}` }) };
  }
  return { result: `Unknown business plan action: ${action}`, error: true };
}

async function handleKpiAction(action: string, args: Record<string, unknown>) {
  if (action === "list_kpis") {
    const kpis = await kpiStorage.list(optionalStr(args, "query"));
    return { result: safeStringify({ total: kpis.length, kpis: kpis.map(kpiResult) }, { label: "bridge.business.kpis.list" }) };
  }
  if (action === "get_kpi") {
    const kpiId = requiredStr(args, "kpiId");
    if (!kpiId) return { result: "business.get_kpi requires kpiId", error: true };
    return { result: safeStringify(kpiResult(await kpiStorage.get(kpiId)), { label: "bridge.business.kpis.get" }) };
  }
  if (action === "create_kpi") {
    const metricId = requiredStr(args, "metricId");
    const name = requiredStr(args, "name");
    if (!metricId) return { result: "business.create_kpi requires metricId (create the metric first)", error: true };
    if (!name) return { result: "business.create_kpi requires name", error: true };
    const kpi = await kpiStorage.create({
      metricId,
      name,
      slug: optionalStr(args, "slug"),
      description: optionalStr(args, "description"),
      targetLabel: optionalStr(args, "targetLabel"),
      cadence: optionalStr(args, "cadence"),
      ownerLabel: optionalStr(args, "ownerLabel"),
      direction: optionalStr(args, "direction") as any,
      bullThreshold: optionalNumber(args, "bullThreshold"),
      onTrackThreshold: optionalNumber(args, "onTrackThreshold"),
      bearThreshold: optionalNumber(args, "bearThreshold"),
      staleAfterHours: optionalNumber(args, "staleAfterHours") ?? undefined,
      standingObjectiveKey: optionalStandingObjectiveKey(args) as any,
      status: optionalStr(args, "status") as any,
    });
    return { result: safeStringify(kpiResult(kpi), { label: "bridge.business.kpis.create" }) };
  }
  if (action === "update_kpi") {
    const kpiId = requiredStr(args, "kpiId");
    if (!kpiId) return { result: "business.update_kpi requires kpiId", error: true };
    const kpi = await kpiStorage.update(kpiId, {
      metricId: optionalStr(args, "metricId"),
      name: optionalStr(args, "name"),
      description: optionalStr(args, "description"),
      targetLabel: optionalStr(args, "targetLabel"),
      cadence: optionalStr(args, "cadence"),
      ownerLabel: optionalStr(args, "ownerLabel"),
      direction: optionalStr(args, "direction") as any,
      bullThreshold: optionalNumber(args, "bullThreshold"),
      onTrackThreshold: optionalNumber(args, "onTrackThreshold"),
      bearThreshold: optionalNumber(args, "bearThreshold"),
      staleAfterHours: optionalNumber(args, "staleAfterHours") ?? undefined,
      standingObjectiveKey: optionalStandingObjectiveKey(args) as any,
      status: optionalStr(args, "status") as any,
      clearFields: stringArray(args.clearFields) as any,
    });
    return { result: safeStringify(kpiResult(kpi), { label: "bridge.business.kpis.update" }) };
  }
  if (action === "delete_kpi") {
    const kpiId = requiredStr(args, "kpiId");
    if (!kpiId) return { result: "business.delete_kpi requires kpiId", error: true };
    await kpiStorage.delete(kpiId);
    return { result: `Deleted @kpi:${kpiId}` };
  }
  return { result: `Unknown business KPI action: ${action}`, error: true };
}

async function handleMetricAction(action: string, args: Record<string, unknown>) {
  if (action === "list_metrics") {
    const metrics = await metricsStorage.list(optionalStr(args, "query"));
    return { result: safeStringify({ total: metrics.length, metrics: metrics.map(metricResult) }, { label: "bridge.business.metrics.list" }) };
  }
  if (action === "get_metric") {
    const metricId = requiredStr(args, "metricId");
    if (!metricId) return { result: "business.get_metric requires metricId", error: true };
    return { result: safeStringify(metricResult(await metricsStorage.get(metricId)), { label: "bridge.business.metrics.get" }) };
  }
  if (action === "create_metric") {
    const name = requiredStr(args, "name");
    if (!name) return { result: "business.create_metric requires name", error: true };
    const metric = await metricsStorage.create({
      name,
      slug: optionalStr(args, "slug"),
      description: optionalStr(args, "description"),
      unit: optionalStr(args, "unit"),
      direction: optionalStr(args, "direction") as any,
      samplePeriod: optionalStr(args, "samplePeriod") as any,
      adapterKind: optionalStr(args, "adapterKind") as any,
      status: optionalStr(args, "status") as any,
    });
    return { result: safeStringify(metricResult(metric), { label: "bridge.business.metrics.create" }) };
  }
  if (action === "update_metric") {
    const metricId = requiredStr(args, "metricId");
    if (!metricId) return { result: "business.update_metric requires metricId", error: true };
    const metric = await metricsStorage.update(metricId, {
      name: optionalStr(args, "name"),
      description: optionalStr(args, "description"),
      unit: optionalStr(args, "unit"),
      direction: optionalStr(args, "direction") as any,
      samplePeriod: optionalStr(args, "samplePeriod") as any,
      adapterKind: optionalStr(args, "adapterKind") as any,
      status: optionalStr(args, "status") as any,
      clearFields: stringArray(args.clearFields) as any,
    });
    return { result: safeStringify(metricResult(metric), { label: "bridge.business.metrics.update" }) };
  }
  if (action === "delete_metric") {
    const metricId = requiredStr(args, "metricId");
    if (!metricId) return { result: "business.delete_metric requires metricId", error: true };
    await metricsStorage.delete(metricId);
    return { result: `Deleted @metric:${metricId}` };
  }
  if (action === "list_samples") {
    const metricId = requiredStr(args, "metricId");
    if (!metricId) return { result: "business.list_samples requires metricId", error: true };
    const limit = optionalNumber(args, "limit");
    const samples = await metricsStorage.listSamples(metricId, limit ?? undefined);
    return { result: safeStringify({ total: samples.length, samples: samples.map(sampleResult) }, { label: "bridge.business.metrics.list_samples" }) };
  }
  if (action === "delete_sample") {
    const sampleId = requiredStr(args, "sampleId");
    if (!sampleId) return { result: "business.delete_sample requires sampleId", error: true };
    const sample = await metricsStorage.deleteSample(sampleId);
    return { result: `Deleted metric sample ${sample.id}` };
  }
  if (action === "record_sample") {
    const metricId = requiredStr(args, "metricId");
    const value = optionalNumber(args, "value");
    if (!metricId) return { result: "business.record_sample requires metricId", error: true };
    if (value === undefined || value === null) return { result: "business.record_sample requires a numeric value", error: true };
    const sample = await metricsStorage.recordSample({
      metricId,
      value,
      unit: optionalStr(args, "unit"),
      observedAt: optionalStr(args, "observedAt"),
      sourceRef: optionalStr(args, "sourceRef"),
      evidence: optionalStr(args, "evidence") ?? undefined,
      periodStart: optionalStr(args, "periodStart") ?? undefined,
      periodEnd: optionalStr(args, "periodEnd") ?? undefined,
    });
    return { result: safeStringify(sampleResult(sample), { label: "bridge.business.metrics.record_sample" }) };
  }
  return { result: `Unknown business metric action: ${action}`, error: true };
}

const PLAN_ACTIONS = new Set([
  "list", "get", "create", "rename", "delete", "set_thematic_goal", "clear_thematic_goal",
  "add_initiative", "remove_initiative", "add_kpi", "remove_kpi", "assign_vault",
]);
const KPI_ACTIONS = new Set(["list_kpis", "get_kpi", "create_kpi", "update_kpi", "delete_kpi"]);
const METRIC_ACTIONS = new Set([
  "list_metrics", "get_metric", "create_metric", "update_metric", "delete_metric",
  "list_samples", "record_sample", "delete_sample",
]);

export const handleBusiness: ToolHandler = async (args) => {
  const action = String(args.action || "list");
  try {
    if (KPI_ACTIONS.has(action)) return await handleKpiAction(action, args);
    if (METRIC_ACTIONS.has(action)) return await handleMetricAction(action, args);
    if (PLAN_ACTIONS.has(action)) return await handlePlanAction(action, args);
    return { result: `Unknown business action: ${action}`, error: true };
  } catch (error: unknown) {
    return { result: safeBusinessError(error), error: true };
  }
};
