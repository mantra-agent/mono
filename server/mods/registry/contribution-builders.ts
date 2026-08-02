// ─── Typed contribution builders ───────────────────────────────────────────
// Server-side factories that produce shared-typed contribution objects while
// constraining registered-key fields to the trusted catalog unions. This gives
// the code-owned definitions compile-time key safety (a typo'd surface/icon/
// connector key fails the build) on top of the runtime validation in §6.1.

import type {
  ClientRouteContribution,
  IntegrationContribution,
  NavigationContribution,
  PermissionKey,
  WidgetContribution,
  WidgetSlot,
  WorkflowContribution,
  TimerTemplateContribution,
} from "@shared/models/mod-registry";
import type {
  RegisteredConnectorKey,
  RegisteredCollectorKey,
  RegisteredIconKey,
  RegisteredSurfaceKey,
  RegisteredWidgetKey,
  RegisteredWorkflowKey,
  RegisteredTimerTemplateKey,
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

export function integration(
  id: string,
  connectorKey: RegisteredConnectorKey,
  relationship: IntegrationContribution["relationship"],
  capabilities: string[],
): IntegrationContribution {
  return { kind: "integration", id, connectorKey, relationship, capabilities, audience: "settings" };
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
