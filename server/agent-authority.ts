import type { Principal } from "./principal";
import { getCurrentPrincipal } from "./principal-context";
import { getSideEffectTier } from "./autonomy-tiers";
import { principalHasPermission, type Permission } from "./permissions";

export type ToolInvocationOrigin =
  | "interactive"
  | "voice"
  | "autonomous"
  | "timer"
  | "hook"
  | "http"
  | "internal";

export interface AgentAuthorityContext {
  origin?: ToolInvocationOrigin;
  trustedDelegation?: "plan" | "workflow";
  activity?: string;
  sessionId?: string;
  sessionKey?: string;
}

export type ToolAuthorityDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

const ENGINEERING_TOOLS = new Set(["shell", "git", "code", "railway", "expo", "sentry", "platforms"]);
const ENGINEERING_WRITE_ACTIONS: Record<string, ReadonlySet<string>> = {
  git: new Set(["clone", "pull", "branch", "checkout", "add", "commit", "push", "create_pr", "merge_pr", "delete_branch"]),
  railway: new Set(["redeploy", "restart"]),
  expo: new Set(["cancel"]),
  sentry: new Set(["resolve", "unresolve", "ignore"]),
  platforms: new Set([
    "create_connection", "create_platform", "update_platform", "create_product", "update_product",
    "create_environment", "update_environment", "delete_environment", "save_source_binding",
    "save_hosting_binding", "save_context_artifact", "remove_context_artifact", "set_build_lifecycle",
    "disable_build_lifecycle", "delete_build_lifecycle", "start_build_workflow", "deploy_cloudflare_pages",
    "cancel_cloudflare_pages_deployment", "repair_cloudflare_pages_project",
  ]),
};

const MODEL_FORBIDDEN_ACTIONS: Record<string, ReadonlySet<string>> = {
  twitter: new Set(["post", "reply", "delete"]),
  meetings: new Set(["add", "update", "delete"]),
  backup: new Set(["delete"]),
  platforms: new Set(["create_connection"]),
  railway: new Set(["redeploy", "restart"]),
  expo: new Set(["cancel"]),
};

const INTERNAL_EXTERNAL_EFFECT_ALLOWLIST = new Set([
  "converse:initiate",
  "converse:set_attention",
  "message_parent:*",
  "message_child:*",
  "message_sibling:*",
  "session:send_message",
  "phone_call:prepare",
  "phone_call:confirm",
]);

function actionOf(args: Record<string, unknown>): string | undefined {
  return typeof args.action === "string" && args.action.trim() ? args.action.trim() : undefined;
}

function requiresPermission(toolName: string, action: string | undefined): Permission | null {
  if (toolName === "hooks") return ["list", "get", "test"].includes(action || "") ? "system:read" : "system:write";
  if (toolName === "backup") return ["list", "get"].includes(action || "") ? "system:read" : "system:write";
  if (!ENGINEERING_TOOLS.has(toolName)) return null;
  if (toolName === "shell") return "build:write";
  if (ENGINEERING_WRITE_ACTIONS[toolName]?.has(action || "")) return "build:write";
  return "build:read";
}

function isTrustedEngineeringDelegation(context: AgentAuthorityContext): boolean {
  return context.trustedDelegation === "plan" || context.trustedDelegation === "workflow";
}

function isModelOrigin(origin: ToolInvocationOrigin): boolean {
  return origin !== "http" && origin !== "internal";
}

export function authorizeToolInvocation(
  toolName: string,
  args: Record<string, unknown>,
  context: AgentAuthorityContext = {},
  principal: Principal | null = getCurrentPrincipal(),
): ToolAuthorityDecision {
  const origin = context.origin ?? "internal";
  const action = actionOf(args);

  if (!principal) return { allowed: false, reason: "missing_principal" };
  if (principal.actorType === "service" && !principal.userId && principal.permissions.length === 0) {
    return { allowed: false, reason: "unbound_service_principal" };
  }

  const permission = requiresPermission(toolName, action);
  if (permission && !principalHasPermission(principal, permission)) {
    return { allowed: false, reason: `permission_required:${permission}` };
  }

  if (isModelOrigin(origin) && MODEL_FORBIDDEN_ACTIONS[toolName]?.has(action || "")) {
    return { allowed: false, reason: "human_gate_required" };
  }

  if (toolName === "shell" && !isTrustedEngineeringDelegation(context)) {
    return { allowed: false, reason: "trusted_engineering_delegation_required" };
  }

  if (ENGINEERING_WRITE_ACTIONS[toolName]?.has(action || "") && !isTrustedEngineeringDelegation(context)) {
    return { allowed: false, reason: "trusted_engineering_delegation_required" };
  }

  const sideEffectTier = getSideEffectTier(toolName, action);
  if (["autonomous", "timer", "hook"].includes(origin) && sideEffectTier === 2) {
    const key = `${toolName}:${action || "*"}`;
    const wildcardKey = `${toolName}:*`;
    const trustedEngineeringWrite = isTrustedEngineeringDelegation(context)
      && ENGINEERING_WRITE_ACTIONS[toolName]?.has(action || "");
    if (!trustedEngineeringWrite && !INTERNAL_EXTERNAL_EFFECT_ALLOWLIST.has(key) && !INTERNAL_EXTERNAL_EFFECT_ALLOWLIST.has(wildcardKey)) {
      return { allowed: false, reason: "autonomous_external_effect_blocked" };
    }
  }

  return { allowed: true };
}

export function filterToolSchemasForAuthority<T extends { name: string; parameters: Record<string, any> }>(
  schemas: T[],
  context: AgentAuthorityContext,
  principal: Principal | null = getCurrentPrincipal(),
): T[] {
  const result: T[] = [];
  for (const schema of schemas) {
    const actionSchema = schema.parameters?.properties?.action;
    if (Array.isArray(actionSchema?.enum)) {
      const allowedActions = actionSchema.enum.filter((action: unknown) =>
        typeof action === "string" && authorizeToolInvocation(schema.name, { action }, context, principal).allowed,
      );
      if (allowedActions.length === 0) continue;
      result.push({
        ...schema,
        parameters: {
          ...schema.parameters,
          properties: {
            ...schema.parameters.properties,
            action: { ...actionSchema, enum: allowedActions },
          },
        },
      });
      continue;
    }
    if (authorizeToolInvocation(schema.name, {}, context, principal).allowed) result.push(schema);
  }
  return result;
}

const SAFE_SHELL_COMMANDS = new Set([
  "cd", "pwd", "ls", "find", "cat", "head", "tail", "grep", "sed", "wc", "sort", "uniq",
  "cut", "tr", "printf", "test", "[", "basename", "dirname", "stat", "du", "file", "diff", "git", "npm",
]);
const FORBIDDEN_SHELL_TOKENS = /(?:\r|\n|;|`|\$\(|\|\||(?<!&)\&(?!&)|[<>]|\b(?:curl|wget|nc|ncat|netcat|ssh|scp|sftp|ftp|telnet|python|python3|node|deno|bun|perl|ruby|php|lua|env|printenv|eval|source)\b|\/(?:proc|sys|dev|root)\/|(?:^|[\s/])\.env(?:[\s/]|$)|credentials?|secrets?)/i;

export function validateShellCommand(command: string): ToolAuthorityDecision {
  if (!command.trim()) return { allowed: false, reason: "empty_command" };
  if (FORBIDDEN_SHELL_TOKENS.test(command)) return { allowed: false, reason: "forbidden_shell_token" };

  const segments = command.split(/&&|\|/).map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0) return { allowed: false, reason: "empty_command" };
  for (const segment of segments) {
    const first = segment.match(/^([A-Za-z[\]]+)/)?.[1];
    if (!first || !SAFE_SHELL_COMMANDS.has(first)) return { allowed: false, reason: `command_not_allowlisted:${first || "unknown"}` };
    if (first === "sed" && /(?:^|\s)-(?:[^\s]*i|[^\s]*e)(?:\s|$)/.test(segment)) return { allowed: false, reason: "mutating_sed_blocked" };
    if (first === "find" && /-(?:exec|execdir|delete|ok|okdir)\b/.test(segment)) return { allowed: false, reason: "mutating_find_blocked" };
    if (first === "git" && !/^git\s+(?:status|log|diff|show|branch(?:\s+--list)?|remote\s+-v|rev-parse)(?:\s|$)/.test(segment)) {
      return { allowed: false, reason: "shell_git_write_blocked" };
    }
    if (first === "npm" && !/^npm\s+run\s+build(?:\s|$)/.test(segment)) return { allowed: false, reason: "npm_command_not_allowlisted" };
  }
  return { allowed: true };
}
