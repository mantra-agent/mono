import { randomUUID } from "crypto";
import { WebSocket } from "ws";
import type {
  FeatureControlAct,
  FeatureControlCommand,
  FeatureControlOutcome,
  FeatureControlReason,
  FeatureControlResult,
} from "@shared/feature-control";
import { createLogger } from "./log";
import { sessionManager } from "./session-manager";

const log = createLogger("FeatureControl");

const COMMAND_TIMEOUT_MS = 60_000;
const MAX_PENDING_COMMANDS = 100;

type PendingCommand = {
  socket: WebSocket;
  featureId: string;
  act: FeatureControlAct;
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: FeatureControlResult) => void;
};

const pendingCommands = new Map<string, PendingCommand>();

function terminalResult(
  pending: Pick<PendingCommand, "featureId" | "act">,
  commandId: string,
  outcome: FeatureControlOutcome,
  reason?: FeatureControlReason,
  extras?: { sessionId?: string; fastForwardOn?: boolean },
): FeatureControlResult {
  return {
    type: "feature.control.result",
    commandId,
    featureId: pending.featureId,
    act: pending.act,
    outcome,
    ...(reason ? { reason } : {}),
    ...(extras?.sessionId ? { sessionId: extras.sessionId } : {}),
    ...(typeof extras?.fastForwardOn === "boolean" ? { fastForwardOn: extras.fastForwardOn } : {}),
  };
}

function settlePending(
  commandId: string,
  outcome: FeatureControlOutcome,
  reason?: FeatureControlReason,
  extras?: { sessionId?: string; fastForwardOn?: boolean },
): boolean {
  const pending = pendingCommands.get(commandId);
  if (!pending) return false;
  pendingCommands.delete(commandId);
  clearTimeout(pending.timer);
  pending.resolve(terminalResult(pending, commandId, outcome, reason, extras));
  log.info("command settled", {
    commandId,
    featureId: pending.featureId,
    act: pending.act,
    outcome,
    reason: reason ?? null,
    sessionId: extras?.sessionId ?? null,
  });
  return true;
}

/**
 * Dispatch one Feature control act to the originating browser tab.
 * Mode + launch live in that tab; this never writes Feature stage/status.
 */
export function requestFeatureControl(input: {
  sessionId: string;
  clientId?: string;
  featureId: string;
  act: FeatureControlAct;
}): Promise<FeatureControlResult> {
  const commandId = `fc-${randomUUID()}`;
  if (pendingCommands.size >= MAX_PENDING_COMMANDS) {
    return Promise.resolve(
      terminalResult(
        { featureId: input.featureId, act: input.act },
        commandId,
        "unavailable",
        "capacity_exceeded",
      ),
    );
  }

  const target = sessionManager.resolveActiveClient(input.sessionId, input.clientId);
  if (target.outcome !== "resolved") {
    return Promise.resolve(
      terminalResult(
        { featureId: input.featureId, act: input.act },
        commandId,
        "unavailable",
        target.outcome === "no_active_client" ? "no_active_client" : "client_disconnected",
      ),
    );
  }

  const expiresAt = Date.now() + COMMAND_TIMEOUT_MS;
  const command: FeatureControlCommand = {
    type: "feature.control.command",
    commandId,
    featureId: input.featureId,
    act: input.act,
    expiresAt,
  };

  return new Promise<FeatureControlResult>((resolve) => {
    const timer = setTimeout(
      () => settlePending(commandId, "unavailable", "timed_out"),
      COMMAND_TIMEOUT_MS,
    );
    if (timer.unref) timer.unref();
    pendingCommands.set(commandId, {
      socket: target.socket,
      featureId: input.featureId,
      act: input.act,
      timer,
      resolve,
    });

    try {
      if (target.socket.readyState !== WebSocket.OPEN) {
        settlePending(commandId, "unavailable", "client_disconnected");
        return;
      }
      target.socket.send(JSON.stringify(command));
      log.info("command dispatched", {
        commandId,
        featureId: input.featureId,
        act: input.act,
        sessionId: input.sessionId,
      });
    } catch {
      settlePending(commandId, "unavailable", "send_failed");
    }
  });
}

export function resolveFeatureControlResult(input: {
  socket: WebSocket;
  commandId: string;
  outcome: FeatureControlOutcome;
  reason?: FeatureControlReason;
  sessionId?: string;
  fastForwardOn?: boolean;
}): boolean {
  const pending = pendingCommands.get(input.commandId);
  if (!pending || pending.socket !== input.socket) return false;
  return settlePending(input.commandId, input.outcome, input.reason, {
    sessionId: input.sessionId,
    fastForwardOn: input.fastForwardOn,
  });
}

export function cancelFeatureControlsForSocket(socket: WebSocket): void {
  const commandIds = Array.from(pendingCommands.entries())
    .filter(([, pending]) => pending.socket === socket)
    .map(([commandId]) => commandId);
  commandIds.forEach((commandId) => settlePending(commandId, "unavailable", "client_disconnected"));
}
