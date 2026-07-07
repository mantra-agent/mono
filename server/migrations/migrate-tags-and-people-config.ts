import { documentStorage } from "../memory/document-storage";
import { getSetting, setSetting } from "../system-settings";
import { createLogger } from "../log";

const log = createLogger("MigrateTagsAndPeopleConfig");

/**
 * One-time boot migration: moves tag index and people config documents
 * from workspace_documents into system_settings.
 *
 * Idempotent — skips each key if already present in system_settings.
 */
export async function migrateTagsAndPeopleConfig(): Promise<void> {
  try {
    let migrated = 0;

    // --- Tags index ---
    const tagsKey = "system.tags.index";
    const existingTags = await getSetting(tagsKey);
    if (!existingTags) {
      const tagDoc = await documentStorage.getDocument("tag", "index");
      if (tagDoc) {
        try {
          const parsed = JSON.parse(tagDoc.content);
          await setSetting(tagsKey, parsed);
          await documentStorage.deleteDocument("tag", "index");
          log.log("Migrated tag index to system_settings");
          migrated++;
        } catch (err) {
          log.error("Failed to migrate tag index", err);
        }
      }
    }

    // --- People config documents ---
    const configMappings = [
      { docId: "cabinet-config", settingKey: "system.people.cabinet-config", useMetadata: true },
      { docId: "time-budgets", settingKey: "system.people.time-budgets", useMetadata: true },
      { docId: "trust-config", settingKey: "system.people.trust-config", useMetadata: true },
      { docId: "gmail-skip-list", settingKey: "system.people.gmail-skip-list", useMetadata: true },
    ];

    for (const { docId, settingKey, useMetadata } of configMappings) {
      const existing = await getSetting(settingKey);
      if (existing) continue;

      const doc = await documentStorage.getDocument("person", docId);
      if (!doc) continue;

      try {
        const data = useMetadata ? doc.metadata : JSON.parse(doc.content);
        if (data) {
          await setSetting(settingKey, data);
          await documentStorage.deleteDocument("person", docId);
          log.log(`Migrated ${docId} to system_settings key=${settingKey}`);
          migrated++;
        }
      } catch (err) {
        log.error(`Failed to migrate ${docId}`, err);
      }
    }

    if (migrated > 0) {
      log.log(`Migration complete: migrated ${migrated} documents to system_settings`);
    } else {
      log.log("Nothing to migrate (already done or no source documents)");
    }
  } catch (err) {
    log.error("Tags/people-config migration failed (non-fatal)", err);
  }
}
