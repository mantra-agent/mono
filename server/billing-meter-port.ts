import { createLogger } from "./log";

const log = createLogger("BillingMeterPort");

export interface OverageMeterEvent {
  accountId: string;
  quantity: number;
  period: string;
  idempotencyKey: string;
}

export type MeterEmitResult =
  | { outcome: "emitted" }
  | { outcome: "unconnected" }
  | { outcome: "failed"; error: string };

export type OverageMeterEmitter = (event: OverageMeterEvent) => Promise<MeterEmitResult>;

let emitter: OverageMeterEmitter | null = null;

/** Sibling Stripe collector registers here. This Feature never holds Stripe keys. */
export function registerOverageMeterEmitter(next: OverageMeterEmitter | null): void {
  emitter = next;
}

export async function emitOverageMeterEvent(event: OverageMeterEvent): Promise<MeterEmitResult> {
  if (!emitter) {
    log.debug(
      `meter port unconnected account=${event.accountId} period=${event.period} quantity=${event.quantity}`,
    );
    return { outcome: "unconnected" };
  }
  try {
    return await emitter(event);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`meter emit threw account=${event.accountId} period=${event.period}: ${message}`);
    return { outcome: "failed", error: message };
  }
}
