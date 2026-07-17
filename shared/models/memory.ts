import {
  pgTable,
  serial,
  text,
  timestamp,
  jsonb,
  real,
  integer,
  index,
  boolean,
  unique,
  uniqueIndex,
  vector,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { sql } from "drizzle-orm";

export const docTypes = [
  "project",
  "task",
  "person",
  "goal",
  "principle",
  "responsibility",
  "issue",
  "tag",
  "chat",
  "memory",
  "skill",
  "identity",
  "template",
  "file",
  "checkin",
  "rule",
  "decision",
  "preference",
  "emotional_state",
  "belief",
  "prediction",
  "intention",
  "autonomy_tier",
  "priority",
  "chat_journal",
  "prompt_overrides",
  "issue_attachment",
  "testing",
  "voice_session",
  "voice_template",
] as const;
export type DocType = (typeof docTypes)[number];

export const workspaceDocuments = pgTable(
  "workspace_documents",
  {
    id: serial("id").primaryKey(),
    docType: text("doc_type").notNull(),
    docId: text("doc_id").notNull(),
    path: text("path").notNull(),
    title: text("title"),
    content: text("content").notNull().default(""),
    metadata: jsonb("metadata").default({}),
    scope: text("scope").notNull().default("user"),
    ownerUserId: text("owner_user_id"),
    accountId: text("account_id"),
    vaultId: text("vault_id"),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index("idx_ws_doc_type_id").on(table.docType, table.docId),
    index("idx_ws_doc_path").on(table.path),
    index("idx_ws_doc_type").on(table.docType),
    index("idx_ws_doc_scope_owner").on(table.scope, table.ownerUserId),
    index("idx_ws_doc_account").on(table.accountId),
    index("idx_ws_doc_vault").on(table.vaultId),
  ],
);

export const insertWorkspaceDocumentSchema = createInsertSchema(
  workspaceDocuments,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  embedding: true,
});

export type WorkspaceDocument = typeof workspaceDocuments.$inferSelect;
export type InsertWorkspaceDocument = z.infer<
  typeof insertWorkspaceDocumentSchema
>;

export const documentStoreDocuments = pgTable(
  "document_store_documents",
  {
    id: serial("id").primaryKey(),
    documentType: text("document_type").notNull(),
    documentId: text("document_id").notNull(),
    sourceTable: text("source_table"),
    sourceRowId: text("source_row_id"),
    path: text("path"),
    title: text("title"),
    content: text("content").notNull().default(""),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    scope: text("scope").notNull().default("user"),
    ownerUserId: text("owner_user_id"),
    accountId: text("account_id"),
    vaultId: text("vault_id"),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 6 })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 6 })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    uniqueIndex("uk_document_store_owner_type_id").on(
      table.scope,
      table.ownerUserId,
      table.accountId,
      table.documentType,
      table.documentId,
    ),
    uniqueIndex("uk_document_store_source_row").on(
      table.sourceTable,
      table.sourceRowId,
    ),
    index("idx_document_store_scope_owner").on(table.scope, table.ownerUserId),
    index("idx_document_store_account").on(table.accountId),
    index("idx_document_store_vault").on(table.vaultId),
    index("idx_document_store_type_id").on(table.documentType, table.documentId),
    index("idx_document_store_source_row").on(table.sourceTable, table.sourceRowId),
    index("idx_document_store_path").on(table.path),
    index("idx_document_store_updated_at").on(table.updatedAt),
  ],
);

export const insertDocumentStoreDocumentSchema = createInsertSchema(
  documentStoreDocuments,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type DocumentStoreDocument = typeof documentStoreDocuments.$inferSelect;
export type InsertDocumentStoreDocument = z.infer<
  typeof insertDocumentStoreDocumentSchema
>;

export const memoryLayers = ["short", "mid", "long", "workspace"] as const;
export type MemoryLayer = (typeof memoryLayers)[number];

export const memoryIntegrationStages = [
  "stage_0",
  "stage_1",
  "stage_2",
  "stage_3",
  "stage_4",
] as const;
export type MemoryIntegrationStage = (typeof memoryIntegrationStages)[number];

export const MEMORY_INTEGRATION_STAGE = {
  RAW: "stage_0",
  ENRICHED: "stage_1",
  INTEGRATED: "stage_2",
  CANONICAL: "stage_3",
  UPKEEP: "stage_4",
} as const satisfies Record<string, MemoryIntegrationStage>;

export const MEMORY_LAYER_DEFAULT_INTEGRATION_STAGE: Record<
  MemoryLayer,
  MemoryIntegrationStage
> = {
  short: MEMORY_INTEGRATION_STAGE.RAW,
  mid: MEMORY_INTEGRATION_STAGE.ENRICHED,
  long: MEMORY_INTEGRATION_STAGE.CANONICAL,
  workspace: MEMORY_INTEGRATION_STAGE.ENRICHED,
};

export function hasStageOneMemoryFields(entry: {
  title?: string | null;
  summary?: string | null;
  tags?: string[] | null;
}): boolean {
  return Boolean(
    entry.title?.trim() &&
      entry.summary?.trim() &&
      Array.isArray(entry.tags) &&
      entry.tags.length > 0,
  );
}

export function deriveMemoryIntegrationStage(entry: {
  integrationStage?: string | null;
  layer?: string | null;
  title?: string | null;
  summary?: string | null;
  tags?: string[] | null;
}): MemoryIntegrationStage {
  if (
    entry.integrationStage &&
    (memoryIntegrationStages as readonly string[]).includes(entry.integrationStage)
  ) {
    return entry.integrationStage as MemoryIntegrationStage;
  }
  if (hasStageOneMemoryFields(entry)) return MEMORY_INTEGRATION_STAGE.ENRICHED;
  if (
    entry.layer &&
    (memoryLayers as readonly string[]).includes(entry.layer)
  ) {
    return MEMORY_LAYER_DEFAULT_INTEGRATION_STAGE[entry.layer as MemoryLayer];
  }
  return MEMORY_INTEGRATION_STAGE.RAW;
}

export const memorySources = [
  "conversation",
  "event",
  "tool",
  "responsibility",
  "manual",
  "project",
  "task",
  "person",
  "goal",
  "principle",
  "issue",
  "tag",
  "chat",
  "memory",
  "skill",
  "identity",
  "template",
  "file",
  "checkin",
  "chat_journal",
  "prompt_overrides",
  "testing",
  "voice_session",
  "voice_template",
  "belief",
  "act",
  "library",
  "note",
  "dream",
] as const;
export type MemorySource = (typeof memorySources)[number];

export const memoryEntries = pgTable(
  "memory_entries",
  {
    id: serial("id").primaryKey(),
    layer: text("layer").notNull().default("short"),
    integrationStage: text("integration_stage").notNull().default("stage_0"),
    content: text("content").notNull(),
    summary: text("summary"),
    contentHash: text("content_hash"),
    source: text("source").notNull().default("manual"),
    sourceId: text("source_id"),
    scope: text("scope").notNull().default("user"),
    ownerUserId: text("owner_user_id"),
    accountId: text("account_id"),
    vaultId: text("vault_id"),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    path: text("path"),
    title: text("title"),
    oneLiner: text("one_liner"),
    metadata: jsonb("metadata").default({}),
    tags: text("tags")
      .array()
      .default(sql`'{}'::text[]`),
    graphed: boolean("graphed").default(false),
    pinned: boolean("pinned").default(false),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 6 })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    processedAt: timestamp("processed_at", {
      withTimezone: true,
      precision: 6,
    }),
    processingStatus: text("processing_status").notNull().default("idle"),
    processingRunId: text("processing_run_id"),
    processingStartedAt: timestamp("processing_started_at", {
      withTimezone: true,
      precision: 6,
    }),
    processingError: text("processing_error"),
    processingUpdatedAt: timestamp("processing_updated_at", {
      withTimezone: true,
      precision: 6,
    }),
    emotionalStateId: integer("emotional_state_id"),
  },
  (table) => [
    unique("uk_memory_layer_source_id").on(
      table.layer,
      table.source,
      table.sourceId,
    ),
    index("idx_memory_source_id").on(table.sourceId),
    index("idx_memory_source").on(table.source),
    index("idx_memory_path").on(table.path),
    index("idx_memory_layer_created_at").on(table.layer, table.createdAt),
    index("idx_memory_integration_stage").on(table.integrationStage),
    index("idx_memory_processing_status").on(table.processingStatus),
    index("idx_memory_processing_run").on(table.processingRunId),
    index("idx_memory_scope_owner").on(table.scope, table.ownerUserId),
    index("idx_memory_account").on(table.accountId),
    index("idx_memory_vault").on(table.vaultId),
  ],
);

export const insertMemoryEntrySchema = createInsertSchema(memoryEntries).omit({
  id: true,
  createdAt: true,
  embedding: true,
});

export type MemoryEntry = typeof memoryEntries.$inferSelect;
export type InsertMemoryEntry = z.infer<typeof insertMemoryEntrySchema>;

export const memorySourceRelationships = [
  "supports",
  "contradicts",
  "refines",
  "supersedes",
  "depends_on",
  "example_of",
  "extracted_from",
  "weakens",
] as const;
export type MemorySourceRelationship =
  (typeof memorySourceRelationships)[number];

export const memorySourceRefs = pgTable(
  "memory_sources",
  {
    id: serial("id").primaryKey(),
    memoryId: integer("memory_id")
      .notNull()
      .references(() => memoryEntries.id, { onDelete: "cascade" }),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    relationship: text("relationship").notNull().default("extracted_from"),
    context: text("context").notNull().default(""),
    quote: text("quote"),
    spanStart: integer("span_start"),
    spanEnd: integer("span_end"),
    strength: real("strength").notNull().default(1),
    scope: text("scope").notNull().default("user"),
    ownerUserId: text("owner_user_id"),
    accountId: text("account_id"),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 6 })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    unique("uk_memory_sources_ref").on(
      table.memoryId,
      table.sourceType,
      table.sourceId,
      table.relationship,
    ),
    index("idx_memory_sources_memory").on(table.memoryId),
    index("idx_memory_sources_source").on(table.sourceType, table.sourceId),
    index("idx_memory_sources_relationship").on(table.relationship),
    index("idx_memory_sources_scope_owner").on(table.scope, table.ownerUserId),
    index("idx_memory_sources_account").on(table.accountId),
  ],
);

export const insertMemorySourceRefSchema = createInsertSchema(
  memorySourceRefs,
).omit({
  id: true,
  createdAt: true,
});

export type MemorySourceRef = typeof memorySourceRefs.$inferSelect;
export type InsertMemorySourceRef = z.infer<typeof insertMemorySourceRefSchema>;


export const memoryVnextClaimTypes = ["state", "cause", "action"] as const;
export type MemoryVnextClaimType = (typeof memoryVnextClaimTypes)[number];

export const memoryVnextLifecycleStages = [
  "extracted",
  "sourced",
  "linked",
  "canonical",
  "retired",
] as const;
export type MemoryVnextLifecycleStage = (typeof memoryVnextLifecycleStages)[number];

export const MEMORY_VNEXT_LIFECYCLE_STAGE = {
  EXTRACTED: "extracted",
  SOURCED: "sourced",
  LINKED: "linked",
  CANONICAL: "canonical",
  RETIRED: "retired",
} as const satisfies Record<string, MemoryVnextLifecycleStage>;

export const memoryVnextClaims = pgTable(
  "memory_vnext_claims",
  {
    id: serial("id").primaryKey(),
    title: text("title"),
    content: text("content").notNull(),
    claimType: text("claim_type").notNull(),
    confidence: real("confidence").notNull().default(0.5),
    topics: text("topics")
      .array()
      .default(sql`'{}'::text[]`),
    entityMentions: jsonb("entity_mentions").default([]),
    sourceClaimIndex: integer("source_claim_index"),
    lifecycleStage: text("lifecycle_stage").notNull().default("extracted"),
    lifecycleStageUpdatedAt: timestamp("lifecycle_stage_updated_at", {
      withTimezone: true,
      precision: 6,
    })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    contentHash: text("content_hash").notNull(),
    embedding: vector("embedding", { dimensions: 384 }),
    sourceMemoryId: integer("source_memory_id"),
    source: text("source").notNull().default("manual"),
    sourceId: text("source_id"),
    scope: text("scope").notNull().default("user"),
    ownerUserId: text("owner_user_id"),
    accountId: text("account_id"),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    metadata: jsonb("metadata").default({}),
    recallCount: integer("recall_count").notNull().default(0),
    lastRecalledAt: timestamp("last_recalled_at", {
      withTimezone: true,
      precision: 6,
    }),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 6 })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 6 })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    unique("uk_memory_vnext_claim_content_hash").on(table.contentHash),
    index("idx_memory_vnext_claim_type").on(table.claimType),
    index("idx_memory_vnext_claim_source_memory").on(table.sourceMemoryId),
    index("idx_memory_vnext_claim_source").on(table.source, table.sourceId),
    index("idx_memory_vnext_claim_lifecycle_stage").on(table.lifecycleStage),
    index("idx_memory_vnext_claim_created_at").on(table.createdAt),
    index("idx_memory_vnext_claim_scope_owner").on(table.scope, table.ownerUserId),
    index("idx_memory_vnext_claim_account").on(table.accountId),
  ],
);

export const insertMemoryVnextClaimSchema = createInsertSchema(
  memoryVnextClaims,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type MemoryVnextClaim = typeof memoryVnextClaims.$inferSelect;
export type InsertMemoryVnextClaim = z.infer<typeof insertMemoryVnextClaimSchema>;

export const memoryVnextSourceRefs = pgTable(
  "memory_vnext_sources",
  {
    id: serial("id").primaryKey(),
    claimId: integer("claim_id")
      .notNull()
      .references(() => memoryVnextClaims.id, { onDelete: "cascade" }),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    relationship: text("relationship").notNull().default("extracted_from"),
    context: text("context").notNull().default(""),
    quote: text("quote"),
    spanStart: integer("span_start"),
    spanEnd: integer("span_end"),
    strength: real("strength").notNull().default(1),
    scope: text("scope").notNull().default("user"),
    ownerUserId: text("owner_user_id"),
    accountId: text("account_id"),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 6 })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    unique("uk_memory_vnext_sources_ref").on(
      table.claimId,
      table.sourceType,
      table.sourceId,
      table.relationship,
    ),
    index("idx_memory_vnext_sources_claim").on(table.claimId),
    index("idx_memory_vnext_sources_source").on(table.sourceType, table.sourceId),
    index("idx_memory_vnext_sources_relationship").on(table.relationship),
    index("idx_memory_vnext_sources_scope_owner").on(table.scope, table.ownerUserId),
    index("idx_memory_vnext_sources_account").on(table.accountId),
  ],
);

export const insertMemoryVnextSourceRefSchema = createInsertSchema(
  memoryVnextSourceRefs,
).omit({
  id: true,
  createdAt: true,
});

export type MemoryVnextSourceRef = typeof memoryVnextSourceRefs.$inferSelect;
export type InsertMemoryVnextSourceRef = z.infer<typeof insertMemoryVnextSourceRefSchema>;

export const memoryVnextEntityLinks = pgTable(
  "memory_vnext_entity_links",
  {
    id: serial("id").primaryKey(),
    claimId: integer("claim_id")
      .notNull()
      .references(() => memoryVnextClaims.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    scope: text("scope").notNull().default("user"),
    ownerUserId: text("owner_user_id"),
    accountId: text("account_id"),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 6 })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    unique("uk_memory_vnext_entity_link").on(
      table.claimId,
      table.entityType,
      table.entityId,
    ),
    index("idx_memory_vnext_entity_claim").on(table.claimId),
    index("idx_memory_vnext_entity").on(table.entityType, table.entityId),
    index("idx_memory_vnext_entity_scope_owner").on(table.scope, table.ownerUserId),
    index("idx_memory_vnext_entity_account").on(table.accountId),
  ],
);

export const insertMemoryVnextEntityLinkSchema = createInsertSchema(
  memoryVnextEntityLinks,
).omit({
  id: true,
  createdAt: true,
});

export type MemoryVnextEntityLink = typeof memoryVnextEntityLinks.$inferSelect;
export type InsertMemoryVnextEntityLink = z.infer<typeof insertMemoryVnextEntityLinkSchema>;

export const memoryVnextClaimLinks = pgTable(
  "memory_vnext_claim_links",
  {
    id: serial("id").primaryKey(),
    fromClaimId: integer("from_claim_id")
      .notNull()
      .references(() => memoryVnextClaims.id, { onDelete: "cascade" }),
    toClaimId: integer("to_claim_id")
      .notNull()
      .references(() => memoryVnextClaims.id, { onDelete: "cascade" }),
    relationship: text("relationship").notNull(),
    strength: real("strength").notNull().default(0.5),
    scope: text("scope").notNull().default("user"),
    ownerUserId: text("owner_user_id"),
    accountId: text("account_id"),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 6 })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    unique("uk_memory_vnext_claim_link").on(
      table.fromClaimId,
      table.toClaimId,
      table.relationship,
    ),
    index("idx_memory_vnext_claim_links_from").on(table.fromClaimId),
    index("idx_memory_vnext_claim_links_to").on(table.toClaimId),
    index("idx_memory_vnext_claim_links_scope_owner").on(table.scope, table.ownerUserId),
    index("idx_memory_vnext_claim_links_account").on(table.accountId),
  ],
);

export const insertMemoryVnextClaimLinkSchema = createInsertSchema(
  memoryVnextClaimLinks,
).omit({
  id: true,
  createdAt: true,
});

export type MemoryVnextClaimLink = typeof memoryVnextClaimLinks.$inferSelect;
export type InsertMemoryVnextClaimLink = z.infer<typeof insertMemoryVnextClaimLinkSchema>;

export interface NeighborhoodCacheEntry {
  id: number;
  title: string | null;
  summary: string | null;
  relationship: string;
  relationshipType: RelationshipType;
  strength: number;
  hop: number;
  tags: string[];
}

export interface NeighborhoodCache {
  version: number;
  computedAt: string;
  entries: NeighborhoodCacheEntry[];
}

export function getNeighborhoodCache(
  entry: MemoryEntry,
): NeighborhoodCache | null {
  const meta = (entry.metadata || {}) as Record<string, unknown>;
  const cache = meta.neighborhood_cache;
  if (!cache || typeof cache !== "object") return null;
  const c = cache as Record<string, unknown>;
  if (typeof c.version !== "number" || !Array.isArray(c.entries)) return null;
  return cache as NeighborhoodCache;
}

export const relationshipTypes = [
  "causal",
  "supports",
  "contradicts",
  "temporal",
  "evolves",
  "blocks",
  "depends_on",
  "led_to",
  "related",
] as const;
export type RelationshipType = (typeof relationshipTypes)[number];

export const memoryLinks = pgTable(
  "memory_links",
  {
    id: serial("id").primaryKey(),
    fromId: integer("from_id")
      .notNull()
      .references(() => memoryEntries.id, { onDelete: "cascade" }),
    toId: integer("to_id")
      .notNull()
      .references(() => memoryEntries.id, { onDelete: "cascade" }),
    relationship: text("relationship").notNull(),
    relationshipType: text("relationship_type").notNull().default("related"),
    strength: real("strength").notNull().default(0.5),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 6 })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index("idx_memory_links_from").on(table.fromId),
    index("idx_memory_links_to").on(table.toId),
    index("idx_memory_links_relationship_type").on(table.relationshipType),
  ],
);

export const insertMemoryLinkSchema = createInsertSchema(memoryLinks).omit({
  id: true,
  createdAt: true,
});

export type MemoryLink = typeof memoryLinks.$inferSelect;
export type InsertMemoryLink = z.infer<typeof insertMemoryLinkSchema>;

export const memoryTransitions = pgTable(
  "memory_transitions",
  {
    id: serial("id").primaryKey(),
    entryId: integer("entry_id")
      .notNull()
      .references(() => memoryEntries.id, { onDelete: "cascade" }),
    fromLayer: text("from_layer").notNull(),
    toLayer: text("to_layer").notNull(),
    reason: text("reason").notNull().default(""),
    transitionedAt: timestamp("transitioned_at", {
      withTimezone: true,
      precision: 6,
    })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [index("idx_memory_transitions_entry").on(table.entryId)],
);

export const insertMemoryTransitionSchema = createInsertSchema(
  memoryTransitions,
).omit({
  id: true,
  transitionedAt: true,
});

export type MemoryTransition = typeof memoryTransitions.$inferSelect;
export type InsertMemoryTransition = z.infer<
  typeof insertMemoryTransitionSchema
>;

export const memoryContentBlocks = pgTable(
  "memory_content_blocks",
  {
    id: serial("id").primaryKey(),
    entryId: integer("entry_id")
      .notNull()
      .references(() => memoryEntries.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    role: text("role").notNull(),
    ordinal: integer("ordinal").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 6 })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [index("idx_content_blocks_entry").on(table.entryId)],
);

export const insertMemoryContentBlockSchema = createInsertSchema(
  memoryContentBlocks,
).omit({
  id: true,
  createdAt: true,
});

export type MemoryContentBlock = typeof memoryContentBlocks.$inferSelect;
export type InsertMemoryContentBlock = z.infer<
  typeof insertMemoryContentBlockSchema
>;

export const memoryEventTypes = [
  "created",
  "updated",
  "promoted",
  "graphed",
  "recalled",
  "merged",
  "concept_created",
  "summary_updated",
  "deleted",
  "reinforced",
  "decayed",
  "entity_linked",
  "layer_promoted",
  "claim_extracted",
] as const;
export type MemoryEventType = (typeof memoryEventTypes)[number];

export const memoryEvents = pgTable(
  "memory_events",
  {
    id: serial("id").primaryKey(),
    entryId: integer("entry_id")
      .notNull()
      .references(() => memoryEntries.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    details: jsonb("details").default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true, precision: 6 })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index("idx_memory_events_occurred").on(table.occurredAt),
    index("idx_memory_events_entry").on(table.entryId),
    index("idx_memory_events_type_occurred").on(
      table.eventType,
      table.occurredAt,
    ),
  ],
);

export const insertMemoryEventSchema = createInsertSchema(memoryEvents).omit({
  id: true,
  occurredAt: true,
});

export type MemoryEvent = typeof memoryEvents.$inferSelect;
export type InsertMemoryEvent = z.infer<typeof insertMemoryEventSchema>;

export interface SemanticSearchResult {
  entry: MemoryEntry;
  similarity: number;
}

export interface SimilarEntryResult {
  entry: MemoryEntry;
  embeddingSim: number;
  tagSim: number;
  titleSim: number;
  hybridScore: number;
}

export const memoryEntityLinkTypes = ["person", "project", "strategy", "goal"] as const;
export type MemoryEntityLinkType = (typeof memoryEntityLinkTypes)[number];

export const memoryEntityLinks = pgTable(
  "memory_entity_links",
  {
    id: serial("id").primaryKey(),
    memoryId: integer("memory_id")
      .notNull()
      .references(() => memoryEntries.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    scope: text("scope").notNull().default("user"),
    ownerUserId: text("owner_user_id"),
    accountId: text("account_id"),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 6 })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index("idx_mel_memory").on(table.memoryId),
    index("idx_mel_entity").on(table.entityType, table.entityId),
    index("idx_mel_scope_owner").on(table.scope, table.ownerUserId),
  ],
);

export const insertMemoryEntityLinkSchema = createInsertSchema(
  memoryEntityLinks,
).omit({
  id: true,
  createdAt: true,
});

export type MemoryEntityLink = typeof memoryEntityLinks.$inferSelect;
export type InsertMemoryEntityLink = z.infer<
  typeof insertMemoryEntityLinkSchema
>;

export const codeEmbeddings = pgTable(
  "code_embeddings",
  {
    id: serial("id").primaryKey(),
    symbolName: text("symbol_name").notNull(),
    symbolType: text("symbol_type").notNull(),
    filePath: text("file_path").notNull(),
    startLine: integer("start_line"),
    endLine: integer("end_line"),
    contentHash: text("content_hash").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    unique("uq_code_embed_type_name_path").on(
      table.symbolType,
      table.symbolName,
      table.filePath,
    ),
    index("idx_code_embed_file").on(table.filePath),
    index("idx_code_embed_type").on(table.symbolType),
  ],
);

export const insertCodeEmbeddingSchema = createInsertSchema(
  codeEmbeddings,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type CodeEmbedding = typeof codeEmbeddings.$inferSelect;
export type InsertCodeEmbedding = z.infer<typeof insertCodeEmbeddingSchema>;

// ─── vNext Source Queue ───────────────────────────────────────────────
// Debounce queue for source-watching extraction pipeline.
// Sources (sessions, library pages) are queued here on edit,
// settled after a configurable quiet period, then batch-extracted.

export const VNEXT_SOURCE_TYPES = ["session", "library_page"] as const;
export type VnextSourceType = (typeof VNEXT_SOURCE_TYPES)[number];

export const VNEXT_SOURCE_QUEUE_STATUSES = ["pending", "processing", "completed"] as const;
export type VnextSourceQueueStatus = (typeof VNEXT_SOURCE_QUEUE_STATUSES)[number];

export const memoryVnextSourceQueue = pgTable(
  "memory_vnext_source_queue",
  {
    id: serial("id").primaryKey(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    lastModifiedAt: timestamp("last_modified_at", {
      withTimezone: true,
      precision: 6,
    })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    status: text("status").notNull().default("pending"),
    lastExtractedAt: timestamp("last_extracted_at", {
      withTimezone: true,
      precision: 6,
    }),
    contentHash: text("content_hash"),
    ownerUserId: text("owner_user_id"),
    accountId: text("account_id"),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 6 })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    unique("uk_vnext_source_queue_type_id_owner").on(
      table.sourceType,
      table.sourceId,
      table.ownerUserId,
    ),
    index("idx_vnext_source_queue_status").on(table.status),
    index("idx_vnext_source_queue_pending_settle").on(
      table.status,
      table.lastModifiedAt,
    ),
    index("idx_vnext_source_queue_owner").on(table.ownerUserId),
  ],
);

export type MemoryVnextSourceQueueRow = typeof memoryVnextSourceQueue.$inferSelect;
