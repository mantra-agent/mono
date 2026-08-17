import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";

/** Closed day-one skill binding keys. Adding a key is a later Feature. */
export const DOCUMENT_TEMPLATE_BINDING_KEYS = ["spec", "daily", "weekly"] as const;
export type DocumentTemplateBindingKey = (typeof DOCUMENT_TEMPLATE_BINDING_KEYS)[number];

export const DOCUMENT_TEMPLATE_STATUSES = ["active", "deprecated"] as const;
export type DocumentTemplateStatus = (typeof DOCUMENT_TEMPLATE_STATUSES)[number];

/** Day-one global template ids (map keys skills resolve). */
export const DAY_ONE_DOCUMENT_TEMPLATE_IDS = ["spec", "daily-digest", "weekly-summary"] as const;
export type DayOneDocumentTemplateId = (typeof DAY_ONE_DOCUMENT_TEMPLATE_IDS)[number];

export function isDocumentTemplateBindingKey(value: string): value is DocumentTemplateBindingKey {
  return (DOCUMENT_TEMPLATE_BINDING_KEYS as readonly string[]).includes(value);
}

/**
 * Kind/path compatibility: which skill names may bind which keys.
 * Code-owned closed set — not a data catalog of skill instances beyond the two day-one producers.
 */
export const SKILL_TEMPLATE_KEY_COMPATIBILITY: Record<string, readonly DocumentTemplateBindingKey[]> = {
  "feature-pipeline": ["spec"],
  reflect: ["daily", "weekly"],
};

export function skillMayBindTemplateKey(skillName: string, key: string): boolean {
  const allowed = SKILL_TEMPLATE_KEY_COMPATIBILITY[skillName];
  if (!allowed) return false;
  return (allowed as readonly string[]).includes(key);
}

/** Template = id + name + page. That is the whole row. */
export const documentTemplates = pgTable(
  "document_templates",
  {
    /** Surrogate row key (global id and account overlays share the catalog id field). */
    rowId: varchar("row_id").primaryKey().default(sql`gen_random_uuid()`),
    /** Stable unique key within scope. Day-one globals: spec, daily-digest, weekly-summary. */
    id: varchar("id", { length: 64 }).notNull(),
    name: text("name").notNull(),
    pageId: text("page_id").notNull(),
    status: text("status").notNull().default("active"),
    scope: text("scope").notNull().default("global"),
    ownerUserId: text("owner_user_id"),
    accountId: text("account_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  },
  (table) => [
    uniqueIndex("document_templates_global_id_key")
      .on(table.id)
      .where(sql`${table.scope} = 'global'`),
    uniqueIndex("document_templates_account_id_key")
      .on(table.accountId, table.id)
      .where(sql`${table.scope} = 'user' AND ${table.accountId} IS NOT NULL`),
    index("idx_document_templates_scope_owner").on(table.scope, table.ownerUserId),
    index("idx_document_templates_account").on(table.accountId),
    index("idx_document_templates_page").on(table.pageId),
    index("idx_document_templates_status").on(table.status),
  ],
);

/** Named keys on a skill → template ids. Separate from skill_references content blobs. */
export const skillTemplateBindings = pgTable(
  "skill_template_bindings",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    skillId: varchar("skill_id").notNull(),
    key: varchar("key", { length: 32 }).notNull(),
    templateId: varchar("template_id", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  },
  (table) => [
    uniqueIndex("skill_template_bindings_skill_key").on(table.skillId, table.key),
    index("idx_skill_template_bindings_template").on(table.templateId),
  ],
);

export interface DocumentTemplate {
  id: string;
  name: string;
  pageId: string;
  status: DocumentTemplateStatus;
  scope: "global" | "user";
  ownerUserId: string | null;
  accountId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentTemplateCreate {
  id: string;
  name: string;
  pageId: string;
  status?: DocumentTemplateStatus;
}

export interface DocumentTemplateUpdate {
  name?: string;
  pageId?: string;
  status?: DocumentTemplateStatus;
}

export interface SkillTemplateBinding {
  id: string;
  skillId: string;
  key: DocumentTemplateBindingKey;
  templateId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResolvedDocumentTemplate {
  template: DocumentTemplate;
  pageId: string;
  pageTitle: string;
  templateMarkdown: string;
  source: "account" | "global";
}
