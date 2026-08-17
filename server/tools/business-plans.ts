import { safeStringify } from "../utils/safe-stringify";
import { quarterToMonth } from "@shared/models/business-hiring";
import { businessPlanStorage } from "../business-plan-storage";
import { businessStorage, type Business } from "../business-storage";
import { businessCreateSchema, businessPatchSchema } from "@shared/schema";
import { kpiStorage, metricsStorage } from "../metrics/core-engine";
import type { BusinessPlan } from "@shared/schema";
import type { Kpi, Metric, MetricSample } from "@shared/models/metrics";
import {
  budgetMonthlyTotal,
  categoryMonthlyTotal,
  departmentMonthlyTotal,
  type BusinessBudget,
  type BusinessBudgetMutation,
} from "@shared/models/business-budgets";
import type { ToolHandler } from "./contracts";
import { inputFailure, internalFailure } from "../tool-failure";

// The Business Mod's `business` tool composes Business identity, Budgets,
// Plans, KPIs, and Metrics behind one bounded action surface. Every action
// delegates to its domain's canonical principal/Vault-scoped storage.

function planResult(plan: BusinessPlan) {
  return {
    reference: `@business_plan:${plan.id}`,
    id: plan.id,
    name: plan.name,
    vaultId: plan.vaultId,
    thematicGoalId: plan.thematicGoalId,
    initiativeProjectIds: plan.initiativeProjectIds,
    initiativeMeasurementBindings: plan.initiativeMeasurementBindings,
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

/** Caller-correctable HTTP 4xx / Zod-style validation thrown by storage helpers. */
function businessClientErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const status = (error as { status?: unknown }).status;
  if (typeof status !== "number" || !Number.isFinite(status)) return null;
  if (status < 400 || status >= 500) return null;
  return status;
}

/**
 * Bare `{ error: true }` returns are contract rejects (missing args, bad enums).
 * Stamp them input so reliability does not page them as uncoded TOOL_FAILED_BUSINESS
 * or as business_internal reds.
 */
function stampBusinessContractReject(
  action: string,
  outcome: { result: string; error?: boolean; failure?: import("../tool-failure").ToolFailure },
) {
  if (!outcome.error || outcome.failure) return outcome;
  const detail = `${action}:${String(outcome.result).slice(0, 200)}`;
  return {
    ...outcome,
    failure: inputFailure("business_input_invalid", detail),
  };
}

function businessResult(business: Business) {
  return {
    reference: `@business:${business.id}`,
    id: business.id,
    publicName: business.publicName,
    entityName: business.entityName,
    valuesPageId: business.valuesPageId,
    visionPageId: business.visionPageId,
    missionPageId: business.missionPageId,
    phasesPageId: business.phasesPageId,
    pitchPageId: business.pitchPageId,
    gtmPageId: business.gtmPageId,
    productPageId: business.productPageId,
    brandPageId: business.brandPageId,
    differentiatorsPageId: business.differentiatorsPageId,
    marketPageId: business.marketPageId,
    icpPageId: business.icpPageId,
    activationPageId: business.activationPageId,
    moatPageId: business.moatPageId,
    status: business.status,
    vaultIds: business.vaultIds,
    createdAt: business.createdAt,
    updatedAt: business.updatedAt,
  };
}

function budgetResult(budget: BusinessBudget) {
  return {
    id: budget.id,
    businessId: budget.businessId,
    currency: budget.currency,
    monthlyTotalCents: budgetMonthlyTotal(budget.departments),
    departments: budget.departments.map((department) => ({
      ...department,
      monthlyTotalCents: departmentMonthlyTotal(department),
      categories: department.categories.map((category) => ({
        ...category,
        monthlyTotalCents: categoryMonthlyTotal(category),
      })),
    })),
    createdAt: budget.createdAt,
    updatedAt: budget.updatedAt,
  };
}

const BUDGET_MUTATION_ACTIONS = {
  add_budget_department: "add_department",
  rename_budget_department: "rename_department",
  delete_budget_department: "delete_department",
  add_budget_category: "add_category",
  rename_budget_category: "rename_category",
  delete_budget_category: "delete_category",
  add_budget_line_item: "add_line_item",
  rename_budget_line_item: "rename_line_item",
  delete_budget_line_item: "delete_line_item",
  set_budget_monthly_amount: "set_monthly_amount",
} as const;

async function handleBudgetAction(action: string, args: Record<string, unknown>) {
  const businessId = requiredStr(args, "businessId");
  if (!businessId) return { result: `business.${action} requires businessId`, error: true };
  const { businessBudgetStorage } = await import("../business-budget-storage");
  if (action === "get_budget") {
    const budget = await businessBudgetStorage.get(businessId);
    return { result: safeStringify(budget
      ? { configured: true, ...budgetResult(budget) }
      : { configured: false, businessId, currency: "USD", monthlyTotalCents: 0, departments: [] },
    { label: "bridge.business.budgets.get" }) };
  }

  const mutationAction = BUDGET_MUTATION_ACTIONS[action as keyof typeof BUDGET_MUTATION_ACTIONS];
  if (!mutationAction) return { result: `Unknown business Budget action: ${action}`, error: true };
  const candidate: Record<string, unknown> = { action: mutationAction };
  for (const field of ["name", "departmentId", "categoryId", "lineItemId"] as const) {
    const value = requiredStr(args, field);
    if (value) candidate[field] = value;
  }
  if (mutationAction === "set_monthly_amount") candidate.amountCents = args.monthlyAmountCents;

  const { businessBudgetMutationSchema } = await import("@shared/models/business-budgets");
  const parsed = businessBudgetMutationSchema.safeParse(candidate);
  if (!parsed.success) {
    return { result: `business.${action} invalid: ${parsed.error.issues[0]?.message ?? "bad input"}`, error: true };
  }
  const budget = await businessBudgetStorage.mutate(businessId, parsed.data as BusinessBudgetMutation);
  return { result: safeStringify(budgetResult(budget), { label: `bridge.business.budgets.${action}` }) };
}

async function handleEntityAction(action: string, args: Record<string, unknown>) {
  if (action === "list_businesses") {
    const list = await businessStorage.list();
    return { result: safeStringify({ total: list.length, businesses: list.map(businessResult) }, { label: "bridge.business.entities.list" }) };
  }
  if (action === "create_business") {
    const parsed = businessCreateSchema.safeParse({
      publicName: optionalStr(args, "publicName"),
      entityName: optionalStr(args, "entityName"),
      valuesPageId: optionalStr(args, "valuesPageId"),
      visionPageId: optionalStr(args, "visionPageId"),
      missionPageId: optionalStr(args, "missionPageId"),
      phasesPageId: optionalStr(args, "phasesPageId"),
      pitchPageId: optionalStr(args, "pitchPageId"),
      gtmPageId: optionalStr(args, "gtmPageId"),
      productPageId: optionalStr(args, "productPageId"),
      brandPageId: optionalStr(args, "brandPageId"),
      differentiatorsPageId: optionalStr(args, "differentiatorsPageId"),
      marketPageId: optionalStr(args, "marketPageId"),
      icpPageId: optionalStr(args, "icpPageId"),
      activationPageId: optionalStr(args, "activationPageId"),
      moatPageId: optionalStr(args, "moatPageId"),
      vaultIds: stringArray(args.vaultIds),
    });
    if (!parsed.success) return { result: `business.create_business invalid: ${parsed.error.issues[0]?.message ?? "bad input"}`, error: true };
    const business = await businessStorage.create(parsed.data);
    return { result: safeStringify(businessResult(business), { label: "bridge.business.entities.create" }) };
  }

  const businessId = requiredStr(args, "businessId");
  if (!businessId) return { result: `business.${action} requires businessId`, error: true };

  if (action === "get_business") {
    const business = await businessStorage.get(businessId);
    return business
      ? { result: safeStringify(businessResult(business), { label: "bridge.business.entities.get" }) }
      : { result: `Business "${businessId}" not found or not visible`, error: true };
  }
  if (action === "update_business") {
    const parsed = businessPatchSchema.safeParse({
      publicName: optionalStr(args, "publicName"),
      entityName: optionalStr(args, "entityName"),
      valuesPageId: optionalStr(args, "valuesPageId"),
      visionPageId: optionalStr(args, "visionPageId"),
      missionPageId: optionalStr(args, "missionPageId"),
      phasesPageId: optionalStr(args, "phasesPageId"),
      pitchPageId: optionalStr(args, "pitchPageId"),
      gtmPageId: optionalStr(args, "gtmPageId"),
      productPageId: optionalStr(args, "productPageId"),
      brandPageId: optionalStr(args, "brandPageId"),
      differentiatorsPageId: optionalStr(args, "differentiatorsPageId"),
      marketPageId: optionalStr(args, "marketPageId"),
      icpPageId: optionalStr(args, "icpPageId"),
      activationPageId: optionalStr(args, "activationPageId"),
      moatPageId: optionalStr(args, "moatPageId"),
      status: optionalStr(args, "businessStatus"),
    });
    if (!parsed.success) return { result: `business.update_business invalid: ${parsed.error.issues[0]?.message ?? "bad input"}`, error: true };
    const business = await businessStorage.update(businessId, parsed.data);
    return { result: safeStringify(businessResult(business), { label: "bridge.business.entities.update" }) };
  }
  if (action === "archive_business") {
    const business = await businessStorage.archive(businessId);
    return { result: safeStringify(businessResult(business), { label: "bridge.business.entities.archive" }) };
  }
  if (action === "list_business_vaults") {
    const memberships = await businessStorage.listVaultMemberships(businessId);
    return { result: safeStringify({ total: memberships.length, vaults: memberships }, { label: "bridge.business.entities.list_vaults" }) };
  }
  if (action === "add_business_vault" || action === "remove_business_vault") {
    const vaultId = requiredStr(args, "vaultId");
    if (!vaultId) return { result: `business.${action} requires vaultId`, error: true };
    const { business, changed } = action === "add_business_vault"
      ? await businessStorage.addVaultMembership(businessId, vaultId)
      : await businessStorage.removeVaultMembership(businessId, vaultId);
    return { result: safeStringify({ changed, business: businessResult(business) }, { label: `bridge.business.entities.${action}` }) };
  }
  if (action === "set_business_vaults") {
    const vaultIds = stringArray(args.vaultIds);
    if (!vaultIds || vaultIds.length === 0) return { result: "business.set_business_vaults requires a non-empty vaultIds set", error: true };
    const business = await businessStorage.replaceVaultMemberships(businessId, vaultIds);
    return { result: safeStringify(businessResult(business), { label: "bridge.business.entities.set_vaults" }) };
  }
  return { result: `Unknown business entity action: ${action}`, error: true };
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
  if (action === "set_leading_metric" || action === "set_lagging_kpi" || action === "clear_leading_metric" || action === "clear_lagging_kpi") {
    const projectId = Number(args.projectId);
    if (!Number.isInteger(projectId) || projectId <= 0) return { result: `business.${action} requires a positive projectId`, error: true };
    const kind = action.includes("leading") ? "leading" : "lagging";
    const measurementId = action.startsWith("clear_") ? null : requiredStr(args, kind === "leading" ? "metricId" : "kpiId");
    if (!action.startsWith("clear_") && !measurementId) return { result: `business.${action} requires ${kind === "leading" ? "metricId" : "kpiId"}`, error: true };
    const plan = await businessPlanStorage.setInitiativeMeasurement(id, projectId, kind, measurementId);
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
    const kpis = await kpiStorage.list(optionalStr(args, "query"), optionalStr(args, "businessId"));
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
    const metrics = await metricsStorage.list(optionalStr(args, "query"), optionalStr(args, "businessId"));
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
    const businessId = requiredStr(args, "businessId");
    if (!businessId) return { result: "business.create_metric requires businessId", error: true };
    const metric = await metricsStorage.create({
      businessId,
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
      businessId: optionalStr(args, "businessId"),
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
  if (action === "sample_range" || action === "sample_usage") {
    const start = requiredStr(args, "start");
    const end = requiredStr(args, "end");
    if (!start || !end) return { result: `business.${action} requires start and end`, error: true };
    const businessId = requiredStr(args, "businessId");
    if (!businessId) return { result: "business.sample_range requires businessId", error: true };
    const sample = await metricsStorage.sampleRange(businessId, new Date(start), new Date(end));
    return { result: safeStringify(sample, { label: `bridge.business.metrics.${action}` }) };
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

const ENTITY_ACTIONS = new Set([
  "list_businesses", "get_business", "create_business", "update_business", "archive_business",
  "list_business_vaults", "add_business_vault", "remove_business_vault", "set_business_vaults",
]);
const HIRING_ACTIONS = new Set(["list_hiring_slots", "get_hiring_plan", "create_hiring_slot", "approve_hiring_role", "update_hiring_slot", "cancel_hiring_slot", "remove_hiring_role"]);
async function handleHiringAction(action: string, args: Record<string, unknown>) {
  const businessId = requiredStr(args, "businessId");
  if (!businessId) return { result: `business.${action} requires businessId`, error: true };
  const { businessHiringStorage } = await import("../business-hiring-storage");
  if (action === "list_hiring_slots" || action === "get_hiring_plan") return { result: safeStringify(await businessHiringStorage.projection(businessId), { label: "bridge.business.hiring.list" }) };
  const slotId = requiredStr(args, "hiringSlotId");
  if (action === "remove_hiring_role" && !slotId) return { result: "business.remove_hiring_role requires hiringSlotId", error: true };
  if (action === "cancel_hiring_slot") {
    if (!slotId) return { result: "business.cancel_hiring_slot requires hiringSlotId", error: true };
    return { result: safeStringify(await businessHiringStorage.cancel(businessId, slotId), { label: "bridge.business.hiring.cancel" }) };
  }
  const idempotencyKey = requiredStr(args, "idempotencyKey");
  if (!idempotencyKey) return { result: `business.${action} requires idempotencyKey`, error: true };
  if (action === "remove_hiring_role") action = "cancel_hiring_slot";
  if (action === "approve_hiring_role") action = "create_hiring_slot";
  if (action === "create_hiring_slot") {
    const roleId = requiredStr(args, "roleId");
    const quarter = optionalStr(args, "quarter");
    const approvalMonth = requiredStr(args, "approvalMonth") ?? (quarter ? quarterToMonth(quarter) : null);
    if (!roleId || !approvalMonth) return { result: "business.create_hiring_slot requires roleId and approvalMonth", error: true };
    return { result: safeStringify(await businessHiringStorage.create({ businessId, roleId, approvalMonth, plannedStartMonth: optionalStr(args, "plannedStartMonth"), idempotencyKey }), { label: "bridge.business.hiring.create" }) };
  }
  if (!slotId) return { result: "business.update_hiring_slot requires hiringSlotId", error: true };
  return { result: safeStringify(await businessHiringStorage.update(slotId, { businessId, plannedStartMonth: optionalStr(args, "plannedStartMonth"), clearFields: stringArray(args.clearFields) as ["plannedStartMonth"] | undefined, idempotencyKey }), { label: "bridge.business.hiring.update" }) };
}
const BUDGET_ACTIONS = new Set(["get_budget", ...Object.keys(BUDGET_MUTATION_ACTIONS)]);
const MODEL_WRITE_ACTIONS = new Set(["set_assumption", "link_assumption_kpi", "clear_assumption_kpi"]);
const MODEL_ACTIONS = new Set(["get_model", ...MODEL_WRITE_ACTIONS]);
const PLAN_ACTIONS = new Set([
  "list", "get", "create", "rename", "delete", "set_thematic_goal", "clear_thematic_goal",
  "add_initiative", "remove_initiative", "set_leading_metric", "clear_leading_metric", "set_lagging_kpi", "clear_lagging_kpi", "add_kpi", "remove_kpi", "assign_vault",
]);
const KPI_ACTIONS = new Set(["list_kpis", "get_kpi", "create_kpi", "update_kpi", "delete_kpi"]);
const METRIC_ACTIONS = new Set([
  "list_metrics", "get_metric", "create_metric", "update_metric", "delete_metric",
  "sample_range", "sample_usage", "list_samples", "record_sample", "delete_sample",
]);

const MODEL_PERIOD_MODES = new Set(["monthly", "quarterly", "annually"]);

async function computeModelBundle(businessId: string, period: "monthly" | "quarterly" | "annually") {
  const { businessModelStorage } = await import("../business-model-storage");
  const { businessBudgetStorage } = await import("../business-budget-storage");
  const { businessHiringStorage } = await import("../business-hiring-storage");
  const { jobRoleStorage } = await import("../job-role-storage");
  const { aggregateMonths, computeProjection } = await import("@shared/models/business-model");

  const [model, budget, hiring, rolesList] = await Promise.all([
    businessModelStorage.getOrCreate(businessId),
    businessBudgetStorage.get(businessId),
    businessHiringStorage.projection(businessId),
    jobRoleStorage.list({ limit: 200 }),
  ]);

  const roles = rolesList.length > 0 ? rolesList : hiring.roles;
  const departments = budget?.departments ?? [];
  const projection = computeProjection(model.assumptions, roles, departments, hiring.slots);
  const periods = aggregateMonths(projection.months, period);
  return { model, budget, hiring, projection, periods, departments };
}

function modelGetPayload(bundle: Awaited<ReturnType<typeof computeModelBundle>>, period: "monthly" | "quarterly" | "annually") {
  const { model, budget, hiring, projection, periods, departments } = bundle;
  const last = periods[periods.length - 1] ?? null;
  return {
    model: {
      id: model.id,
      businessId: model.businessId,
      name: model.name,
      assumptions: model.assumptions,
      createdAt: model.createdAt,
      updatedAt: model.updatedAt,
    },
    period,
    periods,
    months: projection.months,
    gates: projection.gates,
    financing: projection.financing,
    financingNeed: projection.financingNeed,
    metricSeries: projection.metricSeries,
    aggregates: {
      horizonMonths: projection.months.length,
      periodCount: periods.length,
      entryContributionGrossMargin: projection.entryContributionGrossMargin,
      baselineCacPaybackMonths: projection.baselineCacPaybackMonths,
      impliedRetainedAccountArpaExpansionPct: projection.impliedRetainedAccountArpaExpansionPct,
      endingCash: last?.endingCash ?? null,
      runwayMonths: last?.runwayMonths ?? null,
      arr: last?.arr ?? null,
      mrr: last?.mrr ?? null,
      activeAccounts: last?.activeAccounts ?? null,
      activeUsers: last?.activeUsers ?? null,
      budgetMonthlyTotalCents: budget ? budget.monthlyTotalCents : 0,
      budgetConfigured: Boolean(budget),
      approvedHiringSlots: hiring.slots.filter((slot) => slot.status === "approved").length,
    },
    budgetDepartments: departments.map((department) => ({
      id: department.id,
      name: department.name,
      monthlyTotalCents: departmentMonthlyTotal(department),
    })),
  };
}

// Compact recompute after a write: the headline aggregates and gate statuses so
// the caller sees whether the curve bent without re-fetching the full matrix.
function modelWriteSummary(bundle: Awaited<ReturnType<typeof computeModelBundle>>) {
  const { model, projection, periods } = bundle;
  const last = periods[periods.length - 1] ?? null;
  return {
    model: {
      id: model.id,
      businessId: model.businessId,
      updatedAt: model.updatedAt,
      assumptionKpis: model.assumptions.assumptionKpis,
    },
    recomputed: {
      horizonMonths: projection.months.length,
      activeAccounts: last?.activeAccounts ?? null,
      activeUsers: last?.activeUsers ?? null,
      arr: last?.arr ?? null,
      mrr: last?.mrr ?? null,
      runwayMonths: last?.runwayMonths ?? null,
      endingCash: last?.endingCash ?? null,
    },
    gates: projection.gates.map((gate) => ({
      phaseKey: gate.phaseKey,
      label: gate.label,
      status: gate.status,
      firstAchievedMonth: gate.firstAchievedMonth,
    })),
  };
}

async function handleModelAction(action: string, args: Record<string, unknown>) {
  const businessId = requiredStr(args, "businessId");
  if (!businessId) return { result: `business.${action} requires businessId`, error: true };

  if (MODEL_WRITE_ACTIONS.has(action)) {
    const { businessModelStorage } = await import("../business-model-storage");
    const assumptionKey = requiredStr(args, "assumptionKey");
    if (!assumptionKey) return { result: `business.${action} requires assumptionKey`, error: true };
    const kpiIdArg = requiredStr(args, "kpiId");
    const valueArg = optionalNumber(args, "value");

    if (action === "set_assumption") {
      if (typeof valueArg !== "number") return { result: "business.set_assumption requires a numeric value", error: true };
      const { assumptionsPatchSchema } = await import("@shared/models/business-model");
      // .strict() on the patch schema rejects unknown keys and wrong types, so an
      // invalid assumptionKey or a structured/string target fails closed here.
      const parsed = assumptionsPatchSchema.safeParse({ [assumptionKey]: valueArg });
      if (!parsed.success) {
        return { result: `business.set_assumption rejected "${assumptionKey}": ${parsed.error.issues[0]?.message ?? "unknown assumption or wrong type"}`, error: true };
      }
      await businessModelStorage.updateAssumptions(businessId, parsed.data);
    } else {
      // assumptionKpis merges by replacement, so preserve existing links and
      // apply the single change to the full map.
      const current = await businessModelStorage.getOrCreate(businessId);
      const nextLinks: Record<string, string> = { ...current.assumptions.assumptionKpis };
      if (action === "link_assumption_kpi") {
        if (!kpiIdArg) return { result: "business.link_assumption_kpi requires kpiId", error: true };
        const kpi = await kpiStorage.get(kpiIdArg);
        if (!kpi) return { result: `business.link_assumption_kpi: KPI "${kpiIdArg}" not found or not visible`, error: true };
        nextLinks[assumptionKey] = kpiIdArg;
      } else {
        delete nextLinks[assumptionKey];
      }
      await businessModelStorage.updateAssumptions(businessId, { assumptionKpis: nextLinks });
    }

    const writeBundle = await computeModelBundle(businessId, "monthly");
    return {
      result: safeStringify({
        updated: true,
        action,
        businessId,
        assumptionKey,
        ...(action === "set_assumption" ? { value: valueArg } : {}),
        ...(action === "link_assumption_kpi" ? { kpiId: kpiIdArg } : {}),
        ...modelWriteSummary(writeBundle),
      }, { label: `bridge.business.model.${action}` }),
    };
  }

  if (action !== "get_model") return { result: `Unknown business Model action: ${action}`, error: true };

  const periodArg = optionalStr(args, "period") ?? "monthly";
  if (!MODEL_PERIOD_MODES.has(periodArg)) {
    return { result: "business.get_model period must be monthly, quarterly, or annually", error: true };
  }
  const period = periodArg as "monthly" | "quarterly" | "annually";
  const bundle = await computeModelBundle(businessId, period);
  return { result: safeStringify(modelGetPayload(bundle, period), { label: "bridge.business.model.get" }) };
}

export const handleBusiness: ToolHandler = async (args) => {
  const action = String(args.action || "list");
  try {
    let outcome;
    if (ENTITY_ACTIONS.has(action)) outcome = await handleEntityAction(action, args);
    else if (MODEL_ACTIONS.has(action)) outcome = await handleModelAction(action, args);
    else if (BUDGET_ACTIONS.has(action)) outcome = await handleBudgetAction(action, args);
    else if (HIRING_ACTIONS.has(action)) outcome = await handleHiringAction(action, args);
    else if (KPI_ACTIONS.has(action)) outcome = await handleKpiAction(action, args);
    else if (METRIC_ACTIONS.has(action)) outcome = await handleMetricAction(action, args);
    else if (PLAN_ACTIONS.has(action)) outcome = await handlePlanAction(action, args);
    else outcome = { result: `Unknown business action: ${action}`, error: true };
    return stampBusinessContractReject(action, outcome);
  } catch (error: unknown) {
    const message = safeBusinessError(error);
    const clientStatus = businessClientErrorStatus(error);
    // Storage helpers throw status:400 for range/arg validation (e.g. "end cannot
    // be in the future"). That is caller input, not a producer defect.
    if (clientStatus !== null) {
      return {
        result: message,
        error: true,
        failure: inputFailure("business_input_invalid", `${action}:${message}`),
      };
    }
    return {
      result: message,
      error: true,
      failure: internalFailure("business_internal", `${action}:${message}`),
    };
  }
};
