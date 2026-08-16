// ─── Typed contribution builders ───────────────────────────────────────────
// Server-side factories that produce shared-typed contribution objects while
// constraining registered-key fields to the trusted catalog unions. This gives
// the code-owned definitions compile-time key safety (a typo'd surface/icon/
// connector key fails the build) on top of the runtime validation in §6.1.

import type {
  ClientRouteContribution,
  DashboardHeatmapContribution,
  IntegrationContribution,
  NavigationContribution,
  PermissionKey,
  WidgetContribution,
  WidgetSlot,
  WorkflowContribution,
  TimerTemplateContribution,
  SkillContribution,
  ToolContribution,
  ServerRouteGroupContribution,
  MetricAdapterContribution,
} from "@shared/models/mod-registry";
import type { UiInteractionTarget } from "@shared/ui-interaction";
import type {
  RegisteredConnectorKey,
  RegisteredCollectorKey,
  RegisteredDashboardHeatmapSeriesKey,
  RegisteredIconKey,
  RegisteredSurfaceKey,
  RegisteredWidgetKey,
  RegisteredWorkflowKey,
  RegisteredTimerTemplateKey,
  RegisteredSkillKey,
  RegisteredToolKey,
  RegisteredRouteGroupKey,
} from "./registered-keys";

interface RouteOpts {
  requiredPermissions?: PermissionKey[];
  exact?: boolean;
}

export function clientRoute(
  id: string,
  path: string,
  surfaceKey: RegisteredSurfaceKey,
  opts: RouteOpts = {},
): ClientRouteContribution {
  return {
    kind: "client-route",
    id,
    path,
    surfaceKey,
    audience: "primary",
    ...(opts.exact !== undefined ? { exact: opts.exact } : {}),
    ...(opts.requiredPermissions ? { requiredPermissions: opts.requiredPermissions } : {}),
  };
}

interface NavOpts {
  requiredPermissions?: PermissionKey[];
}

export function nav(
  id: string,
  section: string,
  label: string,
  iconKey: RegisteredIconKey,
  target: UiInteractionTarget,
  routeId: string,
  order: number,
  opts: NavOpts = {},
): NavigationContribution {
  return {
    kind: "navigation",
    id,
    section,
    label,
    iconKey,
    target,
    routeId,
    order,
    audience: "primary",
    ...(opts.requiredPermissions ? { requiredPermissions: opts.requiredPermissions } : {}),
  };
}

export function widget(
  id: string,
  slot: WidgetSlot,
  surfaceKey: RegisteredWidgetKey,
  collectorKey: RegisteredCollectorKey,
  order: number,
): WidgetContribution {
  return { kind: "widget", id, slot, surfaceKey, collectorKey, order };
}

interface DashboardHeatmapOpts {
  requiredPermissions?: PermissionKey[];
}

export function dashboardHeatmap(
  id: string,
  seriesKey: RegisteredDashboardHeatmapSeriesKey,
  title: string,
  icon: RegisteredIconKey,
  order: number,
  group: DashboardHeatmapContribution["group"],
  opts: DashboardHeatmapOpts = {},
): DashboardHeatmapContribution {
  return {
    kind: "dashboard-heatmap",
    id,
    seriesKey,
    title,
    icon,
    order,
    group,
    ...(opts.requiredPermissions ? { requiredPermissions: opts.requiredPermissions } : {}),
  };
}

export function integration(
  id: string,
  connectorKey: RegisteredConnectorKey,
  relationship: IntegrationContribution["relationship"],
  capabilities: string[],
  readiness: Pick<
    IntegrationContribution,
    "readinessKind" | "requiredSecrets" | "requiredAnySecrets" | "oauthProvider" | "connectionProvider"
  > = {},
): IntegrationContribution {
  return {
    kind: "integration",
    id,
    connectorKey,
    relationship,
    capabilities,
    audience: "settings",
    ...readiness,
  };
}

export function workflowRef(
  id: string,
  workflowKey: RegisteredWorkflowKey,
): WorkflowContribution {
  return { kind: "workflow", id, workflowKey, audience: "diagnostic" };
}

export function timerTemplateRef(
  id: string,
  templateKey: RegisteredTimerTemplateKey,
): TimerTemplateContribution {
  return { kind: "timer-template", id, templateKey, audience: "diagnostic" };
}

export function skillRef(
  id: string,
  skillKey: RegisteredSkillKey,
): SkillContribution {
  return { kind: "skill", id, skillKey, audience: "diagnostic" };
}

export function toolRef(id: string, toolName: RegisteredToolKey): ToolContribution {
  return { kind: "tool", id, toolName, audience: "diagnostic" };
}

export function metricAdapter(id: string, adapterKey: string, definitionKeys: string[], viewKey: string): MetricAdapterContribution {
  return { kind: "metric-adapter", id, adapterKey, definitionKeys, viewKey, audience: "diagnostic" };
}

export function serverRouteGroupRef(
  id: string,
  routeGroupKey: RegisteredRouteGroupKey,
): ServerRouteGroupContribution {
  return { kind: "server-route-group", id, routeGroupKey, audience: "diagnostic" };
}
