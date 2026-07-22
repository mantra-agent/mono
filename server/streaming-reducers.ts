/**
 * Pure streaming reducers — take StreamingContent + event args, return new StreamingContent.
 *
 * Ported from client/src/lib/streaming-state.ts as part of the
 * server-authoritative sessions migration. These are pure functions
 * with no side effects, no logging, and no client rendering concerns.
 *
 * Key differences from the client version:
 * - Uses StreamingContent (shared) instead of StreamingState (client)
 * - No createLogger / log calls
 * - No SUPPRESSED_CLIENT_STEPS — server records all steps
 */

import type { ExecutionStep, StreamingContent } from "@shared/streaming-types";

// ---------------------------------------------------------------------------
// appendThinking
// ---------------------------------------------------------------------------

export function appendThinking(state: StreamingContent, content: string, ts?: number): StreamingContent {
  const segments = [...state.segments];
  const lastSeg = segments[segments.length - 1];
  const stepTs = typeof ts === "number" ? ts : Date.now();

  if (lastSeg?.type === "timeline") {
    const steps = [...lastSeg.steps];
    const lastStep = steps[steps.length - 1];
    if (lastStep?.type === "thinking" && lastStep.status === "active") {
      const preservedTs = typeof ts === "number" && ts < lastStep.timestamp ? ts : lastStep.timestamp;
      steps[steps.length - 1] = { ...lastStep, timestamp: preservedTs, thinking: (lastStep.thinking || "") + content };
      segments[segments.length - 1] = { type: "timeline", steps };
      return { ...state, segments };
    }
    const newStep: ExecutionStep = {
      id: `thinking-${stepTs}-${Math.random().toString(36).slice(2, 6)}`,
      type: "thinking",
      timestamp: stepTs,
      thinking: content,
      status: "active",
    };
    steps.push(newStep);
    segments[segments.length - 1] = { type: "timeline", steps };
    return { ...state, segments };
  }

  const newStep: ExecutionStep = {
    id: `thinking-${stepTs}-${Math.random().toString(36).slice(2, 6)}`,
    type: "thinking",
    timestamp: stepTs,
    thinking: content,
    status: "active",
  };
  segments.push({ type: "timeline", steps: [newStep] });
  return { ...state, segments };
}

// ---------------------------------------------------------------------------
// finishThinking
// ---------------------------------------------------------------------------

export function finishThinking(state: StreamingContent): StreamingContent {
  const segments = state.segments.map(seg => {
    if (seg.type !== "timeline") return seg;
    return {
      ...seg,
      steps: seg.steps.map(s =>
        s.type === "thinking" && s.status === "active" ? { ...s, status: "done" as const } : s
      ),
    };
  });
  return { ...state, segments };
}

// ---------------------------------------------------------------------------
// addToolCall
// ---------------------------------------------------------------------------

export function addToolCall(
  state: StreamingContent,
  toolName: string | undefined,
  toolCallId?: string,
  args?: Record<string, unknown>,
  narrative?: string,
  parentId?: string,
): StreamingContent {
  if (toolCallId) {
    const existingSegIdx = state.segments.findIndex(seg =>
      seg.type === "timeline" && seg.steps.some(s => s.toolCallId === toolCallId)
    );
    if (existingSegIdx >= 0) {
      const hasArgs = args && Object.keys(args).length > 0;
      if (hasArgs || narrative || toolName) {
        const segments = [...state.segments];
        const seg = segments[existingSegIdx];
        if (seg.type === "timeline") {
          const steps = seg.steps.map(s => {
            if (s.toolCallId !== toolCallId) return s;
            const patch: Partial<ExecutionStep> = {};
            if (narrative && s.narrative !== narrative) patch.narrative = narrative;
            if (toolName && (!s.toolName || s.toolName !== toolName)) patch.toolName = toolName;
            if (hasArgs) patch.arguments = args;
            if (Object.keys(patch).length === 0) return s;
            return { ...s, ...patch };
          });
          segments[existingSegIdx] = { ...seg, steps };
          return { ...state, segments };
        }
      }
      return state;
    }
    if (!toolName) return state;
  }

  const updated = finishThinking(state);
  const segments = [...updated.segments];
  const newStep: ExecutionStep = {
    id: toolCallId ? `tool-${toolCallId}` : `tool-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: "tool_call",
    timestamp: Date.now(),
    toolName,
    toolCallId,
    arguments: args,
    status: "active",
    narrative: narrative || (args?.reasoning as string) || undefined,
    parentId,
  };

  const lastSeg = segments[segments.length - 1];
  if (lastSeg?.type === "timeline") {
    segments[segments.length - 1] = { type: "timeline", steps: [...lastSeg.steps, newStep] };
  } else {
    segments.push({ type: "timeline", steps: [newStep] });
  }
  return { ...updated, segments };
}

// ---------------------------------------------------------------------------
// resolveToolResult
// ---------------------------------------------------------------------------

export function resolveToolResult(
  state: StreamingContent,
  toolCallId?: string,
  result?: unknown,
  error?: string,
  toolName?: string,
  ts?: number,
  args?: Record<string, unknown>,
): StreamingContent {
  let foundMatch = false;
  const segments = state.segments.map(seg => {
    if (seg.type !== "timeline") return seg;
    return {
      ...seg,
      steps: seg.steps.map(s => {
        if (s.type !== "tool_call" || s.status !== "active") return s;
        if (toolCallId && s.toolCallId !== toolCallId) return s;
        foundMatch = true;
        const endedAt = typeof ts === "number" ? ts : Date.now();
        return {
          ...s,
          ...(args ? { arguments: args } : {}),
          result,
          error,
          status: error ? "error" as const : "done" as const,
          endedAt,
          startedAt: s.timestamp,
          elapsedMs: Math.max(0, endedAt - s.timestamp),
        };
      }),
    };
  });

  if (foundMatch && state.source !== null) {
    const lastSeg = segments[segments.length - 1];
    if (lastSeg?.type === "timeline") {
      const lastStep = lastSeg.steps[lastSeg.steps.length - 1];
      const alreadyHasActiveThinking = lastStep?.type === "thinking" && lastStep.status === "active" && !lastStep.thinking;
      if (!alreadyHasActiveThinking) {
        const stepTs = typeof ts === "number" ? ts : Date.now();
        const newThinkingStep: ExecutionStep = {
          id: `thinking-${stepTs}-${Math.random().toString(36).slice(2, 6)}`,
          type: "thinking",
          timestamp: stepTs,
          thinking: "",
          status: "active",
        };
        segments[segments.length - 1] = { type: "timeline", steps: [...lastSeg.steps, newThinkingStep] };
      }
    }
  }

  if (!foundMatch && toolCallId) {
    const orphanTs = typeof ts === "number" ? ts : Date.now();
    const syntheticStep: ExecutionStep = {
      id: `tool-orphan-${orphanTs}-${Math.random().toString(36).slice(2, 6)}`,
      type: "tool_call",
      timestamp: orphanTs,
      toolName: toolName || "unknown",
      toolCallId,
      arguments: args,
      result,
      error,
      status: error ? "error" : "done",
    };
    const lastSeg = segments[segments.length - 1];
    if (lastSeg?.type === "timeline") {
      segments[segments.length - 1] = { type: "timeline", steps: [...lastSeg.steps, syntheticStep] };
    } else {
      segments.push({ type: "timeline", steps: [syntheticStep] });
    }
  }

  return { ...state, segments };
}

// ---------------------------------------------------------------------------
// appendContent
// ---------------------------------------------------------------------------

export function appendContent(state: StreamingContent, delta: string): StreamingContent {
  const updated = finishThinking(state);
  const segments = [...updated.segments];
  const lastSeg = segments[segments.length - 1];

  if (lastSeg?.type === "content") {
    segments[segments.length - 1] = { type: "content", content: lastSeg.content + delta };
    return { ...updated, segments };
  }

  segments.push({ type: "content", content: delta });
  return { ...updated, segments };
}

// ---------------------------------------------------------------------------
// appendCompacting
// ---------------------------------------------------------------------------

export function appendCompacting(state: StreamingContent, content: string, status?: string, stepId?: string): StreamingContent {
  const segments = [...state.segments];

  if (stepId) {
    let foundMatch = false;
    const updated = segments.map(seg => {
      if (seg.type !== "timeline") return seg;
      const hasMatch = seg.steps.some(s => s.id === stepId);
      if (!hasMatch) return seg;
      foundMatch = true;
      return {
        ...seg,
        steps: seg.steps.map(s =>
          s.id === stepId
            ? { ...s, status: (status as "active" | "done" | "error") || s.status, thinking: content || s.thinking }
            : s
        ),
      };
    });
    if (foundMatch) return { ...state, segments: updated };
  }

  const lastSeg = segments[segments.length - 1];
  const newStep: ExecutionStep = {
    id: stepId || `compacting-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: "compacting",
    timestamp: Date.now(),
    thinking: content,
    status: (status as "active" | "done" | "error") || "active",
  };

  if (lastSeg?.type === "timeline") {
    segments[segments.length - 1] = { type: "timeline", steps: [...lastSeg.steps, newStep] };
  } else {
    segments.push({ type: "timeline", steps: [newStep] });
  }
  return { ...state, segments };
}

// ---------------------------------------------------------------------------
// addSystemStep
// ---------------------------------------------------------------------------

export function canonicalSystemStepId(stepName: string, stepId: string): string {
  return stepId.startsWith("system-") ? stepId : `system-${stepName}-${stepId}`;
}

export function addSystemStep(
  state: StreamingContent,
  stepName: string,
  detailOrOpts?: string | { systemStepName?: string; systemStepDetail?: string; systemStepMetadata?: Record<string, unknown>; status?: string; elapsedMs?: number; stepId?: string; parentId?: string; startedAt?: number; endedAt?: number; selfTimeMs?: number; timingKind?: ExecutionStep["timingKind"]; diagnosticVisibility?: ExecutionStep["diagnosticVisibility"]; childMode?: ExecutionStep["childMode"]; occurredAt?: number },
): StreamingContent {
  const segments = [...state.segments];
  const lastSeg = segments[segments.length - 1];

  const opts = typeof detailOrOpts === "object" ? detailOrOpts : undefined;
  const detail = typeof detailOrOpts === "string" ? detailOrOpts : opts?.systemStepDetail;
  const resolvedName = opts?.systemStepName || stepName;
  const rawStepId = opts?.stepId;
  const stepId = rawStepId
    ? canonicalSystemStepId(stepName, rawStepId)
    : `system-${stepName}-${Date.now()}`;
  const timingKind = opts?.timingKind ?? "span";
  const occurredAt = timingKind === "milestone" ? (opts?.occurredAt ?? opts?.endedAt ?? opts?.startedAt ?? Date.now()) : undefined;
  const startedAt = timingKind === "milestone" ? occurredAt : (opts?.startedAt ?? Date.now());
  const endedAt = timingKind === "milestone" ? occurredAt : opts?.endedAt;
  const elapsedMs = timingKind === "milestone"
    ? undefined
    : startedAt != null && endedAt != null
      ? Math.max(0, endedAt - startedAt)
      : opts?.elapsedMs;

  // No SUPPRESSED_CLIENT_STEPS — server records all steps.

  const repeatAllowlist = new Set(["voice_filler_sent", "voice_error", "voice_error_recovered", "tool_use"]);
  const skipDedup = repeatAllowlist.has(resolvedName);
  if (!skipDedup) {
    const existingIdx = lastSeg?.type === "timeline"
      ? lastSeg.steps.findIndex(s => s.type === "system" && (rawStepId ? s.id === stepId : s.systemStepName === resolvedName))
      : -1;
    if (existingIdx >= 0 && lastSeg?.type === "timeline") {
      return state;
    }
  }

  const newStep: ExecutionStep = {
    id: stepId,
    type: "system",
    timestamp: opts?.startedAt ?? Date.now(),
    systemStepName: resolvedName,
    systemStepDetail: detail,
    systemStepMetadata: opts?.systemStepMetadata,
    status: (opts?.status as ExecutionStep["status"]) || "active",
    elapsedMs,
    parentId: opts?.parentId,
    timingKind,
    diagnosticVisibility: opts?.diagnosticVisibility,
    childMode: opts?.childMode,
    occurredAt,
    startedAt,
    endedAt,
    selfTimeMs: opts?.selfTimeMs,
    toolCallId: rawStepId,
  };

  if (lastSeg?.type === "timeline") {
    const steps = [...lastSeg.steps];
    const thinkingIdx = steps.findIndex(s => s.type === "thinking" && s.status === "active");
    if (thinkingIdx >= 0) {
      steps.splice(thinkingIdx, 0, newStep);
    } else {
      steps.push(newStep);
    }
    segments[segments.length - 1] = { type: "timeline", steps };
  } else {
    segments.push({ type: "timeline", steps: [newStep] });
  }
  return { ...state, segments };
}

// ---------------------------------------------------------------------------
// resolveSystemStep
// ---------------------------------------------------------------------------

export function resolveSystemStep(
  state: StreamingContent,
  stepName: string,
  status: "done" | "error",
  elapsedMs?: number,
  detail?: string,
  stepId?: string,
  metadata?: Record<string, unknown>,
  parentId?: string,
  startedAt?: number,
  endedAt?: number,
  selfTimeMs?: number,
  timingKind?: ExecutionStep["timingKind"],
  diagnosticVisibility?: ExecutionStep["diagnosticVisibility"],
  childMode?: ExecutionStep["childMode"],
  occurredAt?: number,
): StreamingContent {
  const resolveStep = (s: ExecutionStep): ExecutionStep => {
    const resolvedTimingKind = timingKind ?? s.timingKind ?? "span";
    const resolvedOccurredAt = resolvedTimingKind === "milestone"
      ? (occurredAt ?? endedAt ?? startedAt ?? s.occurredAt ?? Date.now())
      : undefined;
    const resolvedStartedAt = resolvedTimingKind === "milestone" ? resolvedOccurredAt : (startedAt ?? s.startedAt);
    const resolvedEndedAt = resolvedTimingKind === "milestone" ? resolvedOccurredAt : (endedAt ?? Date.now());
    const resolvedElapsedMs = resolvedTimingKind === "milestone"
      ? undefined
      : resolvedStartedAt != null && resolvedEndedAt != null
        ? Math.max(0, resolvedEndedAt - resolvedStartedAt)
        : elapsedMs;
    return {
      ...s,
      status,
      elapsedMs: resolvedElapsedMs,
      systemStepDetail: detail ?? s.systemStepDetail,
      systemStepMetadata: metadata ?? s.systemStepMetadata,
      parentId: parentId ?? s.parentId,
      timingKind: resolvedTimingKind,
      diagnosticVisibility: diagnosticVisibility ?? s.diagnosticVisibility,
      childMode: childMode ?? s.childMode,
      occurredAt: resolvedOccurredAt,
      startedAt: resolvedStartedAt,
      endedAt: resolvedEndedAt,
      selfTimeMs: selfTimeMs ?? s.selfTimeMs,
    };
  };

  // Resolve the newest matching active step. A response can contain multiple
  // timeline groups with repeated system step names across model/tool loops;
  // resolving oldest-first leaves the current visible row active and its timer
  // keeps counting in the diagnostic view.
  for (let segIdx = state.segments.length - 1; segIdx >= 0; segIdx--) {
    const seg = state.segments[segIdx];
    if (seg.type !== "timeline") continue;

    const canonicalStepId = stepId ? canonicalSystemStepId(stepName, stepId) : undefined;
    const stepIdIdx = stepId
      ? seg.steps.findIndex(s => s.type === "system" && s.systemStepName === stepName && (s.id === canonicalStepId || s.toolCallId === stepId))
      : -1;
    const detailIdx = detail
      ? seg.steps.findLastIndex(s => s.type === "system" && s.systemStepName === stepName && s.status === "active" && s.systemStepDetail === detail)
      : -1;
    const activeIdx = seg.steps.findLastIndex(s => s.type === "system" && s.systemStepName === stepName && s.status === "active");
    const targetIdx = stepIdIdx >= 0 ? stepIdIdx : detailIdx >= 0 ? detailIdx : activeIdx;

    if (targetIdx < 0) continue;

    const segments = [...state.segments];
    segments[segIdx] = {
      ...seg,
      steps: seg.steps.map((s, i) => i === targetIdx ? resolveStep(s) : s),
    };
    return { ...state, segments };
  }

  // If a completion arrives without a matching active step, let the caller add
  // it as an already-completed diagnostic row. Returning a new object here makes
  // callers believe resolution happened when no row changed.
  return state;
}

// ---------------------------------------------------------------------------
// settleStream
// ---------------------------------------------------------------------------

export function settleStream(state: StreamingContent): StreamingContent {
  const segments = state.segments.map(seg => {
    if (seg.type !== "timeline") return seg;
    return {
      ...seg,
      steps: seg.steps
        .map(s => s.status === "active" ? { ...s, status: "done" as const } : s)
        .filter(s => !(s.type === "thinking" && !s.thinking)),
    };
  }).filter(seg => !(seg.type === "timeline" && seg.steps.length === 0));
  return { ...state, segments, source: null, turnId: null };
}
