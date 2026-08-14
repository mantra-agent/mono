import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { vaults } from "./vaults";

export const platformStatusEnum = z.enum(["active", "paused", "archived"]);
export type PlatformStatus = z.infer<typeof platformStatusEnum>;

export const platforms = pgTable(
  "platforms",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    status: text("status").notNull().default("active"),
    /** Migration-compatible primary/default Vault. platform_vault_memberships owns Platform visibility. */
    vaultId: text("vault_id").notNull().references(() => vaults.id, { onDelete: "restrict" }),
    scope: text("scope").notNull().default("user"),
    ownerUserId: text("owner_user_id"),
    accountId: text("account_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  },
  (table) => [
    index("idx_platforms_scope_owner").on(table.scope, table.ownerUserId),
    index("idx_platforms_account").on(table.accountId),
    index("idx_platforms_vault").on(table.vaultId),
    index("idx_platforms_updated").on(table.updatedAt),
  ],
);

/** Canonical many-to-many Platform-to-Vault membership controlling owner visibility. */
export const platformVaultMemberships = pgTable(
  "platform_vault_memberships",
  {
    id: serial("id").primaryKey(),
    platformId: integer("platform_id")
      .notNull()
      .references(() => platforms.id, { onDelete: "cascade" }),
    vaultId: text("vault_id")
      .notNull()
      .references(() => vaults.id, { onDelete: "restrict" }),
    scope: text("scope").notNull().default("user"),
    ownerUserId: text("owner_user_id"),
    accountId: text("account_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  },
  (table) => [
    uniqueIndex("platform_vault_memberships_platform_vault_unique").on(table.platformId, table.vaultId),
    index("idx_platform_vault_memberships_platform").on(table.platformId),
    index("idx_platform_vault_memberships_vault_platform").on(table.vaultId, table.platformId),
    index("idx_platform_vault_memberships_scope_owner").on(table.scope, table.ownerUserId, table.accountId),
  ],
);

export type PlatformVaultMembership = typeof platformVaultMemberships.$inferSelect;

/** Product intent is independent from runtime Platforms. */
export const products = pgTable("products", {
  id: serial("id").primaryKey(), name: text("name").notNull(), description: text("description").notNull().default(""),
  status: text("status").notNull().default("active"),
  /** Product Vault placement. Null remains visible; a set Vault is live same-account ownership. */
  vaultId: text("vault_id").references(() => vaults.id, { onDelete: "restrict" }),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id"), accountId: text("account_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  uniqueIndex("products_account_name_unique").on(table.accountId, sql`lower(${table.name})`),
  index("idx_products_scope_owner").on(table.scope, table.ownerUserId, table.accountId),
  index("idx_products_vault").on(table.vaultId),
]);

export const productBacklogs = pgTable("product_backlogs", {
  id: serial("id").primaryKey(), productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [uniqueIndex("product_backlogs_product_unique").on(table.productId)]);

export const productPlatformAssociations = pgTable("product_platform_associations", {
  id: serial("id").primaryKey(), productId: integer("product_id").notNull().references(() => products.id, { onDelete: "restrict" }),
  platformId: integer("platform_id").notNull().references(() => platforms.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [uniqueIndex("product_platform_associations_unique").on(table.productId, table.platformId)]);

export const featureRequests = pgTable("feature_requests", {
  id: serial("id").primaryKey(), backlogId: integer("backlog_id").notNull().references(() => productBacklogs.id, { onDelete: "cascade" }),
  title: text("title").notNull(), description: text("description").notNull().default(""), status: text("status").notNull().default("backlog"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [index("idx_feature_requests_backlog_status").on(table.backlogId, table.status)]);

export const PRODUCT_CONTEXT_KINDS = [
  "coding_process",
  "design_system",
  "planning_process",
  "product_definition",
  "library_process",
] as const;

export const productContextKindSchema = z.enum(PRODUCT_CONTEXT_KINDS);

/** Product-owned context. Library pages stay content authority; this is the typed selection edge. */
export const productContextArtifacts = pgTable("product_context_artifacts", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  libraryPageId: text("library_page_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  uniqueIndex("product_context_artifacts_unique").on(table.productId, table.kind, table.libraryPageId),
  index("idx_product_context_artifacts_product_kind").on(table.productId, table.kind),
]);

export const insertProductContextSchema = z.object({
  kind: productContextKindSchema,
  libraryPageId: z.string().trim().min(1),
});

export const platformProducts = pgTable(
  "platform_products",
  {
    id: serial("id").primaryKey(),
    platformId: integer("platform_id").notNull().references(() => platforms.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  },
  (table) => [
    index("idx_platform_products_platform").on(table.platformId),
    index("idx_platform_products_updated").on(table.updatedAt),
  ],
);


export const platformProductEnvironments = pgTable(
  "platform_product_environments",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id").notNull().references(() => platformProducts.id, { onDelete: "cascade" }),
    /** Denormalized Platform owner. Nullable during the dual-table freeze; backfilled from platform_products. */
    platformId: integer("platform_id").references(() => platforms.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  },
  (table) => [
    index("idx_platform_product_environments_product").on(table.productId),
    index("idx_platform_product_environments_platform").on(table.platformId),
    index("idx_platform_product_environments_updated").on(table.updatedAt),
  ],
);



export const environmentBuildLifecycleConfigs = pgTable(
  "environment_build_lifecycle_configs",
  {
    id: serial("id").primaryKey(),
    environmentId: integer("environment_id").notNull().references(() => platformProductEnvironments.id, { onDelete: "cascade" }),
    workflowTemplateId: text("workflow_template_id").notNull().default("build-v1"),
    providerKind: text("provider_kind").notNull().default("railway"),
    deployPolicy: jsonb("deploy_policy").notNull().default(sql`'{"mode":"manual"}'::jsonb`),
    acceptanceTarget: jsonb("acceptance_target").notNull().default(sql`'{}'::jsonb`),
    authMode: text("auth_mode").notNull().default("none"),
    retryPolicy: jsonb("retry_policy").notNull().default(sql`'{"maxAttempts":3}'::jsonb`),
    gatePolicy: jsonb("gate_policy").notNull().default(sql`'{}'::jsonb`),
    evidenceConfig: jsonb("evidence_config").notNull().default(sql`'{}'::jsonb`),
    docsConfig: jsonb("docs_config").notNull().default(sql`'{}'::jsonb`),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_environment_build_lifecycle_configs_environment").on(table.environmentId),
    index("idx_environment_build_lifecycle_configs_template").on(table.workflowTemplateId),
    uniqueIndex("idx_environment_build_lifecycle_configs_one_enabled").on(table.environmentId).where(sql`${table.enabled} = true`),
  ],
);

export const environmentPromotionReleases = pgTable(
  "environment_promotion_releases",
  {
    id: serial("id").primaryKey(),
    environmentId: integer("environment_id").notNull().references(() => platformProductEnvironments.id, { onDelete: "cascade" }),
    publishRunId: text("publish_run_id").notNull(),
    version: text("version").notNull(),
    incrementKind: text("increment_kind").notNull(),
    promotedCommitSha: text("promoted_commit_sha").notNull(),
    releaseNotes: jsonb("release_notes").notNull().default(sql`'{"newFeatures":[],"improvements":[],"fixes":[]}'::jsonb`),
    deploymentId: text("deployment_id"),
    promotedByUserId: text("promoted_by_user_id"),
    promotedAt: timestamp("promoted_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  },
  (table) => [
    uniqueIndex("idx_environment_promotion_releases_run").on(table.publishRunId),
    uniqueIndex("idx_environment_promotion_releases_version").on(table.environmentId, table.version),
    index("idx_environment_promotion_releases_environment_time").on(table.environmentId, table.promotedAt),
  ],
);

export type EnvironmentPromotionRelease = typeof environmentPromotionReleases.$inferSelect;

export const providerConnections = pgTable(
  "provider_connections",
  {
    id: serial("id").primaryKey(),
    provider: text("provider").notNull(),
    label: text("label").notNull(),
    accountType: text("account_type").notNull().default("legacy"),
    credentialRef: text("credential_ref"),
    credentialEnvelope: jsonb("credential_envelope"),
    credentialLast4: text("credential_last4").notNull().default(""),
    status: text("status").notNull().default("active"),
    connectorKind: text("connector_kind").notNull().default("integration"),
    connectorConfig: jsonb("connector_config").notNull().default({}),
    sortOrder: integer("sort_order").notNull().default(0),
    /** When true, this connector stays ahead of unpinned peers regardless of relative sortOrder. */
    priorityPinned: boolean("priority_pinned").notNull().default(false),
    scope: text("scope").notNull().default("user"),
    ownerUserId: text("owner_user_id"),
    accountId: text("account_id"),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  },
  (table) => [
    index("idx_provider_connections_provider").on(table.provider),
    index("idx_provider_connections_kind_order").on(table.connectorKind, table.sortOrder),
    index("idx_provider_connections_scope_owner").on(table.scope, table.ownerUserId),
  ],
);

export const environmentSourceBindings = pgTable(
  "environment_source_bindings",
  {
    id: serial("id").primaryKey(),
    environmentId: integer("environment_id").notNull().references(() => platformProductEnvironments.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("github"),
    connectionId: integer("connection_id").references(() => providerConnections.id, { onDelete: "set null" }),
    owner: text("owner").notNull().default(""),
    repo: text("repo").notNull().default(""),
    branch: text("branch").notNull().default(""),
    autoDeploy: boolean("auto_deploy").notNull().default(false),
    codeIndexingEnabled: boolean("code_indexing_enabled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  },
  (table) => [
    index("idx_environment_source_bindings_environment").on(table.environmentId),
    index("idx_environment_source_bindings_connection").on(table.connectionId),
  ],
);

export const environmentHostingBindings = pgTable(
  "environment_hosting_bindings",
  {
    id: serial("id").primaryKey(),
    environmentId: integer("environment_id").notNull().references(() => platformProductEnvironments.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("railway"),
    connectionId: integer("connection_id").references(() => providerConnections.id, { onDelete: "set null" }),
    projectId: text("project_id").notNull().default(""),
    projectName: text("project_name").notNull().default(""),
    providerEnvironmentId: text("provider_environment_id").notNull().default(""),
    providerEnvironmentName: text("provider_environment_name").notNull().default(""),
    serviceId: text("service_id").notNull().default(""),
    serviceName: text("service_name").notNull().default(""),
    publicUrl: text("public_url").notNull().default(""),
    staticUrl: text("static_url").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  },
  (table) => [
    uniqueIndex("idx_environment_hosting_bindings_environment_unique").on(table.environmentId),
    index("idx_environment_hosting_bindings_connection").on(table.connectionId),
  ],
);

export const environmentRuntimeVariables = pgTable(
  "environment_runtime_variables",
  {
    id: serial("id").primaryKey(),
    environmentId: integer("environment_id").notNull().references(() => platformProductEnvironments.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    category: text("category").notNull().default("runtime"),
    required: boolean("required").notNull().default(false),
    source: text("source").notNull().default("manual"),
    configured: boolean("configured").notNull().default(false),
    secretRef: text("secret_ref"),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  },
  (table) => [
    index("idx_environment_runtime_variables_environment").on(table.environmentId),
    index("idx_environment_runtime_variables_key").on(table.key),
  ],
);

export const insertPlatformSchema = createInsertSchema(platforms)
  .omit({
    id: true,
    vaultId: true,
    scope: true,
    ownerUserId: true,
    accountId: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    name: z.string().trim().min(1, "Platform name is required"),
    description: z.string().optional().default(""),
    status: platformStatusEnum.optional().default("active"),
    vaultId: z.string().trim().min(1).optional(),
  });

export const insertPlatformProductSchema = createInsertSchema(platformProducts)
  .omit({ id: true, platformId: true, createdAt: true, updatedAt: true })
  .extend({
    name: z.string().trim().min(1, "Product name is required"),
    description: z.string().optional().default(""),
    status: platformStatusEnum.optional().default("active"),
  });

export const insertProductSchema = createInsertSchema(products)
  .omit({ id: true, scope: true, ownerUserId: true, accountId: true, createdAt: true, updatedAt: true })
  .extend({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).optional().default(""),
    status: platformStatusEnum.optional().default("active"),
    vaultId: z.string().trim().min(1).nullable().optional(),
    platformIds: z.array(z.number().int().positive()).optional().default([]),
  });

export const insertFeatureRequestSchema = createInsertSchema(featureRequests)
  .omit({ id: true, backlogId: true, createdAt: true, updatedAt: true })
  .extend({ title: z.string().trim().min(1).max(300), description: z.string().trim().max(5000).optional().default(""), status: z.enum(["backlog", "planned", "completed"]).optional().default("backlog") });

export const insertPlatformProductEnvironmentSchema = createInsertSchema(platformProductEnvironments)
  .omit({ id: true, productId: true, platformId: true, createdAt: true, updatedAt: true })
  .extend({
    name: z.string().trim().min(1, "Environment name is required"),
  });

export type Platform = typeof platforms.$inferSelect;
export type InsertPlatform = z.infer<typeof insertPlatformSchema>;
export type PlatformProduct = typeof platformProducts.$inferSelect;
export type InsertPlatformProduct = z.infer<typeof insertPlatformProductSchema>;
export type Product = typeof products.$inferSelect;
export type InsertProduct = z.infer<typeof insertProductSchema>;
export type ProductBacklog = typeof productBacklogs.$inferSelect;
export type FeatureRequest = typeof featureRequests.$inferSelect;
export type ProductContextArtifact = typeof productContextArtifacts.$inferSelect;
export type InsertProductContext = z.infer<typeof insertProductContextSchema>;
export type ProductContextKind = z.infer<typeof productContextKindSchema>;
export type PlatformProductEnvironment = typeof platformProductEnvironments.$inferSelect;
export type InsertPlatformProductEnvironment = z.infer<typeof insertPlatformProductEnvironmentSchema>;

export const lifecycleProviderKindSchema = z.enum(["railway", "eas", "cloudflare", "cloudflare_pages", "manual"]);
export const lifecycleAuthModeSchema = z.enum(["none", "provider_connection", "platform_binding", "custom"]);
export const lifecycleRuntimeModeSchema = z.enum(["immutable_artifact", "warm_workspace"]);
export const lifecycleDependencyPolicySchema = z.enum(["rebuild_on_lockfile_change"]);
export const lifecycleDeployPolicySchema = z.object({
  mode: z.enum(["automatic", "manual", "disabled", "unknown", "auto_on_push", "manual_promote"]).default("manual"),
  sourceBranch: z.string().trim().optional(),
  targetBranch: z.string().trim().optional().nullable(),
  requireApproval: z.boolean().optional(),
  runtimeMode: lifecycleRuntimeModeSchema.optional(),
  syncOnPush: z.boolean().optional(),
  dependencyPolicy: lifecycleDependencyPolicySchema.optional(),
  fullRebuildProvider: lifecycleProviderKindSchema.optional(),
  requireProductionBuild: z.boolean().optional(),
  requireHumanPromotion: z.boolean().optional(),
}).passthrough();
export const lifecycleAcceptanceTargetSchema = z.object({
  url: z.string().trim().optional().nullable(),
  routePath: z.string().trim().optional().nullable(),
  healthCheckPath: z.string().trim().optional().nullable(),
  screenshotRoutePath: z.string().trim().optional().nullable(),
}).passthrough();
export const lifecycleRetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(20).default(3),
  backoffSeconds: z.number().int().min(0).max(3600).optional(),
}).passthrough();
export const lifecycleGatePolicySchema = z.object({
  requireHumanApproval: z.boolean().optional(),
  requiredGates: z.array(z.string()).optional(),
}).passthrough();
export const lifecycleEvidenceConfigSchema = z.object({
  requireScreenshot: z.boolean().optional(),
  requireLogs: z.boolean().optional(),
  requireProviderStatus: z.boolean().optional(),
}).passthrough();
export const lifecycleDocsConfigSchema = z.object({
  updateWorkflowPage: z.boolean().optional(),
  artifactPageId: z.string().trim().optional().nullable(),
  versionDocument: z.object({
    enabled: z.boolean(),
    path: z.literal("VERSION.md"),
  }).optional(),
}).passthrough();

export const upsertBuildLifecycleConfigSchema = z.object({
  workflowTemplateId: z.string().trim().min(1).optional().default("build-v1"),
  providerKind: lifecycleProviderKindSchema.optional().default("railway"),
  deployPolicy: lifecycleDeployPolicySchema.optional().default({ mode: "manual" }),
  acceptanceTarget: lifecycleAcceptanceTargetSchema.optional().default({}),
  authMode: lifecycleAuthModeSchema.optional().default("none"),
  retryPolicy: lifecycleRetryPolicySchema.optional().default({ maxAttempts: 3 }),
  gatePolicy: lifecycleGatePolicySchema.optional().default({}),
  evidenceConfig: lifecycleEvidenceConfigSchema.optional().default({}),
  docsConfig: lifecycleDocsConfigSchema.optional().default({}),
  enabled: z.boolean().optional().default(true),
});

export const patchBuildLifecycleConfigSchema = upsertBuildLifecycleConfigSchema.partial();

export type EnvironmentBuildLifecycleConfig = typeof environmentBuildLifecycleConfigs.$inferSelect;
export type UpsertBuildLifecycleConfig = z.infer<typeof upsertBuildLifecycleConfigSchema>;
export type PatchBuildLifecycleConfig = z.infer<typeof patchBuildLifecycleConfigSchema>;

export const insertProviderConnectionSchema = createInsertSchema(providerConnections)
  .omit({ id: true, scope: true, ownerUserId: true, accountId: true, createdAt: true, updatedAt: true })
  .extend({
    provider: z.string().trim().min(1),
    label: z.string().trim().min(1),
    accountType: z.string().trim().min(1).optional().default("legacy"),
    credentialRef: z.string().optional().nullable(),
    status: platformStatusEnum.optional().default("active"),
    connectorKind: z.enum(["integration", "model"]).optional().default("integration"),
    connectorConfig: z.record(z.unknown()).optional().default({}),
    sortOrder: z.number().int().nonnegative().optional().default(0),
  });

export type ProviderConnection = typeof providerConnections.$inferSelect;
export type InsertProviderConnection = z.infer<typeof insertProviderConnectionSchema>;

export const upsertSourceBindingSchema = z.object({
  connectionId: z.number().int().positive().nullable().optional(),
  owner: z.string().trim().optional(),
  repo: z.string().trim().optional(),
  branch: z.string().trim().optional(),
  autoDeploy: z.boolean().optional(),
  codeIndexingEnabled: z.boolean().optional(),
});
export type UpsertSourceBinding = z.infer<typeof upsertSourceBindingSchema>;

export const upsertHostingBindingSchema = z.object({
  connectionId: z.number().int().positive().nullable().optional(),
  projectId: z.string().trim().optional(),
  projectName: z.string().trim().optional(),
  providerEnvironmentId: z.string().trim().optional(),
  providerEnvironmentName: z.string().trim().optional(),
  serviceId: z.string().trim().optional(),
  serviceName: z.string().trim().optional(),
  publicUrl: z.string().trim().optional(),
  staticUrl: z.string().trim().optional(),
});
export type UpsertHostingBinding = z.infer<typeof upsertHostingBindingSchema>;

export type EnvironmentSourceBinding = typeof environmentSourceBindings.$inferSelect;
export type EnvironmentHostingBinding = typeof environmentHostingBindings.$inferSelect;
export type EnvironmentRuntimeVariable = typeof environmentRuntimeVariables.$inferSelect;

// ---------------------------------------------------------------------------
// Capability bindings — provider-specific service bindings (e.g. R2, Pages)
// ---------------------------------------------------------------------------

export const capabilityTypeEnum = z.enum(["object_storage", "hosting", "speech_recognition"]);
export type CapabilityType = z.infer<typeof capabilityTypeEnum>;

export const speechRecognitionAdapterKindSchema = z.enum([
  "elevenlabs-scribe-realtime",
  "deepgram-realtime",
  "speechmatics-realtime",
]);
export type SpeechRecognitionAdapterKind = z.infer<typeof speechRecognitionAdapterKindSchema>;

export const speechRecognitionUseCaseSchema = z.enum([
  "meeting_participant_stream",
  "meeting_shared_room",
]);
export type SpeechRecognitionUseCase = z.infer<typeof speechRecognitionUseCaseSchema>;

const speechRecognitionUseCasesSchema = z
  .array(speechRecognitionUseCaseSchema)
  .min(1)
  .max(2)
  .refine((values) => new Set(values).size === values.length, "Speech recognition use cases must be unique");

export const elevenLabsScribeRealtimeConfigSchema = z.object({
  version: z.literal(1),
  adapterKind: z.literal("elevenlabs-scribe-realtime"),
  useCases: speechRecognitionUseCasesSchema,
  model: z.literal("scribe_v2_realtime").default("scribe_v2_realtime"),
  languageCode: z.literal("en").default("en"),
  vadSilenceThresholdSecs: z.number().min(0.1).max(3).default(1),
  vadThreshold: z.number().min(0).max(1).default(0.4),
  minSpeechDurationMs: z.number().int().min(50).max(2_000).default(100),
  minSilenceDurationMs: z.number().int().min(50).max(2_000).default(100),
}).strict();

export const deepgramRealtimeConfigSchema = z.object({
  version: z.literal(1),
  adapterKind: z.literal("deepgram-realtime"),
  useCases: speechRecognitionUseCasesSchema,
  model: z.literal("nova-3").default("nova-3"),
  language: z.literal("en-US").default("en-US"),
  diarizeModel: z.literal("latest").default("latest"),
  endpointingMs: z.number().int().min(50).max(5_000).default(400),
}).strict();

export const speechmaticsRealtimeConfigSchema = z.object({
  version: z.literal(1),
  adapterKind: z.literal("speechmatics-realtime"),
  useCases: speechRecognitionUseCasesSchema,
  model: z.literal("enhanced").default("enhanced"),
  language: z.literal("en").default("en"),
  region: z.enum(["us", "eu", "global"]).default("us"),
  speakerSensitivity: z.number().min(0).max(1).default(0.5),
  preferCurrentSpeaker: z.boolean().default(true),
  maxSpeakers: z.number().int().min(2).max(50).default(8),
}).strict();

export const speechRecognitionBindingConfigSchema = z.discriminatedUnion("adapterKind", [
  elevenLabsScribeRealtimeConfigSchema,
  deepgramRealtimeConfigSchema,
  speechmaticsRealtimeConfigSchema,
]);
export type SpeechRecognitionBindingConfig = z.infer<typeof speechRecognitionBindingConfigSchema>;

export const upsertSpeechRecognitionBindingSchema = z.object({
  connectionId: z.number().int().positive(),
  provider: z.enum(["elevenlabs", "deepgram", "speechmatics"]),
  config: speechRecognitionBindingConfigSchema,
  enabled: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(1_000).default(0),
}).strict().superRefine((value, context) => {
  const expectedProvider: Record<SpeechRecognitionAdapterKind, typeof value.provider> = {
    "elevenlabs-scribe-realtime": "elevenlabs",
    "deepgram-realtime": "deepgram",
    "speechmatics-realtime": "speechmatics",
  };
  if (expectedProvider[value.config.adapterKind] !== value.provider) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["provider"],
      message: `Provider ${value.provider} does not match adapter ${value.config.adapterKind}`,
    });
  }
});
export type UpsertSpeechRecognitionBinding = z.infer<typeof upsertSpeechRecognitionBindingSchema>;

export const environmentCapabilityBindings = pgTable(
  "environment_capability_bindings",
  {
    id: serial("id").primaryKey(),
    environmentId: integer("environment_id").notNull().references(() => platformProductEnvironments.id, { onDelete: "cascade" }),
    connectionId: integer("connection_id").references(() => providerConnections.id, { onDelete: "set null" }),
    capabilityType: text("capability_type").notNull(),
    provider: text("provider").notNull(),
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
    /** Encrypted envelope for capability-specific secrets (e.g. R2 S3 access keys) */
    secretEnvelope: jsonb("secret_envelope"),
    secretLast4: text("secret_last4").notNull().default(""),
    enabled: boolean("enabled").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  },
  (table) => [
    index("idx_env_capability_bindings_environment").on(table.environmentId),
    index("idx_env_capability_bindings_connection").on(table.connectionId),
    index("idx_env_capability_bindings_type").on(table.capabilityType),
    uniqueIndex("idx_env_capability_bindings_env_type_provider").on(table.environmentId, table.capabilityType, table.provider),
  ],
);

export const upsertCapabilityBindingSchema = z.object({
  connectionId: z.number().int().positive().nullable().optional(),
  capabilityType: capabilityTypeEnum,
  provider: z.string().trim().min(1),
  config: z.record(z.unknown()).optional().default({}),
  enabled: z.boolean().optional().default(true),
});

export type EnvironmentCapabilityBinding = typeof environmentCapabilityBindings.$inferSelect;
export type UpsertCapabilityBinding = z.infer<typeof upsertCapabilityBindingSchema>;

// ---------------------------------------------------------------------------
// Context artifacts — Library pages linked to environments for context assembly
// ---------------------------------------------------------------------------

export const environmentContextArtifacts = pgTable(
  "environment_context_artifacts",
  {
    id: serial("id").primaryKey(),
    environmentId: integer("environment_id").notNull().references(() => platformProductEnvironments.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    libraryPageId: text("library_page_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  },
  (table) => [
    index("idx_environment_context_artifacts_environment").on(table.environmentId),
    index("idx_environment_context_artifacts_kind").on(table.kind),
    index("idx_environment_context_artifacts_env_kind").on(table.environmentId, table.kind),
  ],
);

export const upsertContextArtifactSchema = z.object({
  kind: z.string().trim().min(1, "Artifact kind is required"),
  libraryPageId: z.string().min(1, "Library page ID is required"),
});

export type EnvironmentContextArtifact = typeof environmentContextArtifacts.$inferSelect;
export type UpsertContextArtifact = z.infer<typeof upsertContextArtifactSchema>;
