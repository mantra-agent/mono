import { safeStringify } from "../utils/safe-stringify";
import { businessPlanStorage } from "../business-plan-storage";
import type { BusinessPlan } from "@shared/schema";
import type { ToolHandler } from "../bridge-tools";

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

function requiredId(args: Record<string, unknown>, field: string): string | null {
  const value = String(args[field] ?? "").trim();
  return value || null;
}

export const handleBusinessPlans: ToolHandler = async (args) => {
  const action = String(args.action || "list");
  try {
    if (action === "list") {
      const plans = await businessPlanStorage.list();
      return { result: safeStringify({ total: plans.length, plans: plans.map(planResult) }, { label: "bridge.business_plans.list" }) };
    }

    if (action === "get") {
      const id = requiredId(args, "id");
      if (!id) return { result: "business_plans.get requires id", error: true };
      const plan = await businessPlanStorage.get(id);
      return plan
        ? { result: safeStringify(planResult(plan), { label: "bridge.business_plans.get" }) }
        : { result: `Business Plan "${id}" not found or not visible`, error: true };
    }

    if (action === "create") {
      const name = requiredId(args, "name");
      if (!name) return { result: "business_plans.create requires name", error: true };
      const plan = await businessPlanStorage.create({
        name,
        ...(requiredId(args, "vaultId") ? { vaultId: requiredId(args, "vaultId")! } : {}),
        ...(requiredId(args, "thematicGoalId") ? { thematicGoalId: requiredId(args, "thematicGoalId")! } : {}),
      });
      return { result: safeStringify(planResult(plan), { label: "bridge.business_plans.create" }) };
    }

    const id = requiredId(args, "id");
    if (!id) return { result: `business_plans.${action} requires id`, error: true };

    if (action === "rename") {
      const name = requiredId(args, "name");
      if (!name) return { result: "business_plans.rename requires name", error: true };
      return { result: safeStringify(planResult(await businessPlanStorage.update(id, { name })), { label: "bridge.business_plans.rename" }) };
    }
    if (action === "delete") {
      await businessPlanStorage.remove(id);
      return { result: `Deleted @business_plan:${id}` };
    }
    if (action === "set_thematic_goal") {
      const goalId = requiredId(args, "goalId");
      if (!goalId) return { result: "business_plans.set_thematic_goal requires goalId", error: true };
      return { result: safeStringify(planResult(await businessPlanStorage.update(id, { thematicGoalId: goalId })), { label: "bridge.business_plans.set_goal" }) };
    }
    if (action === "clear_thematic_goal") {
      return { result: safeStringify(planResult(await businessPlanStorage.update(id, { thematicGoalId: null })), { label: "bridge.business_plans.clear_goal" }) };
    }
    if (action === "assign_vault") {
      const vaultId = requiredId(args, "vaultId");
      if (!vaultId) return { result: "business_plans.assign_vault requires vaultId", error: true };
      return { result: safeStringify(planResult(await businessPlanStorage.update(id, { vaultId })), { label: "bridge.business_plans.assign_vault" }) };
    }
    if (action === "add_initiative" || action === "remove_initiative") {
      const projectId = Number(args.projectId);
      if (!Number.isInteger(projectId) || projectId <= 0) return { result: `business_plans.${action} requires a positive projectId`, error: true };
      const plan = await businessPlanStorage.mutateInitiative(id, projectId, action === "add_initiative" ? "add" : "remove");
      return { result: safeStringify(planResult(plan), { label: `bridge.business_plans.${action}` }) };
    }
    if (action === "add_kpi" || action === "remove_kpi") {
      const kpiId = requiredId(args, "kpiId");
      if (!kpiId) return { result: `business_plans.${action} requires kpiId`, error: true };
      const plan = await businessPlanStorage.mutateKpi(id, kpiId, action === "add_kpi" ? "add" : "remove");
      return { result: safeStringify(planResult(plan), { label: `bridge.business_plans.${action}` }) };
    }

    return { result: `Unknown business_plans action: ${action}`, error: true };
  } catch (error: any) {
    return { result: error?.message || "Business Plan operation failed", error: true };
  }
};
