CREATE TABLE "voice_session_active" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"conversation_id" text,
	"started_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"ended_at" timestamp,
	"boot_id" text,
	CONSTRAINT "voice_session_active_session_id_unique" UNIQUE("session_id")
);
