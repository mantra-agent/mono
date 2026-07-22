import { createLogger } from "./log";
import type { Principal } from "./principal";

const log = createLogger("VaultAllowlist");

/**
 * Named system jobs that legitimately need cross-vault (see-all) access.
 *
 * Every system-principal path that touches vault-scoped tables must be named
 * and appear in this allowlist. Unnamed system principals that hit vault-scoped
 * predicates get a loud warning pointing here.
 *
 * To add a new job:
 *   1. Add the job name to this set
 *   2. Use createNamedSystemPrincipal(jobName) instead of createSystemPrincipal()
 *   3. Document why cross-vault access is needed
 *
 * Location: server/vault-allowlist.ts
 */
export const VAULT_CROSS_ACCESS_ALLOWLIST = new Set<string>([
  // Boot & migrations — run before any user context exists, raw SQL mostly,
  // but may hit scoped-storage during vault backfill or ownership repair
  "schema-bootstrap",
  "ensure-vaults",
  "legacy-ownership-repair",

  // Chat restart recovery performs one bounded, content-free discovery of
  // streaming text documents, then immediately restores each persisted owner
  // before reading or mutating the session document.
  "chat-recovery",

  // Memory maintenance — sleep cycle processes all memories for decay,
  // reinforcement, NREM merge across all vaults for the owning user
  "sleep-cycle",
  "memory-maintenance",
  "preference-vnext-migration",
  "personal-rule-audit-migration",

  // System-wide integration checks — OpenAI subscription account is
  // a platform-level resource, not per-vault
  "openai-subscription-check",

  // Model routing — model-client uses system principal for internal
  // API routing decisions, not user data access
  "model-client",

  // Backup — system-level data export needs to see all vaults
  "backup",

  // Brain export/import — full data portability
  "brain-export",
  "brain-import",

  // Autonomous skill runner — fallback when no users exist yet or
  // user resolution fails during background autonomous execution
  "autonomous-skill-runner",

  // Verified Recall callbacks and signed meeting media transports need one
  // cross-vault lookup from opaque session ID to durable owner. All work after
  // that lookup immediately re-enters the exact meeting owner's principal.
  "meeting-transport",
]);

// Throttle anonymous-system warnings to avoid log spam from hot paths
// that legitimately fall back to system principal via getCurrentPrincipalOrSystem().
let lastAnonWarning = 0;
const ANON_WARNING_INTERVAL_MS = 60_000;

/**
 * Check whether a system principal is allowed cross-vault access.
 * Returns true if allowed (with audit logging), throws if not.
 *
 * Called from scoped-storage when a system principal hits a vault-scoped predicate.
 */
export function assertSystemVaultAccess(
  principal: Principal,
  context?: string,
): boolean {
  if (principal.actorType !== "system") return true;

  const jobName = principal.jobName;

  if (!jobName) {
    // Anonymous system principal hitting vault-scoped data.
    // This is the getCurrentPrincipalOrSystem() fallback path.
    // Log a throttled warning to help find remaining unresolved paths.
    const now = Date.now();
    if (now - lastAnonWarning > ANON_WARNING_INTERVAL_MS) {
      lastAnonWarning = now;
      log.warn(
        "anonymous system principal accessing vault-scoped data — " +
        "add jobName via createNamedSystemPrincipal(). " +
        "See server/vault-allowlist.ts for the allowlist.",
        { context },
      );
    }
    // Allow but warn — backwards compat during migration
    return true;
  }

  if (VAULT_CROSS_ACCESS_ALLOWLIST.has(jobName)) {
    // Authorized cross-vault access — info-level audit (Google-style justified access)
    log.info("system vault access", { jobName, context });
    return true;
  }

  // Named job not in allowlist — hard error
  const msg =
    `System job "${jobName}" attempted cross-vault access but is not in the allowlist. ` +
    `Add "${jobName}" to VAULT_CROSS_ACCESS_ALLOWLIST in server/vault-allowlist.ts ` +
    `if this job legitimately needs cross-vault access.`;
  log.error(msg, { jobName, context });
  throw Object.assign(new Error(msg), { status: 403 });
}
