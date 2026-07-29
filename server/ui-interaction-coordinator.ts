import { randomUUID } from "crypto";
import { WebSocket } from "ws";
import type {
  UiInteractionCommand,
  UiInteractionMode,
  UiInteractionResourceSurface,
  UiInteractionTarget,
  UiInteractionTerminalResult,
} from "@shared/ui-interaction";
import { UI_INTERACTION_INTRODUCTION_MAX_LENGTH } from "@shared/ui-interaction";
import { createLogger } from "./log";
import { sessionManager } from "./session-manager";

const log = createLogger("UiInteraction");

const COMMAND_TIMEOUT_MS = 60_000;
const MAX_PENDING_COMMANDS = 100;

type UiInteractionSubject =
  | { type: "control"; target: UiInteractionTarget }
  | { type: "resource"; resource: string; surface: UiInteractionResourceSurface };

type PendingCommand = {
  socket: WebSocket;
  subject: UiInteractionSubject;
  mode: UiInteractionMode;
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: UiInteractionTerminalResult) => void;
};

const pendingCommands = new Map<string, PendingCommand>();

function terminalResult(
  pending: PendingCommand,
  outcome: UiInteractionTerminalResult["outcome"],
  reason?: UiInteractionTerminalResult["reason"],
): UiInteractionTerminalResult {
  const common = { mode: pending.mode, outcome, ...(reason ? { reason } : {}) };
  return pending.subject.type === "control"
    ? { subject: "control", target: pending.subject.target, ...common }
    : { subject: "resource", resource: pending.subject.resource, surface: pending.subject.surface, ...common };
}

function subjectLogFields(subject: UiInteractionSubject) {
  return subject.type === "control"
    ? { subject: subject.type, target: subject.target }
    : { subject: subject.type, resource: subject.resource, surface: subject.surface };
}

function settlePending(
  commandId: string,
  outcome: UiInteractionTerminalResult["outcome"],
  reason?: UiInteractionTerminalResult["reason"],
): boolean {
  const pending = pendingCommands.get(commandId);
  if (!pending) return false;
  pendingCommands.delete(commandId);
  clearTimeout(pending.timer);
  pending.resolve(terminalResult(pending, outcome, reason));
  log.info("command settled", {
    commandId,
    ...subjectLogFields(pending.subject),
    mode: pending.mode,
    outcome,
    reason: reason ?? null,
  });
  return true;
}

export function requestUiInteraction(input: {
  sessionId: string;
  clientId?: string;
  subject: UiInteractionSubject;
  mode: UiInteractionMode;
  /** Required narration for guide mode; ignored for execute. */
  introduction?: string;
}): Promise<UiInteractionTerminalResult> {
  if (pendingCommands.size >= MAX_PENDING_COMMANDS) {
    const pending = { subject: input.subject, mode: input.mode } as PendingCommand;
    return Promise.resolve(terminalResult(pending, "unavailable", "capacity_exceeded"));
  }

  const target = sessionManager.resolveActiveClient(input.sessionId, input.clientId);
  if (target.outcome !== "resolved") {
    const pending = { subject: input.subject, mode: input.mode } as PendingCommand;
    return Promise.resolve(terminalResult(pending, "unavailable", target.outcome));
  }

  const commandId = `ui-${randomUUID()}`;
  const expiresAt = Date.now() + COMMAND_TIMEOUT_MS;
  const introduction = (input.introduction ?? "").slice(0, UI_INTERACTION_INTRODUCTION_MAX_LENGTH);
  const command: UiInteractionCommand = input.subject.type === "resource"
    ? {
        type: "ui.interaction.command",
        commandId,
        subject: "resource",
        mode: "guide",
        resource: input.subject.resource,
        surface: input.subject.surface,
        introduction,
        expiresAt,
      }
    : input.mode === "guide"
      ? {
          type: "ui.interaction.command",
          commandId,
          target: input.subject.target,
          mode: "guide",
          introduction,
          expiresAt,
        }
      : {
          type: "ui.interaction.command",
          commandId,
          target: input.subject.target,
          mode: "execute",
          expiresAt,
        };

  return new Promise<UiInteractionTerminalResult>((resolve) => {
    const timer = setTimeout(() => settlePending(commandId, "unavailable", "timed_out"), COMMAND_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    pendingCommands.set(commandId, {
      socket: target.socket,
      subject: input.subject,
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
      log.info("command dispatched", {
        commandId,
        ...subjectLogFields(input.subject),
        mode: input.mode,
        sessionId: input.sessionId,
      });
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
