CREATE TABLE IF NOT EXISTS "content_queue" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid(),
  "platform" text NOT NULL DEFAULT 'x',
  "content" text NOT NULL,
  "thread_parts" jsonb,
  "status" text NOT NULL DEFAULT 'draft',
  "scheduled_at" timestamp,
  "published_at" timestamp,
  "platform_post_id" text,
  "platform_url" text,
  "metadata" jsonb,
  "reject_reason" text,
  "retry_count" integer NOT NULL DEFAULT 0,
  "calendar_event_id" text,
  "created_at" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "idx_content_queue_status" ON "content_queue" ("status");
CREATE INDEX IF NOT EXISTS "idx_content_queue_scheduled" ON "content_queue" ("scheduled_at");
