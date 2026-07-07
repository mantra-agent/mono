/**
 * Council convergence strategies. A strategy decides whether the adversarial
 * round-loop should continue or terminate, and surfaces a human-readable
 * reason that the orchestrator writes inline to the parent session.
 */

import { createLogger } from "../log";

const log = createLogger("Council");

export interface CouncilPosition {
  role: string;
  sessionId: string;
  output: string;
  /** Set when this round's child session failed; output may be a fallback. */
  failed?: boolean;
  error?: string;
}

export interface ConvergenceContext {
  round: number;
  targetRounds: number;
  positions: CouncilPosition[];
  history: CouncilPosition[][];
}

export interface ConvergenceResult {
  converged: boolean;
  reason: string;
}

export interface ConvergenceStrategy {
  name: string;
  check(ctx: ConvergenceContext): Promise<ConvergenceResult>;
}

export function fixedRoundsStrategy(targetRounds: number): ConvergenceStrategy {
  const n = Math.max(1, Math.floor(targetRounds));
  return {
    name: `fixed-${n}-rounds`,
    async check(ctx: ConvergenceContext): Promise<ConvergenceResult> {
      const done = ctx.round >= n;
      const reason = done
        ? `fixed-rounds strategy: completed ${ctx.round}/${n}`
        : `fixed-rounds strategy: ${ctx.round}/${n} complete`;
      log.log(`[Council] strategy=fixed-${n} round=${ctx.round} converged=${done}`);
      return { converged: done, reason };
    },
  };
}

export type ParentJudgeFn = (ctx: ConvergenceContext) => Promise<ConvergenceResult>;

/**
 * parent-judge strategy: delegates the converged-or-not decision to a judge
 * function (typically a parent-tier LLM call). Always reports converged=true
 * once the configured target round count is reached, regardless of judge.
 */
export function parentJudgeStrategy(
  judge: ParentJudgeFn,
  options: { hardCeiling?: number } = {},
): ConvergenceStrategy {
  return {
    name: "parent-judge",
    async check(ctx: ConvergenceContext): Promise<ConvergenceResult> {
      if (options.hardCeiling && ctx.round >= options.hardCeiling) {
        const reason = `parent-judge strategy: ceiling ${options.hardCeiling} reached`;
        log.log(`[Council] strategy=parent-judge round=${ctx.round} converged=true reason=ceiling`);
        return { converged: true, reason };
      }
      try {
        const verdict = await judge(ctx);
        log.log(`[Council] strategy=parent-judge round=${ctx.round} converged=${verdict.converged} reason="${verdict.reason}"`);
        return verdict;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`[Council] strategy=parent-judge judge failed at round=${ctx.round}: ${msg} — defaulting to not-converged`);
        return { converged: false, reason: `parent-judge fallback: judge error (${msg})` };
      }
    },
  };
}
