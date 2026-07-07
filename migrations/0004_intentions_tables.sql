CREATE TABLE IF NOT EXISTS "intentions" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"why" text DEFAULT '' NOT NULL,
	"done_criteria" text DEFAULT '' NOT NULL,
	"type" text DEFAULT 'action' NOT NULL,
	"source" text DEFAULT 'engage_loop' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"relevance_conversation" text DEFAULT 'medium' NOT NULL,
	"relevance_autonomous" text DEFAULT 'low' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"added" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"expires" text,
	"resolved_at" text
);

CREATE TABLE IF NOT EXISTS "intention_attempts" (
	"id" serial PRIMARY KEY NOT NULL,
	"intention_id" text NOT NULL REFERENCES "intentions"("id") ON DELETE CASCADE,
	"timestamp" text NOT NULL,
	"skill_used" text DEFAULT '' NOT NULL,
	"conversation_id" text,
	"source" text DEFAULT 'autonomous' NOT NULL,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"output" text,
	"blocker" text,
	"tokens_cost" integer
);
