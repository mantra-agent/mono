/**
 * Production wiring for the Council orchestrator. Bridges the pure
 * orchestrator (deps-injected, easily unit-testable) to:
 *  - spawnChildSession (cross-session messaging primitive)
 *  - chatFileStorage.createMessage (parent-window status + synthesis)
 *  - chatCompletion (synthesis call against the parent-tier model)
 *  - api_calls aggregation (cumulative cost + token tracking per run)
 */

import { chatFileStorage } from "../chat-file-storage";
import { spawnChildSession } from "../sessions/tree";
import { chatCompletion } from "../model-client";
// logApiCall import removed — inference recording is handled at the model-client
// boundary. sessionKey is now passed through InferenceMetadata to chatCompletion.
import { pool } from "../db";
import { createLogger } from "../log";
import {
  COUNCIL_HARD_ROUND_CAP,
  runCouncil,
  type CouncilDeps,
  type CouncilOptions,
  type CouncilResult,
  type CouncilSpawnRequest,
  type CouncilSpawnResult,
} from "./orchestrator";
import {
  fixedRoundsStrategy,
  parentJudgeStrategy,
  type ConvergenceStrategy,
  type CouncilPosition,
} from "./strategies";

export {
  COUNCIL_HARD_ROUND_CAP,
  runCouncil,
  fixedRoundsStrategy,
  parentJudgeStrategy,
};
export type {
  CouncilDeps,
  CouncilOptions,
  CouncilResult,
  ConvergenceStrategy,
  CouncilPosition,
};

const log = createLogger("Council");

/** Advocate spawner: routes to the autonomous skill runner with a model pin. */
async function productionSpawn(req: CouncilSpawnRequest): Promise<CouncilSpawnResult> {
  // Title encodes role + round so the sidebar makes deliberation structure
  // legible at a glance ("Advocate A — Round 2"). The runner persists this
  // verbatim via createAutonomousSession + saveSession.
  const title = `${req.role} — Round ${req.round}`;
  const result = await spawnChildSession(req.parentSessionId, {
    model: "max",
    spawnReason: req.spawnReason,
    spawnerTool: "council",
    spawnerSkillRun: req.spawnerSkillRun,
    preContext: req.preContext,
    waitForCompletion: true,
    modelOverride: req.model,
    sessionKeyOverride: req.sessionKeyOverride,
    titleOverride: title,
  });
  return {
    sessionId: result.sessionId,
    status: result.status ?? (result.output ? "succeeded" : "failed"),
    output: result.output,
    error: result.error,
  };
}

async function productionWriteParentMessage(
  sessionId: string,
  role: "system" | "assistant",
  content: string,
): Promise<void> {
  await chatFileStorage.createMessage(sessionId, role, content);
}

function buildProductionSynthesize(runScopedKey: string) {
  return async function productionSynthesize(
    question: string,
    finalPositions: CouncilPosition[],
    _history: CouncilPosition[][],
  ): Promise<string> {
    const positionBlock = finalPositions
      .map((p) => `## ${p.role}\n\n${p.output}`)
      .join("\n\n");
    // sessionKey is passed through InferenceMetadata so the boundary recording
    // in model-client captures the correct run-scoped session grouping. This
    // replaces a previous pattern where chatCompletion recorded at the boundary
    // AND a separate logApiCall was called here, causing double-counted tokens.
    const result = await chatCompletion({
      activity: "thinking",
      metadata: { source: "council-synthesis", activity: "thinking", sessionKey: runScopedKey },
      messages: [
        {
          role: "system",
          content:
            "You are the synthesizer for a strategic council. Two adversarial advocates have produced final positions on a hard question. Your job is to write the final answer: identify the strongest claim from each, name the genuine disagreements, and produce a single integrated recommendation. Be specific, not diplomatic.",
        },
        {
          role: "user",
          content: `Question:\n${question}\n\nFinal positions:\n${positionBlock}\n\nProduce the synthesis. Aim for 300-600 words. Structure: Recommendation → Key agreements → Genuine disagreements → Confidence + remaining unknowns.`,
        },
      ],
      maxTokens: 2000,
      temperature: 0.4,
    });
    return result.content.trim();
  };
}

function productionCumulativeUsage(
  runScopedKey: string,
  startedAt: Date,
): () => Promise<{ costUsd: number; tokens: number }> {
  return async () => {
    try {
      // Every API call inside this council run — both spawned advocates
      // (via runner sessionKeyOverride) and the synthesizer (via post-hoc
      // re-tag) — is keyed by `council:${runId}`. Aggregating by this key
      // gives reliable per-run cost/token totals regardless of how many
      // child sessions were spawned and regardless of the api_calls
      // session_id parseInt issue (base36 chat session ids → null).
      const result = await pool.query(
        `SELECT COALESCE(SUM(cost_total), 0)::float AS cost,
                COALESCE(SUM(input_tokens + output_tokens), 0)::int AS tokens
           FROM api_calls
          WHERE session_key = $1 AND timestamp >= $2`,
        [runScopedKey, startedAt],
      );
      const row = result.rows?.[0] as { cost?: number; tokens?: number } | undefined;
      return {
        costUsd: row?.cost ?? 0,
        tokens: row?.tokens ?? 0,
      };
    } catch (err: unknown) {
      log.warn(`[Council] cumulative-usage probe failed: ${err instanceof Error ? err.message : String(err)} — assuming 0`);
      return { costUsd: 0, tokens: 0 };
    }
  };
}

/** Build a default deps object wired to production primitives. */
export function buildProductionDeps(parentSessionId: string, runId?: string): CouncilDeps {
  // Use runId when provided (preferred) else parentSessionId so the run-scoped
  // sessionKey is unique per council run and aggregation is reliable.
  const runScopedKey = `council:${runId ?? parentSessionId}`;
  return {
    spawn: productionSpawn,
    writeParentMessage: productionWriteParentMessage,
    synthesize: buildProductionSynthesize(runScopedKey),
    getCumulativeUsage: productionCumulativeUsage(runScopedKey, new Date()),
  };
}
