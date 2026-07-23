/**
 * Child Session Block Lifecycle
 *
 * Emits and persists child_session_block events so the parent session's
 * UI can render inline child session widgets. Two emission points:
 *
 * 1. On spawn: widget appears and the canonical child session row drives activity
 * 2. On completion: summary/error/cost metadata is attached to the block
 *
 * Events go to both:
 * - eventBus (for live UI via useLiveSessionBlocks)
 * - chat-file-storage (for historical views via persisted messages)
 */

import { createLogger } from "../log";
import { eventBus } from "../event-bus";
import type { ChildSessionBlockMeta } from "@shared/models/chat";

const log = createLogger("ChildBlockLifecycle");

/**
 * Publish a child_session_block event to the parent's event stream
 * so useLiveSessionBlocks picks it up for live rendering.
 */
function publishChildSessionBlockEvent(
  parentSessionKey: string,
  block: ChildSessionBlockMeta,
): void {
  try {
    eventBus.publish({
      category: "chat",
      event: "chat.child_lifecycle",
      sessionKey: parentSessionKey,
      payload: {
        type: "child_session_block",
        block,
        sessionId: block.parentSessionId,
        sessionKey: parentSessionKey,
      },
    });
  } catch (err) {
    log.warn(`publishChildSessionBlockEvent failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Called when a child session is created. Persists the block message
 * and publishes the live event.
 */
export async function onChildSessionSpawned(
  parentSessionId: string,
  childSessionId: string,
  opts: {
    spawnReason?: string;
    title?: string;
    model?: string;
    planId?: string;
    stepId?: string;
    attemptId?: number;
    attemptNumber?: number;
    planPageRef?: string;
    workflowRunId?: string;
    workflowStageAttemptId?: number;
  },
): Promise<void> {
  const { chatFileStorage } = await import("../chat-file-storage");

  // Look up parent session key for event routing
  let parentSessionKey = `dashboard:${parentSessionId}`;
  try {
    const parent = await chatFileStorage.getSession(parentSessionId);
    if (parent?.sessionKey) parentSessionKey = parent.sessionKey;
  } catch { /* best effort */ }

  const now = new Date().toISOString();
  const block: ChildSessionBlockMeta = {
    childSessionId,
    parentSessionId,
    role: opts.title || opts.spawnReason || childSessionId,
    model: opts.model || null,
    startedAt: now,
    updatedAt: now,
    spawnReason: opts.spawnReason || null,
    planId: opts.planId || null,
    planStepId: opts.stepId || null,
    planAttemptId: opts.attemptId ?? null,
    planAttemptNumber: opts.attemptNumber ?? null,
    planPageRef: opts.planPageRef || null,
    workflowRunId: opts.workflowRunId || null,
    workflowStageAttemptId: opts.workflowStageAttemptId ?? null,
  };

  // Persist to parent session for historical views
  await chatFileStorage.createChildSessionBlockMessage(parentSessionId, block);

  // Publish live event
  publishChildSessionBlockEvent(parentSessionKey, block);

  log.log(`onChildSessionSpawned parent=${parentSessionId} child=${childSessionId} reason=${opts.spawnReason}`);
}

/**
 * Called when a child session completes (success, failure, or timeout).
 * Updates the persisted message and publishes the live event.
 */
export async function deleteChildSessionBlock(
  parentSessionId: string,
  childSessionId: string,
): Promise<boolean> {
  const { chatFileStorage } = await import("../chat-file-storage");

  let parentSessionKey = `dashboard:${parentSessionId}`;
  try {
    const parent = await chatFileStorage.getSession(parentSessionId);
    if (parent?.sessionKey) parentSessionKey = parent.sessionKey;
  } catch { /* best effort */ }

  const removed = await chatFileStorage.deleteChildSessionBlockMessage(parentSessionId, childSessionId);

  publishChildSessionBlockEvent(parentSessionKey, {
    childSessionId,
    parentSessionId,
    role: "Deleted child session",
    startedAt: new Date().toISOString(),
    error: "Deleted",
  });

  return removed;
}

export async function onChildSessionCompleted(
  parentSessionId: string,
  childSessionId: string,
  result: {
    status: "succeeded" | "degraded" | "failed" | "yielded";
    summary?: string;
    error?: string;
    durationMs?: number;
  },
): Promise<void> {
  const { chatFileStorage } = await import("../chat-file-storage");

  // Look up cost from the child session's messages
  let cost: number | null = null;
  try {
    const messages = await chatFileStorage.getMessagesBySession(childSessionId);
    cost = messages.reduce((sum, m) => sum + ((m as any).cost || 0), 0);
  } catch { /* best effort */ }

  // Look up parent session key for event routing
  let parentSessionKey = `dashboard:${parentSessionId}`;
  let spawnReason: string | null = null;
  let role: string = childSessionId;
  let model: string | null = null;
  let startedAt: string = new Date().toISOString();
  let planId: string | null = null;
  let planStepId: string | null = null;
  let planAttemptId: number | null = null;
  let planAttemptNumber: number | null = null;
  let planPageRef: string | null = null;
  let workflowRunId: string | null = null;
  let workflowStageAttemptId: number | null = null;
  try {
    const parent = await chatFileStorage.getSession(parentSessionId);
    if (parent?.sessionKey) parentSessionKey = parent.sessionKey;
  } catch { /* best effort */ }

  // Try to read the existing block to preserve original metadata
  try {
    const parentSession = await chatFileStorage.getSession(parentSessionId);
    if (parentSession) {
      const messages = (parentSession as any).messages as Array<{ role: string; childSession?: ChildSessionBlockMeta }>;
      const existing = messages?.find(
        m => m.role === "child_session_block" && m.childSession?.childSessionId === childSessionId
      );
      if (existing?.childSession) {
        spawnReason = existing.childSession.spawnReason || null;
        role = existing.childSession.role;
        model = existing.childSession.model || null;
        startedAt = existing.childSession.startedAt;
        planId = existing.childSession.planId || null;
        planStepId = existing.childSession.planStepId || null;
        planAttemptId = typeof existing.childSession.planAttemptId === "number" ? existing.childSession.planAttemptId : null;
        planAttemptNumber = existing.childSession.planAttemptNumber ?? null;
        planPageRef = existing.childSession.planPageRef || null;
        workflowRunId = existing.childSession.workflowRunId || null;
        workflowStageAttemptId = existing.childSession.workflowStageAttemptId ?? null;
      }
    }
  } catch { /* best effort */ }

  // Look up child session title for better role display
  try {
    const child = await chatFileStorage.getSession(childSessionId);
    if (child?.title) role = child.title;
  } catch { /* best effort */ }

  const updates: Partial<ChildSessionBlockMeta> = {
    updatedAt: new Date().toISOString(),
    elapsedMs: result.durationMs || null,
    cost,
    summary: result.summary || null,
    error: result.error || null,
  };

  // Update persisted message
  await chatFileStorage.updateChildSessionBlockMessage(parentSessionId, childSessionId, updates);

  // Publish live event with full block
  const block: ChildSessionBlockMeta = {
    childSessionId,
    parentSessionId,
    role,
    model,
    startedAt,
    updatedAt: new Date().toISOString(),
    elapsedMs: result.durationMs || null,
    cost,
    summary: result.summary || null,
    error: result.error || null,
    spawnReason,
    planId,
    planStepId,
    planAttemptId,
    planAttemptNumber,
    planPageRef,
    workflowRunId,
    workflowStageAttemptId,
  };
  publishChildSessionBlockEvent(parentSessionKey, block);

  log.log(`onChildSessionCompleted parent=${parentSessionId} child=${childSessionId} result=${result.status} elapsed=${result.durationMs}ms`);
}
