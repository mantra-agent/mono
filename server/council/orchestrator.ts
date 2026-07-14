/**
 * Council orchestrator: fans a strategic question out to two adversarial
 * frontier-tier child sessions, runs critique rounds with a swappable
 * convergence strategy, enforces a hard primitive-level round cap, handles
 * single-child-failure degradation, and writes a labeled "Council synthesis"
 * message into the parent session.
 *
 * All long-lived behavior is injected via a deps object so the orchestrator
 * is unit-testable without spawning real sessions or calling LLMs.
 */

import { createLogger } from "../log";
import { getModelForTier } from "../job-profiles";
import {
  type ConvergenceStrategy,
  type CouncilPosition,
  fixedRoundsStrategy,
} from "./strategies";

const log = createLogger("Council");

/** Hard primitive-level round cap. Strategies cannot override this. */
export const COUNCIL_HARD_ROUND_CAP = 5;

/**
 * Resolve the default advocates from the configured tier system.
 * Advocate A uses the Advocate tier; Advocate B uses the Advisary tier.
 * These two tiers are designed to be configured to DIFFERENT providers in
 * Settings so the council is genuinely adversarial across model families.
 * Production callers should pass explicit advocates; this fallback exists
 * only for tests and ad-hoc invocations that omit the field.
 */
export function getDefaultAdvocates(): AdvocateConfig[] {
  return [
    { role: "Advocate A", model: getModelForTier("max") },
    { role: "Advocate B", model: getModelForTier("max") },
  ];
}

export interface AdvocateConfig {
  role: string;
  model: string;
}

export interface CouncilSpawnRequest {
  parentSessionId: string;
  role: string;
  model: string;
  /** Round number (1-indexed) — propagated to the spawned session's title for sidebar organization. */
  round: number;
  spawnReason: string;
  spawnerSkillRun: string;
  preContext: string;
  /**
   * Per-run sessionKey override propagated to the runner so all api_calls
   * from this council run share a single session_key (e.g. `council:${runId}`).
   * The cumulative-usage probe aggregates by this key for reliable per-run
   * cost/token enforcement.
   */
  sessionKeyOverride?: string;
}

export interface CouncilSpawnResult {
  sessionId: string;
  status: "succeeded" | "failed" | "yielded";
  output?: string;
  error?: string;
}

export interface CouncilDeps {
  /** Spawn a single advocate child for one round. Must wait for completion. */
  spawn: (req: CouncilSpawnRequest) => Promise<CouncilSpawnResult>;
  /** Append a message into the parent council session (status / synthesis). */
  writeParentMessage: (sessionId: string, role: "system" | "assistant", content: string) => Promise<void>;
  /** Synthesize the final answer from the last round of positions. */
  synthesize: (question: string, finalPositions: CouncilPosition[], history: CouncilPosition[][]) => Promise<string>;
  /** Optional usage probe for observability; never gates council execution. */
  getCumulativeUsage?: () => Promise<{ costUsd: number; tokens: number }>;
  /** Clock injection for tests. */
  now?: () => number;
}

export interface CouncilOptions {
  parentSessionId: string;
  question: string;
  rounds?: number;
  strategy?: ConvergenceStrategy;
  advocates?: AdvocateConfig[];
  /** Identifier used to tag spawn tuples (e.g. parent skill-run id). */
  runId: string;
}

export type CouncilStatus = "succeeded" | "degraded" | "failed";

export interface CouncilResult {
  status: CouncilStatus;
  rounds: number;
  history: CouncilPosition[][];
  synthesis: string;
  durationMs: number;
  strategyName: string;
}

function buildAdvocatePrompt(
  question: string,
  role: string,
  opponentRole: string,
  round: number,
  history: CouncilPosition[][],
): string {
  if (round === 1) {
    return [
      `You are ${role} on a strategic council answering this question:`,
      "",
      question,
      "",
      "Give the strongest, most specific answer you can. Be concrete. State your assumptions. Surface tradeoffs. Aim for 200-500 words. Do not hedge.",
    ].join("\n");
  }

  const lastRound = history[history.length - 1] ?? [];
  const me = lastRound.find((p) => p.role === role);
  const opponent = lastRound.find((p) => p.role === opponentRole);

  const sections: string[] = [
    `You are ${role} on a strategic council. This is critique round ${round}.`,
    "",
    `Original question:\n${question}`,
    "",
  ];
  if (me) {
    sections.push(`Your prior position:\n${me.output}`, "");
  }
  if (opponent) {
    sections.push(
      `${opponentRole}'s position you must engage with:\n${opponent.output}`,
      "",
      `Now: (1) attack the strongest weakness in ${opponentRole}'s position with a specific counter, (2) revise your own position to address valid critiques, (3) end with your updated recommendation. 250-500 words.`,
    );
  } else {
    sections.push(
      `${opponentRole} did not produce a position this round. Steelman the strongest plausible counter to your own prior position, then revise. 250-500 words.`,
    );
  }
  return sections.join("\n");
}

export async function runCouncil(
  options: CouncilOptions,
  deps: CouncilDeps,
): Promise<CouncilResult> {
  const advocates = options.advocates && options.advocates.length === 2
    ? options.advocates
    : getDefaultAdvocates();
  if (advocates.length !== 2) {
    throw new Error(`Council requires exactly 2 advocates, got ${advocates.length}`);
  }

  const requestedRounds = options.rounds ?? COUNCIL_HARD_ROUND_CAP;
  const targetRounds = Math.min(Math.max(1, requestedRounds), COUNCIL_HARD_ROUND_CAP);
  if (requestedRounds > COUNCIL_HARD_ROUND_CAP) {
    log.warn(`[Council] requested rounds=${requestedRounds} exceeds hard cap ${COUNCIL_HARD_ROUND_CAP} — capping`);
  }

  const strategy = options.strategy ?? fixedRoundsStrategy(targetRounds);
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();

  // Single-source-of-truth observability: print exactly which provider/model
  // each advocate resolved to. Surfaces silent same-provider config bugs
  // (e.g. both sides on Anthropic) before deliberation begins.
  const providerOf = (m: string) => (m.includes("/") ? m.split("/")[0] : "?");
  const distinctProviders = new Set(advocates.map((a) => providerOf(a.model))).size;
  log.log(
    `[Council] start parent=${options.parentSessionId} runId=${options.runId} ` +
    `rounds=${targetRounds} strategy=${strategy.name} ` +
    `advocates=[${advocates.map((a) => `${a.role}=${providerOf(a.model)}/${a.model.split("/").slice(1).join("/") || a.model}`).join(", ")}] ` +
    `distinctProviders=${distinctProviders}`,
  );
  if (distinctProviders < advocates.length) {
    log.warn(
      `[Council] advocates share a provider (${advocates.map((a) => providerOf(a.model)).join(", ")}). ` +
      `For genuine adversarial deliberation configure the Advocate and Advisary tiers to DIFFERENT providers in Settings.`,
    );
  }

  await deps.writeParentMessage(
    options.parentSessionId,
    "system",
    `[Council] Starting deliberation — ${targetRounds} round(s) max (hard cap ${COUNCIL_HARD_ROUND_CAP}), strategy=${strategy.name}, advocates=${advocates.map((a) => `${a.role} (${a.model})`).join(" vs ")}.`,
  );

  const history: CouncilPosition[][] = [];
  let consecutiveFailures = 0;
  let degraded = false;

  let round = 0;
  while (round < targetRounds) {
    round += 1;

    const usage = (await (deps.getCumulativeUsage?.() ?? Promise.resolve({ costUsd: 0, tokens: 0 })));
    log.log(`[Council] round=${round}/${targetRounds} start (cumulative cost=$${usage.costUsd.toFixed(4)} tokens=${usage.tokens})`);
    await deps.writeParentMessage(
      options.parentSessionId,
      "system",
      `[Council] Round ${round}/${targetRounds} — fanning out to ${advocates.map((a) => a.role).join(" + ")}…`,
    );

    const opponentByRole = new Map<string, string>();
    opponentByRole.set(advocates[0].role, advocates[1].role);
    opponentByRole.set(advocates[1].role, advocates[0].role);

    const spawnPromises = advocates.map(async (adv): Promise<CouncilPosition> => {
      const opponentRole = opponentByRole.get(adv.role)!;
      const preContext = buildAdvocatePrompt(options.question, adv.role, opponentRole, round, history);
      // Spawn reason carries the human-readable role label ("Advocate A" /
      // "Advocate B") so renderers and audit trails surface it explicitly,
      // and ends with `:r${round}` for stable round-based filtering.
      const spawnReason = `council:${adv.role}:r${round}`;
      const spawnerSkillRun = `${options.runId}:r${round}:${adv.role.toLowerCase().replace(/\s+/g, "-")}`;
      try {
        const result = await deps.spawn({
          parentSessionId: options.parentSessionId,
          role: adv.role,
          model: adv.model,
          round,
          spawnReason,
          spawnerSkillRun,
          preContext,
          sessionKeyOverride: `council:${options.runId}`,
        });
        if (result.status !== "succeeded" || !result.output) {
          log.warn(`[Council] round=${round} ${adv.role} status=${result.status} err=${result.error ?? "no-output"}`);
          return {
            role: adv.role,
            sessionId: result.sessionId,
            output: result.output ?? "",
            failed: true,
            error: result.error ?? `status=${result.status}`,
          };
        }
        log.log(`[Council] spawn ok round=${round} role="${adv.role}" model=${adv.model} session=${result.sessionId} outputChars=${result.output.length}`);
        return { role: adv.role, sessionId: result.sessionId, output: result.output };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`[Council] round=${round} ${adv.role} spawn threw: ${msg}`);
        return { role: adv.role, sessionId: "", output: "", failed: true, error: msg };
      }
    });

    const positions = await Promise.all(spawnPromises);
    history.push(positions);

    const failures = positions.filter((p) => p.failed);
    if (failures.length === advocates.length) {
      consecutiveFailures += 1;
      log.error(`[Council] round=${round} all advocates failed — consecutiveFailures=${consecutiveFailures}`);
      await deps.writeParentMessage(
        options.parentSessionId,
        "system",
        `[Council] Round ${round}: BOTH advocates failed (${failures.map((f) => `${f.role}: ${f.error}`).join("; ")}). Aborting council.`,
      );
      const durationMs = now() - startedAt;
      const synthesis = `# Council synthesis (failed)\n\nThe council was unable to deliberate: both advocates failed in round ${round}.`;
      await deps.writeParentMessage(options.parentSessionId, "assistant", synthesis);
      log.log(`[Council] end status=failed rounds=${round} durationMs=${durationMs}`);
      return { status: "failed", rounds: round, history, synthesis, durationMs, strategyName: strategy.name };
    }
    if (failures.length > 0) {
      degraded = true;
      consecutiveFailures = 0;
      const survivor = positions.find((p) => !p.failed)!;
      await deps.writeParentMessage(
        options.parentSessionId,
        "system",
        `[Council] Round ${round}: ${failures.map((f) => f.role).join(", ")} failed (${failures.map((f) => f.error).join("; ")}). Continuing with ${survivor.role} only.`,
      );
      // Surface the surviving advocate's full output as its own message so
      // the parent thread still shows the round's actual content even when
      // a sibling failed.
      await deps.writeParentMessage(
        options.parentSessionId,
        "system",
        `**${survivor.role} — Round ${round}**\n\n${survivor.output}`,
      );
    } else {
      consecutiveFailures = 0;
      // Emit one message per advocate carrying their full position verbatim.
      // No slicing, no ellipsizing, no `|`-joining — readers need to see the
      // actual round output in the parent thread, not a 120-char teaser.
      for (const p of positions) {
        await deps.writeParentMessage(
          options.parentSessionId,
          "system",
          `**${p.role} — Round ${round}**\n\n${p.output}`,
        );
      }
    }

    const verdict = await strategy.check({
      round,
      targetRounds,
      positions,
      history,
    });
    log.log(`[Council] round=${round} convergence: ${verdict.converged ? "CONVERGED" : "continue"} — ${verdict.reason}`);
    if (verdict.converged) {
      await deps.writeParentMessage(
        options.parentSessionId,
        "system",
        `[Council] Convergence: ${verdict.reason}`,
      );
      break;
    }
  }

  const finalPositions = history[history.length - 1] ?? [];
  const validFinal = finalPositions.filter((p) => !p.failed && p.output.trim().length > 0);

  let synthesisBody: string;
  if (validFinal.length === 0) {
    synthesisBody = "The council produced no usable positions.";
  } else {
    try {
      synthesisBody = await deps.synthesize(options.question, validFinal, history);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[Council] synthesis failed: ${msg}`);
      synthesisBody = `Synthesis step failed (${msg}). Final positions:\n\n${validFinal.map((p) => `### ${p.role}\n${p.output}`).join("\n\n")}`;
    }
  }

  const header = degraded
    ? `# Council synthesis (degraded — ${history.length} round(s))`
    : `# Council synthesis (${history.length} round(s), strategy: ${strategy.name})`;
  const synthesis = `${header}\n\n${synthesisBody}`;
  await deps.writeParentMessage(options.parentSessionId, "assistant", synthesis);

  const durationMs = now() - startedAt;
  const status: CouncilStatus = degraded ? "degraded" : "succeeded";
  log.log(
    `[Council] end status=${status} rounds=${history.length} durationMs=${durationMs} synthesisLen=${synthesis.length}`,
  );
  return {
    status,
    rounds: history.length,
    history,
    synthesis,
    durationMs,
    strategyName: strategy.name,
  };
}
