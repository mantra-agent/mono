CREATE TABLE IF NOT EXISTS "email_triage_log" (
  "id" serial PRIMARY KEY NOT NULL,
  "gmail_message_id" text NOT NULL,
  "account_id" text NOT NULL,
  "tier" text NOT NULL,
  "sender_email" text,
  "subject" text,
  "triaged_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "email_triage_log_message_account_unique" UNIQUE("gmail_message_id", "account_id")
);
