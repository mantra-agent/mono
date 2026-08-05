CREATE TABLE IF NOT EXISTS "tool_output_admissions" (
  "id" serial PRIMARY KEY NOT NULL,
  "owner_account_id" varchar NOT NULL,
  "owner_user_id" varchar NOT NULL,
  "session_id" varchar,
  "run_id" varchar,
  "tool_call_id" varchar,
  "tool_name" varchar NOT NULL,
  "action" varchar DEFAULT '' NOT NULL,
  "disposition" varchar NOT NULL,
  "raw_chars" integer NOT NULL,
  "raw_tokens" integer NOT NULL,
  "injected_chars" integer NOT NULL,
  "injected_tokens" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "tool_output_admissions_owner_time_idx" ON "tool_output_admissions" USING btree ("owner_account_id", "owner_user_id", "created_at");
CREATE INDEX IF NOT EXISTS "tool_output_admissions_owner_tool_idx" ON "tool_output_admissions" USING btree ("owner_account_id", "owner_user_id", "tool_name", "action");
CREATE INDEX IF NOT EXISTS "tool_output_admissions_owner_run_idx" ON "tool_output_admissions" USING btree ("owner_account_id", "owner_user_id", "run_id");
