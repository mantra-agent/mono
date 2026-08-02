CREATE TABLE IF NOT EXISTS "principle_revisions" (
  "id" text PRIMARY KEY NOT NULL,
  "principle_id" text NOT NULL REFERENCES "principles"("id") ON DELETE CASCADE,
  "revision_number" integer NOT NULL,
  "title" text NOT NULL,
  "layer1" text DEFAULT '' NOT NULL,
  "layer2" text DEFAULT '' NOT NULL,
  "scope" text DEFAULT 'user' NOT NULL,
  "owner_user_id" text,
  "account_id" text,
  "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "principle_revisions_principle_revision_idx"
  ON "principle_revisions" ("principle_id", "revision_number");
CREATE UNIQUE INDEX IF NOT EXISTS "principle_revisions_principle_id_idx"
  ON "principle_revisions" ("principle_id", "id");
CREATE INDEX IF NOT EXISTS "principle_revisions_account_idx"
  ON "principle_revisions" ("account_id");

ALTER TABLE "principles"
  ADD COLUMN IF NOT EXISTS "current_revision_id" text;

INSERT INTO "principle_revisions" (
  "id",
  "principle_id",
  "revision_number",
  "title",
  "layer1",
  "layer2",
  "scope",
  "owner_user_id",
  "account_id",
  "created_at"
)
SELECT
  'prrev_' || md5('principle-initial-revision:' || p."id"),
  p."id",
  1,
  p."title",
  p."layer1",
  p."layer2",
  p."scope",
  p."owner_user_id",
  p."account_id",
  p."created_at"
FROM "principles" p
WHERE NOT EXISTS (
  SELECT 1
  FROM "principle_revisions" r
  WHERE r."principle_id" = p."id"
);

UPDATE "principles" p
SET "current_revision_id" = (
  SELECT r."id"
  FROM "principle_revisions" r
  WHERE r."principle_id" = p."id"
  ORDER BY r."revision_number" DESC
  LIMIT 1
)
WHERE p."current_revision_id" IS NULL;

ALTER TABLE "principles"
  ALTER COLUMN "current_revision_id" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'principles_current_revision_fk'
  ) THEN
    ALTER TABLE "principles"
      ADD CONSTRAINT "principles_current_revision_fk"
      FOREIGN KEY ("id", "current_revision_id")
      REFERENCES "principle_revisions" ("principle_id", "id")
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
