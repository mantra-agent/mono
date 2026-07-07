import { db } from "../db";
import { sql } from "drizzle-orm";

export async function migrateAddSourceEmailIdToDrafts() {
  await db.execute(sql`ALTER TABLE email_drafts ADD COLUMN IF NOT EXISTS source_email_id INTEGER`);

  await db.execute(sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'email_drafts_source_email_id_fk'
      ) THEN
        ALTER TABLE email_drafts
          ADD CONSTRAINT email_drafts_source_email_id_fk
          FOREIGN KEY (source_email_id)
          REFERENCES email_messages(id)
          ON DELETE SET NULL;
      END IF;
    END
    $$;
  `);
}
