import { createLogger } from "../../log";

const log = createLogger("chat-run-lifecycle");

export type ChatRunInvalidation = "superseded" | "cancelled";

export interface ChatRunLease {
  sessionId: string;
  sessionKey: string;
  generation: number;
  startedAt: number;
  invalidatedBy?: ChatRunInvalidation;
}

export class ChatRunInvalidatedError extends Error {
  constructor(
    readonly sessionId: string,
    readonly generation: number,
    readonly reason: ChatRunInvalidation,
  ) {
    super(`Chat run ${reason} sessionId=${sessionId} generation=${generation}`);
    this.name = "ChatRunInvalidatedError";
  }
}

class ChatRunLifecycle {
  private active = new Map<string, ChatRunLease>();
  private generations = new Map<string, number>();

  begin(sessionId: string, sessionKey: string): ChatRunLease {
    const previous = this.active.get(sessionId);
    if (previous) previous.invalidatedBy = "superseded";
    const generation = (this.generations.get(sessionId) ?? 0) + 1;
    this.generations.set(sessionId, generation);
    const lease = { sessionId, sessionKey, generation, startedAt: Date.now() };
    this.active.set(sessionId, lease);
    log.log(`begin sessionId=${sessionId} generation=${generation}`);
    return lease;
  }

  current(sessionId: string): ChatRunLease | undefined {
    return this.active.get(sessionId);
  }

  isCurrent(lease: ChatRunLease): boolean {
    return this.active.get(lease.sessionId) === lease;
  }

  assertCurrent(lease: ChatRunLease): void {
    if (!this.isCurrent(lease)) {
      throw new ChatRunInvalidatedError(
        lease.sessionId,
        lease.generation,
        lease.invalidatedBy ?? "superseded",
      );
    }
  }

  setSessionKey(lease: ChatRunLease, sessionKey: string): void {
    if (this.isCurrent(lease)) lease.sessionKey = sessionKey;
  }

  annotateRunId(sessionId: string, runId: string): void {
    const lease = this.active.get(sessionId);
    if (lease) Object.assign(lease, { runId });
  }

  finish(lease: ChatRunLease): boolean {
    if (!this.isCurrent(lease)) return false;
    this.active.delete(lease.sessionId);
    log.log(`finish sessionId=${lease.sessionId} generation=${lease.generation}`);
    return true;
  }

  cancel(sessionId: string): ChatRunLease | undefined {
    const lease = this.active.get(sessionId);
    if (!lease) return undefined;
    lease.invalidatedBy = "cancelled";
    this.active.delete(sessionId);
    log.log(`cancel sessionId=${sessionId} generation=${lease.generation}`);
    return lease;
  }

  list(): Array<ChatRunLease & { runId?: string }> {
    return Array.from(this.active.values());
  }
}

export const chatRunLifecycle = new ChatRunLifecycle();
