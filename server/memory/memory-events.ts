import { memoryEvents, type MemoryEventType } from "@shared/schema";

type MemoryEventRow = {
  entryId: number;
  eventType: MemoryEventType;
  details?: Record<string, unknown> | null;
  occurredAt?: Date | string | null;
};

type MemoryEventInsertTarget = {
  insert: (table: typeof memoryEvents) => {
    values: (row: {
      entryId: number;
      eventType: MemoryEventType;
      details: Record<string, unknown>;
      occurredAt: Date;
    }) => Promise<unknown> | unknown;
  };
};

export function normalizeMemoryEvent(row: MemoryEventRow): {
  entryId: number;
  eventType: MemoryEventType;
  details: Record<string, unknown>;
  occurredAt: Date;
} {
  const occurredAt = row.occurredAt ? new Date(row.occurredAt) : new Date();
  return {
    entryId: row.entryId,
    eventType: row.eventType,
    details: row.details ?? {},
    occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt,
  };
}

export async function insertMemoryEvent(
  target: MemoryEventInsertTarget,
  row: MemoryEventRow,
): Promise<void> {
  await target.insert(memoryEvents).values(normalizeMemoryEvent(row));
}
