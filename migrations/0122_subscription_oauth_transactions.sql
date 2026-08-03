CREATE TABLE IF NOT EXISTS "subscription_oauth_transactions" (
  "state_hash" text PRIMARY KEY NOT NULL,
  "provider" text NOT NULL,
  "code_verifier" text NOT NULL,
  "redirect_uri" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_subscription_oauth_transactions_expires" ON "subscription_oauth_transactions" ("expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_subscription_oauth_transactions_provider" ON "subscription_oauth_transactions" ("provider");
