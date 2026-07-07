ALTER TABLE "responsibility_runs" ADD COLUMN IF NOT EXISTS "intended_fire_at" timestamp(6) with time zone;
ALTER TABLE "responsibility_runs" ADD COLUMN IF NOT EXISTS "scheduled_slot_start" timestamp(6) with time zone;
ALTER TABLE "responsibility_runs" ADD COLUMN IF NOT EXISTS "scheduled_slot_end" timestamp(6) with time zone;

UPDATE "responsibility_runs"
SET
  "intended_fire_at" = COALESCE("intended_fire_at", ("metadata"->>'intendedFireAt')::timestamptz),
  "scheduled_slot_start" = COALESCE("scheduled_slot_start", ("metadata"->>'slotStart')::timestamptz),
  "scheduled_slot_end" = COALESCE("scheduled_slot_end", ("metadata"->>'slotEnd')::timestamptz)
WHERE "trigger" = 'scheduled'
  AND "metadata" IS NOT NULL
  AND ("metadata"->>'slotStart') IS NOT NULL
  AND ("metadata"->>'slotEnd') IS NOT NULL;

DELETE FROM "responsibility_runs" a
USING "responsibility_runs" b
WHERE a."trigger" = 'scheduled'
  AND b."trigger" = 'scheduled'
  AND a."scheduled_slot_start" IS NOT NULL
  AND a."scheduled_slot_end" IS NOT NULL
  AND a."responsibility_id" = b."responsibility_id"
  AND a."schedule_id" = b."schedule_id"
  AND a."scheduled_slot_start" = b."scheduled_slot_start"
  AND a."scheduled_slot_end" = b."scheduled_slot_end"
  AND a."id" < b."id";

CREATE UNIQUE INDEX IF NOT EXISTS "idx_responsibility_runs_scheduled_slot_unique"
ON "responsibility_runs" ("responsibility_id", "schedule_id", "scheduled_slot_start", "scheduled_slot_end")
WHERE "trigger" = 'scheduled' AND "scheduled_slot_start" IS NOT NULL AND "scheduled_slot_end" IS NOT NULL;
