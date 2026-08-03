ALTER TABLE "decisions" ADD COLUMN IF NOT EXISTS "owner_person_id" text;
ALTER TABLE "decisions" ADD COLUMN IF NOT EXISTS "source_session_id" text;
ALTER TABLE "decisions" ADD COLUMN IF NOT EXISTS "source_tool_call_id" text;
ALTER TABLE "decisions" ADD COLUMN IF NOT EXISTS "answer_payload" jsonb;
ALTER TABLE "decisions" ADD COLUMN IF NOT EXISTS "reasoning" text;
ALTER TABLE "decisions" ADD COLUMN IF NOT EXISTS "resolved_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "idx_decisions_owner_person"
  ON "decisions" ("owner_person_id");

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_decisions_question_replay"
  ON "decisions" ("account_id", "source_session_id", "source_tool_call_id")
  WHERE "account_id" IS NOT NULL
    AND "source_session_id" IS NOT NULL
    AND "source_tool_call_id" IS NOT NULL;
