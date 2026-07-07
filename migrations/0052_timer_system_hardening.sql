DROP INDEX IF EXISTS "idx_responsibility_runs_scheduled_slot_unique";

DELETE FROM "responsibility_runs" a
USING "responsibility_runs" b
WHERE a."trigger" = 'scheduled'
  AND b."trigger" = 'scheduled'
  AND a."status" = 'success'
  AND b."status" = 'success'
  AND a."scheduled_slot_start" IS NOT NULL
  AND a."scheduled_slot_end" IS NOT NULL
  AND a."responsibility_id" = b."responsibility_id"
  AND a."schedule_id" = b."schedule_id"
  AND a."scheduled_slot_start" = b."scheduled_slot_start"
  AND a."scheduled_slot_end" = b."scheduled_slot_end"
  AND a."id" < b."id";

CREATE UNIQUE INDEX IF NOT EXISTS "idx_responsibility_runs_successful_scheduled_slot_unique"
ON "responsibility_runs" ("responsibility_id", "schedule_id", "scheduled_slot_start", "scheduled_slot_end")
WHERE "trigger" = 'scheduled' AND "status" = 'success' AND "scheduled_slot_start" IS NOT NULL AND "scheduled_slot_end" IS NOT NULL;
