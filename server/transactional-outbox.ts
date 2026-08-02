import { and, eq } from "drizzle-orm";
import type { DrizzleTx } from "./db";
import type { Principal } from "./principal";
import { ownedInsertValues } from "./scoped-storage";
import { transactionalOutbox, type TransactionalOutboxRow } from "@shared/models/outbox";

const outboxScope = {
  scope: transactionalOutbox.scope,
  ownerUserId: transactionalOutbox.ownerUserId,
  accountId: transactionalOutbox.accountId,
};

export async function appendTransactionalOutboxEvent(
  tx: DrizzleTx,
  principal: Principal & { actorType: "user"; userId: string; accountId: string },
  input: {
    eventType: string;
    aggregateType: string;
    aggregateId: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
    availableAt?: Date;
  },
): Promise<TransactionalOutboxRow> {
  const [inserted] = await tx.insert(transactionalOutbox).values({
    eventType: input.eventType,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    idempotencyKey: input.idempotencyKey,
    payload: input.payload,
    availableAt: input.availableAt ?? new Date(),
    ...ownedInsertValues(principal, outboxScope),
    createdByUserId: principal.userId,
  }).onConflictDoNothing({
    target: [transactionalOutbox.ownerUserId, transactionalOutbox.accountId, transactionalOutbox.idempotencyKey],
  }).returning();
  const [row] = inserted ? [inserted] : await tx.select().from(transactionalOutbox).where(and(
    eq(transactionalOutbox.ownerUserId, principal.userId),
    eq(transactionalOutbox.accountId, principal.accountId),
    eq(transactionalOutbox.idempotencyKey, input.idempotencyKey),
  )).limit(1);
  if (!row) throw new Error("Transactional outbox append failed");
  if (
    row.eventType !== input.eventType
    || row.aggregateType !== input.aggregateType
    || row.aggregateId !== input.aggregateId
    || JSON.stringify(row.payload) !== JSON.stringify(input.payload)
  ) {
    throw Object.assign(new Error("Transactional outbox idempotency key names different content"), { status: 409 });
  }
  return row;
}
