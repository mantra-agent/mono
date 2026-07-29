import { randomUUID } from "crypto";
import { WebSocket } from "ws";
import type {
  UiInteractionCommand,
  UiInteractionMode,
  UiInteractionTarget,
  UiInteractionTerminalResult,
} from "@shared/ui-interaction";
import { UI_INTERACTION_INTRODUCTION_MAX_LENGTH } from "@shared/ui-interaction";
import { createLogger } from "./log";
import { sessionManager } from "./session-manager";

const log = createLogger("UiInteraction");

const COMMAND_TIMEOUT_MS = 60_000;
const MAX_PENDING_COMMANDS = 100;

type PendingCommand = {
  socket: WebSocket;
  target: UiInteractionTarget;
  mode: UiInteractionMode;
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: UiInteractionTerminalResult) => void;
};

const pendingCommands = new Map<string, PendingCommand>();

function settlePending(
  commandId: string,
  outcome: UiInteractionTerminalResult["outcome"],
  reason?: UiInteractionTerminalResult["reason"],
): boolean {
  const pending = pendingCommands.get(commandId);
  if (!pending) return false;
  pendingCommands.delete(commandId);
  clearTimeout(pending.timer);
  pending.resolve({
    target: pending.target,
    mode: pending.mode,
    outcome,
    ...(reason ? { reason } : {}),
  });
  log.info("command settled", { commandId, target: pending.target, mode: pending.mode, outcome, reason: reason ?? null });
  return true;
}

export function requestUiInteraction(input: {
  sessionId: string;
  clientId?: string;
  target: UiInteractionTarget;
  mode: UiInteractionMode;
  /** Required narration for guide mode; ignored for execute. */
  introduction?: string;
}): Promise<UiInteractionTerminalResult> {
  if (pendingCommands.size >= MAX_PENDING_COMMANDS) {
    return Promise.resolve({
      target: input.target,
      mode: input.mode,
      outcome: "unavailable",
      reason: "capacity_exceeded",
    });
  }

  const target = sessionManager.resolveActiveClient(input.sessionId, input.clientId);
  if (target.outcome !== "resolved") {
    return Promise.resolve({
      target: input.target,
      mode: input.mode,
      outcome: "unavailable",
      reason: target.outcome,
    });
  }

  const commandId = `ui-${randomUUID()}`;
  const expiresAt = Date.now() + COMMAND_TIMEOUT_MS;
  const command: UiInteractionCommand = input.mode === "guide"
    ? {
        type: "ui.interaction.command",
        commandId,
        target: input.target,
        mode: "guide",
        introduction: (input.introduction ?? "").slice(0, UI_INTERACTION_INTRODUCTION_MAX_LENGTH),
        expiresAt,
      }
    : {
        type: "ui.interaction.command",
        commandId,
        target: input.target,
        mode: "execute",
        expiresAt,
      };

  return new Promise<UiInteractionTerminalResult>((resolve) => {
    const timer = setTimeout(() => settlePending(commandId, "unavailable", "timed_out"), COMMAND_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    pendingCommands.set(commandId, {
      socket: target.socket,
      target: input.target,
      mode: input.mode,
      timer,
      resolve,
    });

    try {
      if (target.socket.readyState !== WebSocket.OPEN) {
        settlePending(commandId, "unavailable", "client_disconnected");
        return;
      }
      target.socket.send(JSON.stringify(command));
      log.info("command dispatched", { commandId, target: input.target, mode: input.mode, sessionId: input.sessionId });
    } catch {
      settlePending(commandId, "unavailable", "send_failed");
    }
  });
}

export function resolveUiInteractionResult(input: {
  socket: WebSocket;
  commandId: string;
  outcome: UiInteractionTerminalResult["outcome"];
  reason?: UiInteractionTerminalResult["reason"];
}): boolean {
  const pending = pendingCommands.get(input.commandId);
  if (!pending || pending.socket !== input.socket) return false;
  return settlePending(input.commandId, input.outcome, input.reason);
}

export function cancelUiInteractionsForSocket(socket: WebSocket): void {
  const commandIds = Array.from(pendingCommands.entries())
    .filter(([, pending]) => pending.socket === socket)
    .map(([commandId]) => commandId);
  commandIds.forEach((commandId) => settlePending(commandId, "unavailable", "client_disconnected"));
}
