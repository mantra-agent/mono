ALTER TABLE "timers" ADD COLUMN IF NOT EXISTS "system_key" text;
CREATE UNIQUE INDEX IF NOT EXISTS "idx_timers_system_key_unique" ON "timers" ("system_key") WHERE "system_key" IS NOT NULL;
