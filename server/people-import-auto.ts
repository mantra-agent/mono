/**
 * Orchestration for high-confidence automatic People import decisions.
 * Loads candidate under principal → matches → pure policy → decision service.
 * Failures warn and leave the candidate pending; never fail parent sync.
 */
import { createLogger } from "./log";
import { listGmailAccounts } from "./gmail";
import {
  getPendingCandidatesFromDb,
  type StoredImportCandidate,
} from "./import-queue";
import {
  addImportCandidate,
  findImportMatches,
  getImportCandidate,
  mergeImportCandidate,
  skipImportCandidate,
  type PeopleImportDecisionResult,
} from "./people-import-decision-service";
import {
  evaluateAutoImportEligibility,
  isAutoImportSourceEnabled,
  PEOPLE_IMPORT_AUTO_POLICY_VERSION,
  type AutoEligibilityDecision,
} from "./people-import-auto-eligibility";
import { getCurrentPrincipal, requireCurrentUserPrincipal } from "./principal-context";

const log = createLogger("PeopleImportAuto");

const BACKFILL_CAP = 50;

export interface AutoImportRunResult {
  candidateId: string;
  action: AutoEligibilityDecision["action"];
  reason: AutoEligibilityDecision["reason"];
  decision?: PeopleImportDecisionResult;
  error?: string;
}

function candidateIdFor(email: string): string {
  return email.trim().toLowerCase();
}

function buildIdempotencyKey(args: {
  accountId: string;
  candidateId: string;
  action: string;
  targetPersonId?: string;
}): string {
  return [
    "people-import-auto",
    args.accountId,
    args.candidateId,
    args.action,
    args.targetPersonId || "none",
    PEOPLE_IMPORT_AUTO_POLICY_VERSION,
  ].join(":");
}

async function loadPrincipalContactMethods(): Promise<{ emails: string[]; phones: string[] }> {
  const emails = new Set<string>();
  try {
    const accounts = await listGmailAccounts();
    for (const account of accounts) {
      if (account.email) emails.add(account.email.trim().toLowerCase());
      if (account.id?.includes("@")) emails.add(account.id.trim().toLowerCase());
    }
  } catch (error) {
    log.debug("principal gmail accounts unavailable for self-skip", {
      errorName: error instanceof Error ? error.name : "unknown",
    });
  }
  const principal = getCurrentPrincipal();
  if (principal?.userId?.includes("@")) {
    emails.add(principal.userId.trim().toLowerCase());
  }
  return { emails: [...emails], phones: [] };
}

async function applyDecision(
  candidateId: string,
  decision: AutoEligibilityDecision,
): Promise<PeopleImportDecisionResult | undefined> {
  const principal = requireCurrentUserPrincipal();
  const accountId = principal.accountId || principal.userId || "unknown";
  const idempotencyKey = buildIdempotencyKey({
    accountId,
    candidateId,
    action: decision.action,
    targetPersonId: decision.personId,
  });

  if (decision.action === "merge") {
    if (!decision.personId) {
      throw new Error("auto merge missing personId");
    }
    return mergeImportCandidate({
      candidateId,
      mergePersonId: decision.personId,
      idempotencyKey,
      notes: decision.reason,
    });
  }

  if (decision.action === "add") {
    return addImportCandidate({
      candidateId,
      idempotencyKey,
      cabinetLevel: "network",
      notes: decision.reason,
    });
  }

  if (decision.action === "skip") {
    return skipImportCandidate({
      candidateId,
      idempotencyKey,
      notes: decision.reason,
    });
  }

  return undefined;
}

/**
 * Evaluate and optionally decide one pending candidate.
 * Safe to call repeatedly; already-decided candidates no-op at requirePending.
 */
export async function maybeAutoImportCandidate(candidateId: string): Promise<AutoImportRunResult> {
  const id = candidateIdFor(candidateId);
  try {
    requireCurrentUserPrincipal();
  } catch (error) {
    log.warn("auto-import skipped: missing user principal", {
      candidateId: id,
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return {
      candidateId: id,
      action: "leave_queued",
      reason: "auto:leave:ambiguous",
      error: "missing_principal",
    };
  }

  try {
    const record = await getImportCandidate(id);
    if (!record) {
      return {
        candidateId: id,
        action: "leave_queued",
        reason: "auto:leave:ambiguous",
        error: "not_found",
      };
    }
    if (record.candidate.decision !== "pending") {
      return {
        candidateId: id,
        action: "leave_queued",
        reason: "auto:leave:ambiguous",
        error: `already_${record.candidate.decision}`,
      };
    }

    if (!isAutoImportSourceEnabled(record.candidate.source)) {
      log.debug("auto-import leave_queued source_disabled", {
        candidateId: id,
        source: record.candidate.source || null,
      });
      return {
        candidateId: id,
        action: "leave_queued",
        reason: "auto:leave:source_disabled",
      };
    }

    const [matches, principalContacts] = await Promise.all([
      findImportMatches(id),
      loadPrincipalContactMethods(),
    ]);

    const eligibility = evaluateAutoImportEligibility({
      candidate: record.candidate,
      matches,
      principalEmails: principalContacts.emails,
      principalPhones: principalContacts.phones,
    });

    if (eligibility.action === "leave_queued") {
      log.debug("auto-import leave_queued", {
        candidateId: id,
        reason: eligibility.reason,
        source: record.candidate.source || null,
      });
      return { candidateId: id, action: eligibility.action, reason: eligibility.reason };
    }

    const decision = await applyDecision(id, eligibility);
    log.info("auto-import decided", {
      candidateId: id,
      action: eligibility.action,
      reason: eligibility.reason,
      outcome: decision?.outcome,
      personId: decision?.personId || eligibility.personId || null,
      policyVersion: PEOPLE_IMPORT_AUTO_POLICY_VERSION,
    });
    return {
      candidateId: id,
      action: eligibility.action,
      reason: eligibility.reason,
      decision,
    };
  } catch (error) {
    log.warn("auto-import evaluator failed; candidate left pending", {
      candidateId: id,
      errorName: error instanceof Error ? error.name : "unknown",
      errorMessage: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
    return {
      candidateId: id,
      action: "leave_queued",
      reason: "auto:leave:ambiguous",
      error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    };
  }
}

/**
 * After staging unknown email participants, evaluate each queued email for auto decision.
 * Soft-fail: never throws to parent sync/triage.
 * Also runs a bounded backlog backfill so candidates staged before auto-import shipped
 * (or re-touched without a new pending insert) still hit the high-confidence path.
 */
export async function maybeAutoImportAfterEmailStaging(
  emails: string[],
): Promise<AutoImportRunResult[]> {
  const unique = [...new Set(emails.map(candidateIdFor).filter(Boolean))];
  const results: AutoImportRunResult[] = [];
  for (const email of unique) {
    results.push(await maybeAutoImportCandidate(email));
  }
  // Drain historical pending under the same principal — Spec §10 backfill.
  await maybeRunAutoImportBackfill();
  return results;
}

/**
 * Soft-fail entry used when email activity may not have staged new candidates
 * (known-person interaction path, empty batch) but pending backlog may still
 * contain high-confidence rows that predate auto-import.
 */
export async function maybeAutoImportAfterEmailActivity(
  emails: string[] = [],
): Promise<void> {
  try {
    if (emails.length > 0) {
      await maybeAutoImportAfterEmailStaging(emails);
      return;
    }
    await maybeRunAutoImportBackfill();
  } catch (error) {
    log.warn("auto-import after email activity failed; candidates remain pending", {
      staged: emails.length,
      errorName: error instanceof Error ? error.name : "unknown",
    });
  }
}

/** Serialize backfill per process so concurrent email/triage workers do not thrash the queue. */
let backfillChain: Promise<unknown> = Promise.resolve();

/**
 * Bounded catch-up over pending day-one candidates (same policy). Soft-fail wrapper.
 * Safe on queue reads and email paths; never throws to callers.
 */
export async function maybeRunAutoImportBackfill(limit = BACKFILL_CAP): Promise<{
  scanned: number;
  decided: number;
  results: AutoImportRunResult[];
}> {
  const empty = { scanned: 0, decided: 0, results: [] as AutoImportRunResult[] };
  const run = async () => {
    try {
      return await runAutoImportBackfill(limit);
    } catch (error) {
      log.warn("auto-import backfill failed; candidates remain pending", {
        errorName: error instanceof Error ? error.name : "unknown",
        errorMessage: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      });
      return empty;
    }
  };
  const next = backfillChain.then(run, run);
  backfillChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * Bounded catch-up over pending day-one candidates (same policy).
 * Requires user principal. Prefer maybeRunAutoImportBackfill at call sites.
 */
export async function runAutoImportBackfill(limit = BACKFILL_CAP): Promise<{
  scanned: number;
  decided: number;
  results: AutoImportRunResult[];
}> {
  requireCurrentUserPrincipal();
  const cap = Math.max(1, Math.min(limit, BACKFILL_CAP));
  const pending = await getPendingCandidatesFromDb();
  const eligible = pending
    .filter((candidate: StoredImportCandidate) => isAutoImportSourceEnabled(candidate.source))
    .slice(0, cap);

  const results: AutoImportRunResult[] = [];
  let decided = 0;
  for (const candidate of eligible) {
    const result = await maybeAutoImportCandidate(candidate.email);
    results.push(result);
    if (result.action !== "leave_queued" && result.decision) decided += 1;
  }

  if (eligible.length > 0 || decided > 0) {
    log.info("auto-import backfill complete", {
      scanned: eligible.length,
      decided,
      policyVersion: PEOPLE_IMPORT_AUTO_POLICY_VERSION,
    });
  }
  return { scanned: eligible.length, decided, results };
}
