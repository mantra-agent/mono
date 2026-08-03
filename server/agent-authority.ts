import type { Principal } from "./principal";
import { getCurrentPrincipal } from "./principal-context";
import { getSideEffectTier } from "./autonomy-tiers";
import { principalHasPermission, type Permission } from "./permissions";
import { isWorkflowStageAction } from "./workflows/stage-capability";

export type ToolInvocationOrigin =
  | "interactive"
  | "voice"
  | "autonomous"
  | "timer"
  | "hook"
  | "http"
  | "internal";

export type TrustedEngineeringDelegation = "plan" | "workflow" | "child";

export interface AgentAuthorityContext {
  origin?: ToolInvocationOrigin;
  trustedDelegation?: TrustedEngineeringDelegation;
  activity?: string;
  /** Canonical DB skill row ID, resolved by the autonomous runner. Never model-provided. */
  skillId?: string;
  sessionId?: string;
  sessionKey?: string;
}

export type ToolAuthorityDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

const ENGINEERING_TOOLS = new Set(["shell", "git", "code", "npm_dependencies", "railway", "expo", "sentry", "platforms"]);
const ENGINEERING_WRITE_ACTIONS: Record<string, ReadonlySet<string>> = {
  git: new Set(["clone", "pull", "branch", "checkout", "add", "commit", "push", "create_pr", "merge_pr", "delete_branch"]),
  npm_dependencies: new Set(["set_package"]),
  railway: new Set(["redeploy", "restart"]),
  expo: new Set(["start_build", "cancel"]),
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

function scratchAction(toolName: string, action: string | undefined): string | undefined {
  if (toolName === "write_scratch") return "write";
  if (toolName === "edit_scratch") return "edit";
  return toolName === "scratch" ? action : undefined;
}

function isRepositoryScratchWrite(
  toolName: string,
  action: string | undefined,
  args: Record<string, unknown>,
): boolean {
  if (!["write", "edit"].includes(scratchAction(toolName, action) || "")) return false;
  const path = typeof args.path === "string" ? args.path.trim().replace(/^\.\//, "") : "";
  return /^repos\/[^/]+(?:\/|$)/.test(path);
}

function isSessionOwnedRepositoryPath(path: unknown, sessionId: string | undefined): boolean {
  if (typeof path !== "string" || !sessionId) return false;
  const normalized = path.trim().replace(/^\.\//, "");
  const directory = normalized.match(/^repos\/([^/]+)(?:\/|$)/)?.[1];
  return Boolean(directory?.endsWith(`-${sessionId.slice(0, 8)}`));
}

function requiresPermission(
  toolName: string,
  action: string | undefined,
  args: Record<string, unknown>,
): Permission | null {
  if (toolName === "hooks") return ["list", "get", "test"].includes(action || "") ? "system:read" : "system:write";
  if (toolName === "backup") return ["list", "get"].includes(action || "") ? "system:read" : "system:write";
  if (toolName === "jobs") return ["list", "get"].includes(action || "") ? "system:read" : "system:write";
  if (isRepositoryScratchWrite(toolName, action, args)) return "build:write";
  if (!ENGINEERING_TOOLS.has(toolName)) return null;
  if (toolName === "shell") return "build:write";
  if (ENGINEERING_WRITE_ACTIONS[toolName]?.has(action || "")) return "build:write";
  return "build:read";
}

function isTrustedEngineeringDelegation(context: AgentAuthorityContext): boolean {
  const userInteractiveTransport = context.origin === "interactive"
    || (context.origin === "voice" && Boolean(context.sessionId));
  return userInteractiveTransport
    || context.trustedDelegation === "plan"
    || context.trustedDelegation === "workflow"
    || context.trustedDelegation === "child";
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

  if (toolName === "ui" && (!context.sessionId || (origin !== "interactive" && origin !== "voice"))) {
    return { allowed: false, reason: "session_bound_interactive_ui_required" };
  }

  if (!principal) return { allowed: false, reason: "missing_principal" };
  if (principal.actorType === "service" && !principal.userId && principal.permissions.length === 0) {
    return { allowed: false, reason: "unbound_service_principal" };
  }

  const repositoryScratchWrite = isRepositoryScratchWrite(toolName, action, args);
  const permission = requiresPermission(toolName, action, args);
  if (permission && !principalHasPermission(principal, permission)) {
    return { allowed: false, reason: `permission_required:${permission}` };
  }

  if (isModelOrigin(origin) && MODEL_FORBIDDEN_ACTIONS[toolName]?.has(action || "")) {
    return { allowed: false, reason: "human_gate_required" };
  }

  if (origin === "timer" && toolName === "converse") {
    return { allowed: false, reason: "timer_attention_owned_by_scheduler" };
  }

  if (toolName === "workflows" && context.trustedDelegation === "workflow" && !isWorkflowStageAction(action)) {
    return { allowed: false, reason: "workflow_stage_action_required" };
  }

  if (repositoryScratchWrite && !isSessionOwnedRepositoryPath(args.path, context.sessionId)) {
    return { allowed: false, reason: "session_owned_repository_required" };
  }

  if ((toolName === "shell" || repositoryScratchWrite) && !isTrustedEngineeringDelegation(context)) {
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
    const trustedWorkflowStageAction = context.trustedDelegation === "workflow"
      && toolName === "workflows"
      && isWorkflowStageAction(action);
    if (!trustedEngineeringWrite && !trustedWorkflowStageAction && !INTERNAL_EXTERNAL_EFFECT_ALLOWLIST.has(key) && !INTERNAL_EXTERNAL_EFFECT_ALLOWLIST.has(wildcardKey)) {
      return { allowed: false, reason: "autonomous_external_effect_blocked" };
    }
  }

  return { allowed: true };
}

function describeAuthorityFilteredActions(
  toolName: string,
  allowedActions: unknown[],
  removedActionCount: number,
): string | null {
  if (removedActionCount === 0) return null;
  if (toolName === "git") {
    return [
      `Current execution authority permits only: ${allowedActions.join(", ")}.`,
      "Omitted Git actions are intentionally unavailable under this session's provenance, not evidence of a broken provider credential.",
      "Plan/workflow children and session.spawn_child calls with delegation=engineering receive delegated write authority; ordinary conversational children do not.",
    ].join(" ");
  }
  return `Current execution authority permits only: ${allowedActions.join(", ")}.`;
}

export function filterToolSchemasForAuthority<T extends { name: string; description?: string; parameters: Record<string, any> }>(
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
      const authorityDescription = describeAuthorityFilteredActions(
        schema.name,
        allowedActions,
        actionSchema.enum.length - allowedActions.length,
      );
      result.push({
        ...schema,
        ...(authorityDescription
          ? { description: `${schema.description || ""} ${authorityDescription}`.trim() }
          : {}),
        parameters: {
          ...schema.parameters,
          properties: {
            ...schema.parameters.properties,
            action: {
              ...actionSchema,
              enum: allowedActions,
              ...(authorityDescription
                ? { description: `${actionSchema.description || "Action to perform"}. ${authorityDescription}` }
                : {}),
            },
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
  "cd", "pwd", "ls", "find", "cat", "head", "tail", "grep", "rg", "sed", "wc", "sort", "uniq",
  "cut", "tr", "echo", "printf", "test", "[", "basename", "dirname", "stat", "du", "file", "diff", "git", "npm",
  // Binary presence checks only — no flags that execute the resolved path.
  "which",
]);

/** Read-only git subcommands permitted via shell. Writes always go through the git tool. */
const SAFE_SHELL_GIT_SUBCOMMANDS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "remote",
  "rev-parse",
  // Content search over the index/worktree — pure read, common when rg is unavailable.
  "grep",
]);

/**
 * Ordered forbidden-token classes. Each carries a precise, actionable reason so a rejected
 * command names exactly which class tripped — a child can then adapt (drop the redirection,
 * drop substitution, split on a still-blocked operator) instead of blindly retrying variants
 * until the watchdog kills it. This replaces one opaque `forbidden_shell_token` reason with
 * the specific cause and preserves every prior protection except the deliberate removals below.
 *
 * Unquoted `;` is NOT forbidden here: `splitShellSegments` treats it as a sequence separator
 * and every resulting segment still passes the binary/subcommand allowlist — same structural
 * gate as `|` and `&&`. Banning `;` while allowing those operators only taught the model to
 * thrash into parallel tool calls for independent read-only inspections.
 *
 * The prior bare-word ban on `credentials?|secrets?` was removed: it blocked read-only
 * inspection like `grep "secret" server/` while the scratch read path can already open any file
 * in the session clone, so the ban was incoherent theater. Real secret exposure stays blocked
 * structurally — env dumps (`env`/`printenv`), interpreters, and dotfile secret paths (`.env`,
 * `.aws`, `.git-credentials`, …) each retain their own class below.
 */
const FORBIDDEN_SHELL_TOKEN_CLASSES: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /[\r\n]/, reason: "forbidden:multiline_command" },
  { pattern: /`|\$\(/, reason: "forbidden:command_substitution" },
  { pattern: /\$(?:\{|[A-Za-z0-9_?*#@!$-])/, reason: "forbidden:variable_expansion" },
  { pattern: /\|\|/, reason: "forbidden:or_operator" },
  // Allow `2>&1` FD dup (pure stream merge). Any other bare `&` stays blocked.
  { pattern: /(?<!&)\&(?!&|\d)/, reason: "forbidden:background_execution" },
  { pattern: /[<>]/, reason: "forbidden:redirection" },
  { pattern: /~/, reason: "forbidden:home_expansion" },
  { pattern: /\b(?:curl|wget|nc|ncat|netcat|ssh|scp|sftp|ftp|telnet)\b/i, reason: "forbidden:network_binary" },
  { pattern: /\b(?:python|python3|node|deno|bun|perl|ruby|php|lua|eval|source)\b/i, reason: "forbidden:interpreter" },
  { pattern: /\b(?:env|printenv)\b/i, reason: "forbidden:env_dump" },
  { pattern: /\/(?:proc|sys|dev|root|home)\//i, reason: "forbidden:sensitive_path" },
  { pattern: /(?:^|[\s/])\.(?:env|npmrc|netrc|gitconfig|git-credentials|aws|ssh|config)(?:[\s/]|$)/i, reason: "forbidden:dotfile_secret" },
];
// File path is optional so pipeline stdin works: `git show HEAD:file | sed -n '10,20p'`.
// Expression stays strictly `N p` / `N,Mp` — no executable sed scripts.
const SAFE_SED_READ = /^sed\s+-n\s+(["'])(?:\d+)(?:,\d+)?p\1(?:\s+(?:--\s+)?[^\s]+(?:\s+[^\s]+)*)?$/;

/**
 * Strip only harmless stdout/stderr discards and FD merges before forbidden-token checks.
 * The executed command keeps these redirects; they do not expand write surface.
 *   - `>/dev/null`, `2>/dev/null`, `N>/dev/null`
 *   - `2>&1` (and similar FD merges)
 */
function stripSafeShellRedirectsForValidation(command: string): string {
  return command
    .replace(/(?:^|\s)\d*>\s*\/dev\/null\b/g, " ")
    .replace(/(?:^|\s)\d*>&\d+\b/g, " ");
}

function isSafeShellGitSegment(segment: string): boolean {
  // Skip read-only global options (`-C path`, `--no-pager`, `-c key=value`) before the subcommand.
  const tokens = segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  if (tokens[0] !== "git") return false;
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === "-C" || t === "--git-dir" || t === "--work-tree") {
      i += 2; // option + path
      continue;
    }
    if (t.startsWith("--git-dir=") || t.startsWith("--work-tree=") || t.startsWith("--namespace=")) {
      i += 1;
      continue;
    }
    if (t === "-c") {
      i += 2; // -c key=value
      continue;
    }
    if (t.startsWith("-c") && t.includes("=")) {
      i += 1;
      continue;
    }
    if (t === "--no-pager" || t === "--paginate" || t === "-p" || t === "--no-optional-locks") {
      i += 1;
      continue;
    }
    break;
  }
  const sub = tokens[i];
  if (!sub || !SAFE_SHELL_GIT_SUBCOMMANDS.has(sub)) return false;
  if (sub === "branch") {
    // List/inspect only — block create/delete/rename/copy/upstream mutation flags.
    if (/\s(?:-[dDmM]|--delete|--move|--copy|--set-upstream-to|--unset-upstream|--edit-description)\b/.test(segment)) {
      return false;
    }
    return true;
  }
  if (sub === "remote") {
    // Read-only remote inspection — block add/remove/rename/set-url/prune/update.
    const remoteAction = tokens[i + 1];
    if (remoteAction && ["add", "remove", "rename", "set-url", "set-head", "set-branches", "prune", "update"].includes(remoteAction)) {
      return false;
    }
    return true;
  }
  return true;
}

/**
 * Single source of truth for the shell tool contract shown to the model.
 * Derived from the same allowlist/forbidden classes validateShellCommand enforces —
 * never hand-author a parallel description that can drift.
 */
export function getShellToolContractDescription(): string {
  const binaries = [...SAFE_SHELL_COMMANDS].sort().join(", ");
  const gitSubs = [...SAFE_SHELL_GIT_SUBCOMMANDS].join(", ");
  return [
    "Execute a read-only shell command in the workspace directory.",
    "Admission is a deterministic allowlist: illegal commands fail before execution — do not retry variants of a denied command.",
    `Allowed binaries: ${binaries}.`,
    "Pipelines and sequences with `|`, `&&`, and `;` are allowed when every segment starts with an allowlisted binary.",
    "Never use newlines, backticks, `$(...)`, bare `&`, `||`, `<`/`>` file redirection, `~`, or variable expansion.",
    "Safe redirect exceptions only: `>/dev/null`, `N>/dev/null`, and `N>&M` FD merges (e.g. `2>&1`).",
    "Absolute paths must stay under `/app`, or name a system binary under `/bin`, `/usr/bin`, or `/usr/local/bin`.",
    `Shell git is inspection-only (${gitSubs}); branch/remote mutation flags are denied. All git writes use the git tool.`,
    "Shell npm is only `npm run build`. sed only as `sed -n 'N,Mp' [file]` (file optional for pipeline stdin). find may not use -exec/-delete.",
    "Prefer scratch.read when the path is already known. Prefer parallel tool calls for independent work when latency matters; `;` sequencing is also valid for independent allowlisted segments.",
    "A non-zero process exit (e.g. rg/grep miss, git status 1) is returned as a normal tool result with an exit header — not a tool error. Do not retry solely because exit ≠ 0; read the body. Timeouts, spawn failures, and policy denials remain tool errors.",
  ].join(" ");
}

/**
 * Split a shell command into pipeline/sequence segments while honoring single and double
 * quotes. Only UNQUOTED `|`, `&&`, and `;` separate segments, so shell metacharacters inside a
 * quoted argument — e.g. the alternation in `grep -iE "cli|model|adapter"` or a literal
 * semicolon in `grep -F "a;b"` — are treated as literal data rather than being shredded into
 * fake segments whose contents then fail the command allowlist as if they were command names.
 * Quoted content is never a command name. This keeps read-only inspection working without
 * loosening any destructive/forbidden-token protection.
 */
function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    // A backslash escapes the next character in either state; consume both so an escaped
    // quote can never flip quote tracking (fails safe toward blocking, never opening).
    if (ch === "\\") {
      current += ch;
      if (i + 1 < command.length) {
        current += command[i + 1];
        i++;
      }
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "|") {
      // Unquoted single pipe separates commands (`||` is already rejected upstream).
      segments.push(current);
      current = "";
      continue;
    }
    if (ch === "&" && command[i + 1] === "&") {
      segments.push(current);
      current = "";
      i++;
      continue;
    }
    if (ch === ";") {
      // Unquoted semicolon sequences independent commands; each segment is still allowlisted.
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

export function validateShellCommand(command: string): ToolAuthorityDecision {
  if (!command.trim()) return { allowed: false, reason: "empty_command" };
  // Strip only harmless /dev/null discards and FD merges before forbidden-token checks.
  // Execution still receives the original command; this does not expand write surface.
  const normalized = stripSafeShellRedirectsForValidation(command);
  for (const { pattern, reason } of FORBIDDEN_SHELL_TOKEN_CLASSES) {
    if (pattern.test(normalized)) return { allowed: false, reason };
  }
  // Workspace root plus fixed system binary dirs for presence checks (`ls /usr/bin/rg`, `which`).
  // Everything else outside /app stays denied — no /etc, /home, /proc, or host FS walks.
  if (/(?:^|[\s\"'=\\])\/(?!app(?:\/|$)|bin(?:\/|$)|usr\/bin(?:\/|$)|usr\/local\/bin(?:\/|$))/.test(normalized)) {
    return { allowed: false, reason: "absolute_path_outside_workspace" };
  }
  if (/(?:^|[\s/])\.\.(?:[\s/]|$)/.test(normalized)) return { allowed: false, reason: "path_traversal_blocked" };

  const segments = splitShellSegments(normalized);
  if (segments.length === 0) return { allowed: false, reason: "empty_command" };
  for (const segment of segments) {
    const first = segment.match(/^([A-Za-z[\]]+)/)?.[1];
    if (!first || !SAFE_SHELL_COMMANDS.has(first)) return { allowed: false, reason: `command_not_allowlisted:${first || "unknown"}` };
    if (first === "sed" && !SAFE_SED_READ.test(segment)) return { allowed: false, reason: "sed_read_expression_required" };
    if (first === "which" && !/^which(?:\s+(?:--\s+)?[A-Za-z0-9._+-]+)+$/.test(segment)) {
      return { allowed: false, reason: "which_binary_name_required" };
    }
    if (first === "find" && /-(?:exec|execdir|delete|ok|okdir|fprintf|fprint0?|fls)\b/.test(segment)) return { allowed: false, reason: "mutating_find_blocked" };
    if (first === "sort" && /(?:^|\s)(?:-o(?:\s|$)|--output(?:=|\s)|--compress-program(?:=|\s))/.test(segment)) return { allowed: false, reason: "sort_write_or_program_blocked" };
    if (first === "uniq" && /(?:^|\s)--?output(?:=|\s)/.test(segment)) return { allowed: false, reason: "uniq_output_blocked" };
    if (first === "file" && /(?:^|\s)-(?:[^\s]*z|[^\s]*Z)(?:\s|$)/.test(segment)) return { allowed: false, reason: "file_decompress_blocked" };
    if (first === "git" && !isSafeShellGitSegment(segment)) {
      return { allowed: false, reason: "shell_git_read_only" };
    }
    if (first === "npm" && !/^npm\s+run\s+build\s*$/.test(segment)) return { allowed: false, reason: "npm_command_not_allowlisted" };
  }
  return { allowed: true };
}
