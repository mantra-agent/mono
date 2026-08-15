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
  /** Canonical DB skill row ID and name, resolved by the autonomous runner. Never model-provided. */
  skillId?: string;
  skillName?: string;
  /** Native Runtime ownership, injected by the runner and never accepted from model arguments. */
  runtimeRunId?: string;
  runtimeAttemptId?: string;
  sessionId?: string;
  sessionKey?: string;
}

export type ToolAuthorityDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

const ENGINEERING_TOOLS = new Set(["shell", "python", "git", "code", "npm_dependencies", "railway", "expo", "sentry", "platforms"]);
const ENGINEERING_WRITE_ACTIONS: Record<string, ReadonlySet<string>> = {
  git: new Set(["clone", "pull", "branch", "checkout", "add", "commit", "push", "create_pr", "merge_pr", "delete_branch"]),
  npm_dependencies: new Set(["set_package"]),
  railway: new Set(["redeploy", "restart"]),
  expo: new Set(["start_build", "cancel"]),
  sentry: new Set(["resolve", "unresolve", "ignore"]),
  platforms: new Set([
    "create_connection", "create_platform", "update_platform", "create_product", "update_product",
    "create_product_legacy", "update_product_legacy",
    "create_environment", "update_environment", "delete_environment", "save_source_binding",
    "save_hosting_binding", "set_build_lifecycle",
    "disable_build_lifecycle", "delete_build_lifecycle", "start_build_workflow", "deploy_cloudflare_pages",
    "cancel_cloudflare_pages_deployment", "repair_cloudflare_pages_project",
  ]),
};

const MODEL_FORBIDDEN_ACTIONS: Record<string, ReadonlySet<string>> = {
  twitter: new Set(["post", "reply", "delete"]), // Hidden compatibility alias.
  content: new Set(["x_post", "x_reply", "x_delete"]),
  meetings: new Set(["update", "delete"]),
  backup: new Set(["delete"]),
  platforms: new Set(["create_connection"]),
  railway: new Set(["redeploy", "restart"]),
  expo: new Set(["cancel"]),
};

const INTERNAL_EXTERNAL_EFFECT_ALLOWLIST = new Set([
  "session:initiate",
  "session:set_attention",
  "session:message_parent",
  "session:message_child",
  "session:message_sibling",
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

function repositoryScratchTarget(
  toolName: string,
  action: string | undefined,
  args: Record<string, unknown>,
): unknown {
  return scratchAction(toolName, action) === "patch" ? args.repositoryDirectory : args.path;
}

function isRepositoryScratchWrite(
  toolName: string,
  action: string | undefined,
  args: Record<string, unknown>,
): boolean {
  const scratchMutation = scratchAction(toolName, action);
  if (!["write", "edit", "patch"].includes(scratchMutation || "")) return false;
  const candidate = repositoryScratchTarget(toolName, action, args);
  const path = typeof candidate === "string" ? candidate.trim().replace(/^\.\//, "") : "";
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
  if (toolName === "business" && (action === "get_budget" || action === "get_model" || action === "get_hiring_plan" || action === "list_hiring_slots")) return "system:read";
  if (toolName === "business" && (action?.includes("_budget_") || action === "set_assumption" || action === "link_assumption_kpi" || action === "clear_assumption_kpi")) return "system:write";
  if (isRepositoryScratchWrite(toolName, action, args)) return "build:write";
  if (!ENGINEERING_TOOLS.has(toolName)) return null;
  if (toolName === "shell" || toolName === "python") return "build:write";
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

  if (
    toolName === "system"
    && ["list_history_rollup_candidates", "save_history_rollup"].includes(action || "")
    && (origin !== "autonomous" || context.skillName !== "history-rollup" || !context.skillId)
  ) {
    return { allowed: false, reason: "history_rollup_skill_required" };
  }

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

  if (origin === "timer" && toolName === "session" && (action === "initiate" || action === "set_attention")) {
    return { allowed: false, reason: "timer_attention_owned_by_scheduler" };
  }

  if (toolName === "workflows" && context.trustedDelegation === "workflow" && !isWorkflowStageAction(action)) {
    return { allowed: false, reason: "workflow_stage_action_required" };
  }

  if (
    repositoryScratchWrite
    && !isSessionOwnedRepositoryPath(repositoryScratchTarget(toolName, action, args), context.sessionId)
  ) {
    return { allowed: false, reason: "session_owned_repository_required" };
  }

  if ((toolName === "shell" || toolName === "python" || repositoryScratchWrite) && !isTrustedEngineeringDelegation(context)) {
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
      && (toolName === "python" || ENGINEERING_WRITE_ACTIONS[toolName]?.has(action || ""));
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
      "Plan/workflow children and session.spawn_child children inherit trusted engineering provenance when their spawner already holds it; every named permission and session-clone boundary remains independently enforced.",
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
  // Exactly one explicitly allowlisted non-sensitive variable; see classifyNamedEnvironmentRead.
  "printenv",
]);

const SAFE_SHELL_ENVIRONMENT_NAMES = new Set([
  "CI",
  "NODE_ENV",
  "PORT",
  "RAILWAY_ENVIRONMENT_NAME",
  "RAILWAY_GIT_COMMIT_SHA",
  "RAILWAY_PUBLIC_DOMAIN",
  "RAILWAY_SERVICE_NAME",
]);

function classifyNamedEnvironmentRead(segment: string): string | null {
  const match = segment.match(/^printenv\s+([A-Z_][A-Z0-9_]*)$/);
  if (!match) return "forbidden:env_dump";
  return SAFE_SHELL_ENVIRONMENT_NAMES.has(match[1]) ? null : "forbidden:env_name";
}

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
 * Unquoted `||` is NOT forbidden here either, for the same structural reason: `splitShellSegments`
 * splits on every unquoted single `|`, so `a || b` yields segments `["a", "", "b"]`, the empty
 * middle is dropped, and each real segment still passes the binary/subcommand allowlist. Blocking
 * `||` while allowing `|`, `&&`, and `;` bought no marginal safety — a dangerous `x || curl evil`
 * still dies on the `curl` segment's own network-binary class — and was the single largest source
 * of read-only-inspection denial thrash. Quoted `||` (`grep -F "a||b"`) stays inert literal text.
 *
 * The prior bare-word ban on `credentials?|secrets?` was removed: it blocked read-only
 * inspection like `grep "secret" server/` while the scratch read path can already open any file
 * in the session clone, so the ban was incoherent theater. Real secret exposure stays blocked
 * structurally — env dumps (`env`/`printenv`), interpreters, and dotfile secret paths (`.env`,
 * `.aws`, `.git-credentials`, …) each retain their own class below.
 */
/**
 * Quote-masking policy for a forbidden-token class. Quoting a shell metacharacter can
 * neutralize its dangerous form, but only for classes where that's true for EVERY consuming
 * command, not just the ones we happened to test:
 *   - "all": masking both `'...'` and `"..."` spans is safe. True for pure operator syntax
 *     (bare `&`, `<`/`>`, `~`) that only functions as an operator when unquoted — inside
 *     ANY quotes it's inert literal text to every allowlisted command — and for bare command
 *     names (curl, python, env, …), since no allowlisted command invokes a program named by an
 *     argument string it receives.
 *   - "singleQuoteOnly": mask only `'...'` spans. Bash still performs command substitution and
 *     variable expansion inside `"..."`, so double-quoted `$(...)`/backticks/`$VAR` stay live
 *     and must keep failing.
 *   - "none": never mask, even inside quotes. `cat`, `head`, `tail`, `sed`, `stat`, `du`,
 *     `file`, `find`, `grep`, `rg` all accept a quoted path argument and still open/read that
 *     path — quoting `/root/.ssh` or `/etc/...` does not stop the read. Masking these would
 *     turn a quoted absolute/sensitive path into a bypass.
 */
type ShellMaskPolicy = "all" | "singleQuoteOnly" | "none";

const FORBIDDEN_SHELL_TOKEN_CLASSES: ReadonlyArray<{ pattern: RegExp; reason: string; maskPolicy: ShellMaskPolicy }> = [
  { pattern: /[\r\n]/, reason: "forbidden:multiline_command", maskPolicy: "none" },
  { pattern: /`|\$\(/, reason: "forbidden:command_substitution", maskPolicy: "singleQuoteOnly" },
  { pattern: /\$(?:\{|[A-Za-z0-9_?*#@!$-])/, reason: "forbidden:variable_expansion", maskPolicy: "singleQuoteOnly" },
  // Allow `2>&1` FD dup (pure stream merge). Any other bare `&` stays blocked.
  { pattern: /(?<!&)\&(?!&|\d)/, reason: "forbidden:background_execution", maskPolicy: "all" },
  { pattern: /[<>]/, reason: "forbidden:redirection", maskPolicy: "all" },
  { pattern: /~/, reason: "forbidden:home_expansion", maskPolicy: "all" },
  { pattern: /\b(?:curl|wget|nc|ncat|netcat|ssh|scp|sftp|ftp|telnet)\b/i, reason: "forbidden:network_binary", maskPolicy: "all" },
  { pattern: /\b(?:python|python3|node|deno|bun|perl|ruby|php|lua|eval|source)\b/i, reason: "forbidden:interpreter", maskPolicy: "all" },
  // Path-consuming classes: never masked. See ShellMaskPolicy "none" doc above.
  // Absolute system roots only. Unanchored `/home/` falsely blocked product paths like
  // `client/src/components/home/**` during ordinary clone inspection.
  { pattern: /(?:^|[\s"'=\\])\/(?:proc|sys|dev|root|home)(?:\/|$)/i, reason: "forbidden:sensitive_path", maskPolicy: "none" },
  { pattern: /(?:^|[\s/])\.(?:env|npmrc|netrc|gitconfig|git-credentials|aws|ssh|config)(?:[\s/]|$)/i, reason: "forbidden:dotfile_secret", maskPolicy: "none" },
];

/**
 * Mask the interior of quoted spans so forbidden-token regexes evaluate real shell syntax
 * instead of literal data trapped inside a quoted argument — e.g. `grep -E "cli|model|adapter"`
 * or `grep -F "a||b"` were being rejected as if the `|`/`||` inside the quotes were live
 * pipe/or operators. `maskDoubleQuoted` controls whether `"..."` spans are masked in addition
 * to `'...'` spans; see `ShellMaskPolicy` for which classes may use which mode.
 */
function maskQuotedSpans(command: string, maskDoubleQuoted: boolean): string {
  let masked = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const activeMask = quote === "'" || (quote === '"' && maskDoubleQuoted);
    if (ch === "\\") {
      masked += activeMask ? "x" : ch;
      if (i + 1 < command.length) {
        masked += activeMask ? "x" : command[i + 1];
        i++;
      }
      continue;
    }
    if (quote) {
      if (ch === quote) {
        masked += ch;
        quote = null;
      } else {
        masked += activeMask ? "x" : ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      masked += ch;
      continue;
    }
    masked += ch;
  }
  return masked;
}
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

/**
 * Known write/mutate git subcommands. Denied as `git_write_blocked` so recovery can
 * route to the git tool instead of thrashing on the generic read-only reason.
 * Keep this set aligned with bridge-era write coverage; unknown subs stay
 * `shell_git_read_only` (not in the read allowlist) rather than being labeled writes.
 */
const SHELL_GIT_WRITE_SUBCOMMANDS = new Set([
  "push",
  "commit",
  "merge",
  "rebase",
  "reset",
  "checkout",
  "switch",
  "tag",
  "stash",
  "cherry-pick",
  "pull",
  "fetch",
  "am",
  "format-patch",
  "init",
  "clone",
  "add",
  "rm",
  "mv",
  "restore",
  "bisect",
  "clean",
  "submodule",
  "worktree",
  "config",
  "reflog",
  "repack",
  "gc",
  "filter-branch",
  "replace",
  "notes",
  "sparse-checkout",
]);

/**
 * Classify a `git …` segment for shell admission.
 * Returns null when the segment is a permitted read-only inspection command;
 * otherwise a precise deny reason:
 *   - git_write_blocked: known write/mutate subcommand or mutation flag on an
 *     otherwise-read subcommand (branch -d, remote add, …)
 *   - shell_git_read_only: missing/unknown subcommand outside the read allowlist
 */
function classifyShellGitSegment(segment: string): string | null {
  // Skip read-only global options (`-C path`, `--no-pager`, `-c key=value`) before the subcommand.
  const tokens = segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  if (tokens[0] !== "git") return "shell_git_read_only";
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
  if (!sub) return "shell_git_read_only";
  if (SHELL_GIT_WRITE_SUBCOMMANDS.has(sub)) return "git_write_blocked";
  if (!SAFE_SHELL_GIT_SUBCOMMANDS.has(sub)) return "shell_git_read_only";
  if (sub === "branch") {
    // List/inspect only — block create/delete/rename/copy/upstream mutation flags.
    if (/\s(?:-[dDmM]|--delete|--move|--copy|--set-upstream-to|--unset-upstream|--edit-description)\b/.test(segment)) {
      return "git_write_blocked";
    }
    return null;
  }
  if (sub === "remote") {
    // Read-only remote inspection — block add/remove/rename/set-url/prune/update.
    const remoteAction = tokens[i + 1];
    if (remoteAction && ["add", "remove", "rename", "set-url", "set-head", "set-branches", "prune", "update"].includes(remoteAction)) {
      return "git_write_blocked";
    }
    return null;
  }
  return null;
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
    "Read-only workspace shell. Deterministic allowlist — denied commands fail closed; do not retry variants.",
    `Allow: ${binaries}.`,
    "Compose with `|` `||` `&&` `;` only when every segment starts allowlisted.",
    "Deny: newlines, backticks, command substitution, bare ampersand, redirects, home expansion, and active variable expansion. Single-quote dollar syntax when searching source so it stays inert.",
    `Environment commands: env is denied; bare printenv, options, assignments, multiple names, and unapproved names are denied; printenv permits exactly one of: ${[...SAFE_SHELL_ENVIRONMENT_NAMES].sort().join(", ")}.`,
    "Redirect exceptions: `>/dev/null`, `N>/dev/null`, `N>&M` (e.g. `2>&1`).",
    "Paths: under `/app`, or system bins in `/bin` `/usr/bin` `/usr/local/bin`.",
    `git: inspection-only (${gitSubs}). Writes → git_write_blocked (use git tool). Unknown/non-read → shell_git_read_only.`,
    "npm: `npm run build` and read-only `npm audit` (flags only, no `fix`). sed: `sed -n 'N,Mp' [file]`. find: no -exec/-delete.",
    "Prefer scratch.read for known paths; parallel tool calls over serial when independent.",
    "Exit ≠ 0 is a normal result (read body) — not a tool error. Timeouts/spawn/policy denials are tool errors.",
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
      // Unquoted single pipe separates commands. `||` yields an empty middle segment that
      // `.filter(Boolean)` drops, so each real side is still allowlisted independently.
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
  // Precompute both masked views once; each forbidden class picks its policy's view instead of
  // re-walking the quote state per pattern. Path-consuming classes use maskPolicy "none" and
  // read `normalized` directly — quoting never hides a real path argument from cat/head/etc.
  const maskedAllQuotes = maskQuotedSpans(normalized, true);
  const maskedSingleQuoteOnly = maskQuotedSpans(normalized, false);
  for (const { pattern, reason, maskPolicy } of FORBIDDEN_SHELL_TOKEN_CLASSES) {
    const target = maskPolicy === "all" ? maskedAllQuotes : maskPolicy === "singleQuoteOnly" ? maskedSingleQuoteOnly : normalized;
    if (pattern.test(target)) return { allowed: false, reason };
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
    if (first === "env") return { allowed: false, reason: "forbidden:env_dump" };
    if (first === "printenv") {
      const environmentDeny = classifyNamedEnvironmentRead(segment);
      if (environmentDeny) return { allowed: false, reason: environmentDeny };
    }
    if (first === "find" && /-(?:exec|execdir|delete|ok|okdir|fprintf|fprint0?|fls)\b/.test(segment)) return { allowed: false, reason: "mutating_find_blocked" };
    if (first === "sort" && /(?:^|\s)(?:-o(?:\s|$)|--output(?:=|\s)|--compress-program(?:=|\s))/.test(segment)) return { allowed: false, reason: "sort_write_or_program_blocked" };
    if (first === "uniq" && /(?:^|\s)--?output(?:=|\s)/.test(segment)) return { allowed: false, reason: "uniq_output_blocked" };
    if (first === "file" && /(?:^|\s)-(?:[^\s]*z|[^\s]*Z)(?:\s|$)/.test(segment)) return { allowed: false, reason: "file_decompress_blocked" };
    if (first === "git") {
      const gitDeny = classifyShellGitSegment(segment);
      if (gitDeny) return { allowed: false, reason: gitDeny };
    }
    if (
      first === "npm" &&
      !/^npm\s+run\s+build\s*$/.test(segment) &&
      // Read-only advisory scan: `npm audit` plus optional `--flag`/`--key=value` tokens only.
      // Excludes `npm audit fix` and every other subcommand because they are not `--`-prefixed,
      // keeping the verb read-only (no repo mutation, no install lifecycle scripts).
      !/^npm\s+audit(?:\s+--[A-Za-z0-9][A-Za-z0-9=.-]*)*\s*$/.test(segment)
    ) {
      return { allowed: false, reason: "npm_command_not_allowlisted" };
    }
  }
  return { allowed: true };
}

/**
 * Teaching-denial payloads: for each machine-readable deny `reason`, the legal alternative that
 * actually accomplishes the intent. A wall with no door produces retry-thrash — the model reaches
 * for a canonical, safety-oriented idiom (`$(...)`, `git merge-base`, `< file`), gets a bare code
 * back, and retries variants until the watchdog kills it. Naming the sanctioned path alongside the
 * rejection converts the wall into a door.
 *
 * This map is the single source of that guidance, colocated with the forbidden-token classes and
 * git classifier that emit the reasons — never hand-authored in the consumer, which drifts from the
 * policy it describes. Parameterized reasons (e.g. `command_not_allowlisted:<bin>`) are matched on
 * the prefix before `:`. Entries only exist where a legal alternative is meaningful; `empty_command`
 * and the like intentionally have none.
 */
const SHELL_DENIAL_GUIDANCE: Readonly<Record<string, string>> = {
  "forbidden:command_substitution":
    "Command substitution ($(...) or backticks) is blocked because the inner command never passes the allowlist. Run the inner command as its own shell call, then use its output.",
  "forbidden:variable_expansion":
    "Active shell variable expansion is blocked. Substitute the literal value yourself; when searching source for dollar syntax, put the pattern in single quotes so it stays inert.",
  "forbidden:redirection":
    "File redirection (< or >) is blocked. Allowlisted readers take a path argument directly (e.g. `sed -n '1,40p' file`); discard output with the permitted `>/dev/null`.",
  "forbidden:multiline_command":
    "Newlines are blocked. Send one command per call, or join independent segments with `;`, `&&`, `||`, or `|`.",
  "forbidden:background_execution":
    "Background execution (bare `&`) is blocked. Run in the foreground; only the `2>&1` / `N>&M` FD-merge form of `&` is allowed.",
  "forbidden:home_expansion":
    "`~` home expansion is blocked. Use an explicit path under the workspace or `/app`.",
  "forbidden:network_binary":
    "Network binaries (curl/wget/nc/ssh/…) are blocked. Use the `web` tool for URLs and the `git` tool for remote git operations.",
  "forbidden:interpreter":
    "Language interpreters (python/node/…) are blocked. Use the allowlisted read-only binaries, or run code through `npm run build`.",
  "forbidden:env_dump":
    "Bulk environment reads are blocked. `printenv` accepts exactly one explicitly allowlisted non-sensitive variable name with no options, assignments, expansion, or additional arguments.",
  "forbidden:env_name":
    "That environment variable is not on the non-sensitive read allowlist. Read tracked configuration instead; do not retry with aliases or broader environment commands.",
  "forbidden:sensitive_path":
    "That system path is blocked to prevent secret/host exposure. Inspect tracked files inside the session clone instead.",
  "forbidden:dotfile_secret":
    "That dotfile path is blocked to prevent credential exposure. Read tracked project files inside the session clone instead.",
  git_write_blocked:
    "Shell git is read-only. Use the git tool for clone/add/commit/push/PR/merge and branch mutation. Shell git allows only status, log, diff, show, branch, remote, rev-parse, grep.",
  shell_git_read_only:
    "Shell git admits only read-only subcommands (status/log/diff/show/branch/remote/rev-parse/grep). For history or ancestry, use `git log --oneline` piped to `grep`, or the git tool's log/show actions — `merge-base` and `rev-list` are not admitted.",
  absolute_path_outside_workspace:
    "Absolute paths must stay under `/app` or a system binary dir. Use a workspace-relative path such as `repos/…`.",
  path_traversal_blocked:
    "`..` path traversal is blocked. Use a direct workspace-relative path.",
  command_not_allowlisted:
    "That binary is not on the read-only allowlist. Use `scratch.read` for file contents, the `git`/`web` tools for their domains, or an allowlisted binary from the tool contract.",
  npm_command_not_allowlisted:
    "Through shell, npm permits only `npm run build` and read-only `npm audit` (flags only; `npm audit fix` and other subcommands are blocked).",
  sed_read_expression_required:
    "sed is read-only here: use `sed -n 'N,Mp' [file]`.",
  which_binary_name_required:
    "`which` needs a bare binary name, e.g. `which rg`.",
  mutating_find_blocked:
    "`find` may not use -exec/-delete/-ok. Use plain `find` to list paths.",
};

/**
 * Resolve the teaching-denial guidance for a shell deny reason, or undefined when none applies.
 * Parameterized reasons like `command_not_allowlisted:<bin>` match on the prefix before `:`.
 */
export function shellDenialGuidance(reason: string): string | undefined {
  const key = reason.startsWith("command_not_allowlisted") ? "command_not_allowlisted" : reason;
  return SHELL_DENIAL_GUIDANCE[key];
}
