import { sql } from "drizzle-orm";
import { pgTable, text, varchar, serial, integer, real, boolean, timestamp, jsonb, unique, index, uniqueIndex, primaryKey, uuid, check } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { libraryPages } from "./models/info";
import { vaults } from "./models/vaults";
import { businesses } from "./models/businesses";
import { DEFAULT_AGENT_NAME } from "./instance-config";
import { PLAN_REVIEW_DECISIONS } from "./plan-review";

export * from "./models/chat";
export * from "./models/goals";
export * from "./models/tags";
export * from "./models/memory";
export * from "./models/strategy";
export * from "./models/thesis";
export * from "./models/skills";
export * from "./models/prompt-modules";
export * from "./models/thought";
export * from "./models/finance";
export * from "./models/business-plans";
export * from "./models/businesses";
export * from "./models/health";
export * from "./models/info";
export * from "./models/captures";
export * from "./models/content";
export * from "./models/events";
export * from "./models/cognition";
export * from "./models/indexed-content";
export * from "./models/compaction";
export * from "./models/export";
export * from "./models/media";
export * from "./models/documents";
export * from "./models/exec";
export * from "./models/signal";
export * from "./models/opportunities";
export * from "./models/magic-demo";
export * from "./models/platforms";
export * from "./models/vaults";
export * from "./models/communications";
export * from "./models/browser-telemetry";
export * from "./models/job-roles";
export * from "./models/agendas";
export * from "./models/meeting-audio";
export * from "./models/life-addressing";
export * from "./models/mods";
export * from "./models/build-deployments";
export * from "./models/tag-tables";
export * from "./models/runtime";
export * from "./models/outbox";
export * from "./models/metrics";


export const toolOutputAdmissions = pgTable("tool_output_admissions", {
  id: serial("id").primaryKey(),
  ownerAccountId: varchar("owner_account_id").notNull(),
  ownerUserId: varchar("owner_user_id").notNull(),
  sessionId: varchar("session_id"),
  runId: varchar("run_id"),
  toolCallId: varchar("tool_call_id"),
  toolName: varchar("tool_name").notNull(),
  action: varchar("action").notNull().default(""),
  disposition: varchar("disposition").notNull(),
  rawChars: integer("raw_chars").notNull(),
  rawTokens: integer("raw_tokens").notNull(),
  injectedChars: integer("injected_chars").notNull(),
  injectedTokens: integer("injected_tokens").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  ownerTimeIdx: index("tool_output_admissions_owner_time_idx").on(table.ownerAccountId, table.ownerUserId, table.createdAt),
  ownerToolIdx: index("tool_output_admissions_owner_tool_idx").on(table.ownerAccountId, table.ownerUserId, table.toolName, table.action),
  ownerRunIdx: index("tool_output_admissions_owner_run_idx").on(table.ownerAccountId, table.ownerUserId, table.runId),
}));

export const mobileStartupTelemetry = pgTable("mobile_startup_telemetry", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull(),
  phase: text("phase"),
  mobileSessionId: text("mobile_session_id").notNull(),
  deviceId: text("device_id").notNull(),
  platform: text("platform"),
  osVersion: text("os_version"),
  deviceModel: text("device_model"),
  appVersion: text("app_version"),
  nativeBuildVersion: text("native_build_version"),
  runtimeVersion: text("runtime_version"),
  updateId: text("update_id"),
  updateGroupId: text("update_group_id"),
  bundleIdentifier: text("bundle_identifier"),
  easBuildId: text("eas_build_id"),
  buildProfile: text("build_profile"),
  gitSha: text("git_sha"),
  sourceRef: text("source_ref"),
  isFatal: boolean("is_fatal").notNull().default(false),
  errorName: text("error_name"),
  errorMessage: text("error_message"),
  errorStack: text("error_stack"),
  payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => ({
  receivedAtIdx: index("idx_mobile_startup_telemetry_received_at").on(table.receivedAt),
  buildIdx: index("idx_mobile_startup_telemetry_build").on(table.gitSha, table.nativeBuildVersion, table.receivedAt),
  sessionIdx: index("idx_mobile_startup_telemetry_session").on(table.mobileSessionId, table.occurredAt),
  deviceIdx: index("idx_mobile_startup_telemetry_device").on(table.deviceId, table.receivedAt),
}));

export type MobileStartupTelemetry = typeof mobileStartupTelemetry.$inferSelect;
export type InsertMobileStartupTelemetry = typeof mobileStartupTelemetry.$inferInsert;

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull().unique(),
  password: text("password").notNull(),
  role: text("role").notNull().default("user"),
  inviteToken: text("invite_token"),
  inviteExpires: timestamp("invite_expires", { withTimezone: true }),
  resetToken: text("reset_token"),
  resetExpires: timestamp("reset_expires", { withTimezone: true }),
  activeVaultId: text("active_vault_id"),
  visibleVaultIds: text("visible_vault_ids")
    .array()
    .default(sql`'{}'::text[]`),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  passwordSignupAt: timestamp("password_signup_at", { withTimezone: true }),
});

// Global pre-account security subjects. These rows carry no credentials,
// profile, account, Vault, or private relationship data.
export const invitedSubjects = pgTable("invited_subjects", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  normalizedEmail: text("normalized_email").notNull(),
  displayLabel: text("display_label").notNull(),
  createdByUserId: varchar("created_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  claimedByUserId: varchar("claimed_by_user_id").references(() => users.id, { onDelete: "restrict" }),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("idx_invited_subjects_normalized_email_unique").on(table.normalizedEmail),
  index("idx_invited_subjects_claimed_user").on(table.claimedByUserId),
  check("invited_subjects_email_normalized_check", sql`${table.normalizedEmail} = LOWER(BTRIM(${table.normalizedEmail})) AND NULLIF(BTRIM(${table.normalizedEmail}), '') IS NOT NULL`),
  check("invited_subjects_claim_pair_check", sql`(${table.claimedByUserId} IS NULL AND ${table.claimedAt} IS NULL) OR (${table.claimedByUserId} IS NOT NULL AND ${table.claimedAt} IS NOT NULL)`),
]);

export type InvitedSubject = typeof invitedSubjects.$inferSelect;
export type InsertInvitedSubject = typeof invitedSubjects.$inferInsert;

export const accounts = pgTable("accounts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  kind: text("kind").notNull().default("personal"),
  name: text("name").notNull(),
  ownerUserId: varchar("owner_user_id").references(() => users.id, { onDelete: "set null" }),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => ({
  kindIdx: index("idx_accounts_kind").on(table.kind),
  ownerIdx: index("idx_accounts_owner_user").on(table.ownerUserId),
  kindOwnerUnique: uniqueIndex("idx_accounts_kind_owner_unique").on(table.kind, table.ownerUserId),
}));

export const memberships = pgTable("memberships", {
  id: serial("id").primaryKey(),
  accountId: varchar("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("member"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => ({
  accountUserUnique: uniqueIndex("idx_memberships_account_user_unique").on(table.accountId, table.userId),
  userIdx: index("idx_memberships_user").on(table.userId),
  accountIdx: index("idx_memberships_account").on(table.accountId),
}));

export const userPermissions = pgTable("user_permissions", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  permission: text("permission").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => ({
  userPermissionUnique: uniqueIndex("idx_user_permissions_user_permission_unique").on(table.userId, table.permission),
  userIdx: index("idx_user_permissions_user").on(table.userId),
}));

export type UserPermission = typeof userPermissions.$inferSelect;
export type InsertUserPermission = typeof userPermissions.$inferInsert;

export const userProfiles = pgTable("user_profiles", {
  userId: varchar("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  accountId: varchar("account_id").references(() => accounts.id, { onDelete: "set null" }),
  displayName: text("display_name"),
  preferredName: text("preferred_name"),
  timezone: text("timezone").notNull().default("America/Chicago"),
  onboardingStatus: text("onboarding_status").notNull().default("not_started"),
  memoryConsent: boolean("memory_consent").notNull().default(false),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => ({
  accountIdx: index("idx_user_profiles_account").on(table.accountId),
}));

/**
 * Agent Instance is the mind / continuity boundary.
 * Account owns billing and which Instances exist; Instance owns memory/timers/skills (later phases).
 * One Instance belongs to exactly one Account.
 */
export const agentInstances = pgTable("agent_instances", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  accountId: varchar("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  createdByUserId: varchar("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  status: text("status").notNull().default("active"),
  quarantineReason: text("quarantine_reason"),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => ({
  accountIdx: index("idx_agent_instances_account").on(table.accountId),
  createdByIdx: index("idx_agent_instances_created_by").on(table.createdByUserId),
}));

/**
 * Instance membership: Manager | Participant.
 * UNIQUE(account_id, user_id) encodes one User pin per Account.
 */
export const agentInstanceMemberships = pgTable("agent_instance_memberships", {
  id: serial("id").primaryKey(),
  instanceId: varchar("instance_id").notNull().references(() => agentInstances.id, { onDelete: "cascade" }),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  accountId: varchar("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("participant"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => ({
  accountUserUnique: uniqueIndex("idx_agent_instance_memberships_account_user_unique").on(table.accountId, table.userId),
  instanceUserUnique: uniqueIndex("idx_agent_instance_memberships_instance_user_unique").on(table.instanceId, table.userId),
  userIdx: index("idx_agent_instance_memberships_user").on(table.userId),
  instanceIdx: index("idx_agent_instance_memberships_instance").on(table.instanceId),
}));

export const agentProfiles = pgTable("agent_profiles", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  /** created_by / rolling-deploy dual-write key; ownership moves to instanceId. */
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  accountId: varchar("account_id").references(() => accounts.id, { onDelete: "cascade" }),
  /** Owning Agent Instance. Unique when set; user_id remains compatibility dual-write. */
  instanceId: varchar("instance_id").references(() => agentInstances.id, { onDelete: "set null" }),
  agentName: text("agent_name").notNull().default(DEFAULT_AGENT_NAME),
  relationshipState: jsonb("relationship_state").notNull().default(sql`'{}'::jsonb`),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => ({
  userUnique: uniqueIndex("idx_agent_profiles_user_unique").on(table.userId),
  accountIdx: index("idx_agent_profiles_account").on(table.accountId),
  instanceIdx: index("idx_agent_profiles_instance").on(table.instanceId),
  // Partial unique: one profile per Instance when linked; nulls allowed during dual-write.
  instanceUnique: uniqueIndex("idx_agent_profiles_instance_unique")
    .on(table.instanceId)
    .where(sql`${table.instanceId} IS NOT NULL`),
}));

export const privilegedAccessAudit = pgTable("privileged_access_audit", {
  id: serial("id").primaryKey(),
  actorType: text("actor_type").notNull(),
  actorUserId: varchar("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  actorAccountId: varchar("actor_account_id").references(() => accounts.id, { onDelete: "set null" }),
  impersonatedUserId: varchar("impersonated_user_id").references(() => users.id, { onDelete: "set null" }),
  impersonatedAccountId: varchar("impersonated_account_id").references(() => accounts.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  reason: text("reason"),
  scopes: jsonb("scopes").notNull().default(sql`'[]'::jsonb`),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => ({
  actorIdx: index("idx_privileged_access_actor").on(table.actorType, table.actorUserId, table.createdAt),
  impersonatedIdx: index("idx_privileged_access_impersonated").on(table.impersonatedUserId, table.createdAt),
}));

export type Account = typeof accounts.$inferSelect;
export type InsertAccount = typeof accounts.$inferInsert;
export type Membership = typeof memberships.$inferSelect;
export type InsertMembership = typeof memberships.$inferInsert;
export type UserProfile = typeof userProfiles.$inferSelect;
export type InsertUserProfile = typeof userProfiles.$inferInsert;
export type AgentInstance = typeof agentInstances.$inferSelect;
export type InsertAgentInstance = typeof agentInstances.$inferInsert;
export type AgentInstanceMembership = typeof agentInstanceMemberships.$inferSelect;
export type InsertAgentInstanceMembership = typeof agentInstanceMemberships.$inferInsert;
export type AgentProfile = typeof agentProfiles.$inferSelect;
export type InsertAgentProfile = typeof agentProfiles.$inferInsert;
export type PrivilegedAccessAudit = typeof privilegedAccessAudit.$inferSelect;
export type InsertPrivilegedAccessAudit = typeof privilegedAccessAudit.$inferInsert;

export const insertUserSchema = createInsertSchema(users).pick({
  email: true,
  password: true,
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).max(120),
  inviteToken: z.string().optional(),
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;



export const gatewayStatusSchema = z.object({
  status: z.enum(["running", "stopped", "starting", "restarting", "error", "not_installed"]),
  pid: z.number().optional(),
  port: z.number().optional(),
  uptime: z.number().optional(),
  version: z.string().optional(),
  error: z.string().optional(),
  manuallyStopped: z.boolean().optional(),
  activeRuns: z.number().optional(),
  chatActiveRuns: z.number().optional(),
});

export type GatewayStatus = z.infer<typeof gatewayStatusSchema>;
export type AgentStatus = GatewayStatus;

export const workspaceFileSchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(["file", "directory"]),
  size: z.number().optional(),
  modified: z.string().optional(),
  content: z.string().optional(),
});

export type WorkspaceFile = z.infer<typeof workspaceFileSchema>;

export const sessionSchema = z.object({
  id: z.string(),
  name: z.string(),
  startedAt: z.string(),
  messageCount: z.number(),
  lastMessage: z.string().optional(),
});

export type Session = z.infer<typeof sessionSchema>;

export const sessionMessageSchema = z.object({
  role: z.string(),
  content: z.string(),
  timestamp: z.string().optional(),
  type: z.string().optional(),
});

export type SessionMessage = z.infer<typeof sessionMessageSchema>;

export const issueStatusEnum = z.enum(["open", "in_progress", "in_review", "resolved"]);
export type IssueStatus = z.infer<typeof issueStatusEnum>;
export const issueKindEnum = z.enum(["tracked", "reported"]);
export type IssueKind = z.infer<typeof issueKindEnum>;

export interface IssueNote {
  id: string;
  author: "user" | "agent";
  content: string;
  timestamp: string;
  attachments?: { name: string; url: string }[];
  statusChange?: { from: IssueStatus; to: IssueStatus };
}

export const insertIssueSchema = z.object({
  title: z.string(),
  description: z.string().default(""),
  /** Explicit reproduction steps — required at create; thin title-only issues are rejected. */
  reproSteps: z.string().min(1),
  status: z.string().default("open"),
  /** Creation provenance. Reported issues are human-submitted and excluded from autonomous repair queues. */
  kind: issueKindEnum.default("tracked"),
  page: z.string().nullable().optional(),
  screenshot: z.string().nullable().optional(),
  spec: z.string().nullable().optional(),
  feedback: z.string().nullable().optional(),
  notes: z.any().nullable().optional(),
  logs: z.string().nullable().optional(),
  dependencies: z.array(z.number()).nullable().optional(),
  /** Platforms Environment ID. Optional on input — createIssue fills from runtime identity when omitted. */
  platformEnvironmentId: z.number().int().positive().nullable().optional(),
  /** Provider deployment/build ID. Optional on input — createIssue fills from runtime identity when omitted. */
  buildId: z.string().min(1).nullable().optional(),
  /** Canonical Product owning the intent behind this Issue. */
  productId: z.number().int().positive().optional(),
});

export interface Issue {
  id: number;
  title: string;
  description: string;
  /** Explicit reproduction steps. Always non-empty on issues created after the repro gate. */
  reproSteps: string;
  status: string;
  /** Human reports remain visible for triage but are never autonomous repair work. */
  kind: IssueKind;
  page: string | null;
  screenshot: string | null;
  spec: string | null;
  feedback: string | null;
  notes: unknown;
  logs: string | null;
  dependencies: number[] | null;
  /** Platforms Environment ID the issue was filed against. Null only on legacy pre-gate issues. */
  platformEnvironmentId: number | null;
  /** Provider deployment/build ID the issue was filed against. Null only on legacy pre-gate issues. */
  buildId: string | null;
  /** Canonical Product owning this Issue. */
  productId: number;
  createdAt: Date;
}
export type InsertIssue = z.infer<typeof insertIssueSchema>;

export const insertApiCallSchema = z.object({
  scope: z.enum(["user", "system"]).default("system"),
  ownerUserId: z.string().nullable().optional(),
  accountId: z.string().nullable().optional(),
  provider: z.string(),
  model: z.string(),
  profile: z.string().nullable().optional(),
  inputTokens: z.number().default(0),
  outputTokens: z.number().default(0),
  cacheReadTokens: z.number().nullable().optional(),
  cacheWriteTokens: z.number().nullable().optional(),
  totalTokens: z.number().default(0),
  costInput: z.number().default(0),
  costOutput: z.number().default(0),
  costTotal: z.number().default(0),
  sessionKey: z.string().nullable().optional(),
  sessionId: z.number().nullable().optional(),
  captureId: z.string().uuid().nullable().optional(),
  requestContent: z.string().nullable().optional(),
  responseContent: z.string().nullable().optional(),
  durationMs: z.number().nullable().optional(),
  stopReason: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
});

export interface ApiCall {
  id: number;
  timestamp: Date;
  scope: "user" | "system";
  ownerUserId: string | null;
  accountId: string | null;
  provider: string;
  model: string;
  profile: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number;
  costInput: number;
  costOutput: number;
  costTotal: number;
  sessionKey: string | null;
  sessionId: number | null;
  captureId: string | null;
  requestContent: string | null;
  responseContent: string | null;
  durationMs: number | null;
  stopReason: string | null;
  metadata?: Record<string, unknown> | null;
}
export type InsertApiCall = z.infer<typeof insertApiCallSchema>;

export const apiCallRecords = pgTable("api_calls", {
  id: serial("id").primaryKey(),
  timestamp: timestamp("timestamp", { withTimezone: false }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  scope: text("scope").notNull().default("system"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  model: text("model").notNull(),
  provider: text("provider").notNull(),
  profile: text("profile"),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cacheReadTokens: integer("cache_read_tokens"),
  cacheWriteTokens: integer("cache_write_tokens"),
  totalTokens: integer("total_tokens").notNull().default(0),
  costInput: real("cost_input").notNull().default(0),
  costOutput: real("cost_output").notNull().default(0),
  costTotal: real("cost_total").notNull().default(0),
  sessionKey: text("session_key"),
  sessionId: integer("session_id"),
  durationMs: integer("duration_ms"),
  stopReason: text("stop_reason"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`),
}, (table) => [
  index("idx_api_calls_timestamp").on(table.timestamp),
  index("idx_api_calls_owner_timestamp").on(table.ownerUserId, table.accountId, table.timestamp),
]);

export const inferencePayloadCaptures = pgTable("inference_payload_captures", {
  id: uuid("id").primaryKey(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id").notNull(),
  accountId: text("account_id").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  activity: text("activity"),
  boundary: text("boundary").notNull(),
  authority: text("authority").notNull(),
  observableBoundary: text("observable_boundary").notNull(),
  request: jsonb("request").$type<unknown>().notNull(),
  requestChars: integer("request_chars").notNull(),
  excludedSensitiveFields: jsonb("excluded_sensitive_fields").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  residualLimitation: text("residual_limitation"),
  apiCallId: integer("api_call_id"),
  attempt: integer("attempt").notNull().default(1),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  sessionId: text("session_id"),
  source: text("source"),
}, (table) => [
  index("idx_inference_payload_owner_captured").on(table.ownerUserId, table.accountId, table.capturedAt),
  index("idx_inference_payload_session").on(table.sessionId, table.capturedAt),
  uniqueIndex("uq_inference_payload_api_call").on(table.apiCallId).where(sql`${table.apiCallId} IS NOT NULL`),
]);

export type InferencePayloadCaptureRow = typeof inferencePayloadCaptures.$inferSelect;

// SpawnedIntentionSpec removed — intention system deprecated

export const systemSettings = pgTable("system_settings", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertSystemSettingSchema = createInsertSchema(systemSettings).omit({
  id: true,
  updatedAt: true,
});

export type SystemSetting = typeof systemSettings.$inferSelect;
export type InsertSystemSetting = z.infer<typeof insertSystemSettingSchema>;

export const appSecrets = pgTable("app_secrets", {
  name: text("name").primaryKey(),
  envelope: jsonb("envelope").notNull(),
  last4: text("last4").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedBy: text("updated_by"),
});

export type AppSecretRow = typeof appSecrets.$inferSelect;

export const objectAcls = pgTable("object_acls", {
  objectKey: text("object_key").primaryKey(),
  policy: jsonb("policy").notNull(),
  vaultId: text("vault_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export type ObjectAclRow = typeof objectAcls.$inferSelect;

// ── Timers ─────────────────────────────────────────────────────────────
export const timers = pgTable("timers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  type: text("type").notNull(),
  prompt: text("prompt").notNull().default(""),
  skillId: text("skill_id"),
  systemKey: text("system_key"),
  schedules: jsonb("schedules").notNull().default([]),
  enabled: boolean("enabled").notNull().default(true),
  timezone: text("timezone").notNull().default("America/New_York"),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_timers_scope_owner").on(table.scope, table.ownerUserId),
  index("idx_timers_account").on(table.accountId),
  index("idx_timers_type").on(table.type),
  uniqueIndex("idx_timers_system_key_system_unique").on(table.systemKey).where(sql`${table.scope} = 'system' AND ${table.systemKey} IS NOT NULL`),
  uniqueIndex("idx_timers_system_key_user_unique").on(table.ownerUserId, table.systemKey).where(sql`${table.scope} = 'user' AND ${table.systemKey} IS NOT NULL`),
  check("timers_ownership_contract", sql`
    (${table.scope} = 'user' AND ${table.type} <> 'system' AND ${table.ownerUserId} IS NOT NULL AND ${table.accountId} IS NOT NULL)
    OR (${table.scope} = 'system' AND ${table.systemKey} IS NOT NULL AND ${table.ownerUserId} IS NULL AND ${table.accountId} IS NULL)
    OR (${table.scope} = 'quarantine' AND ${table.enabled} = false AND ${table.ownerUserId} IS NULL AND ${table.accountId} IS NULL)
  `),
]);

export const insertTimerTableSchema = createInsertSchema(timers).omit({
  createdAt: true,
  updatedAt: true,
});

export type TimerRow = typeof timers.$inferSelect;
export type InsertTimerRow = z.infer<typeof insertTimerTableSchema>;

export const responsibilityRuns = pgTable("responsibility_runs", {
  id: serial("id").primaryKey(),
  runId: text("run_id").notNull(),
  responsibilityId: text("responsibility_id").notNull(),
  scheduleId: text("schedule_id").notNull().default(""),
  status: text("status").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true, precision: 6 }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true, precision: 6 }),
  durationMs: integer("duration_ms"),
  sessionId: text("conversation_id"),
  trigger: text("trigger").notNull().default("scheduled"),
  intendedFireAt: timestamp("intended_fire_at", { withTimezone: true, precision: 6 }),
  scheduledSlotStart: timestamp("scheduled_slot_start", { withTimezone: true, precision: 6 }),
  scheduledSlotEnd: timestamp("scheduled_slot_end", { withTimezone: true, precision: 6 }),
  error: text("error"),
  metadata: jsonb("metadata"),
  scope: text("scope").notNull().default("quarantine"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
}, (table) => [
  index("idx_responsibility_runs_scope_owner").on(table.scope, table.ownerUserId),
  index("idx_responsibility_runs_account").on(table.accountId),
  check("responsibility_runs_ownership_contract", sql`
    (${table.scope} = 'user' AND ${table.ownerUserId} IS NOT NULL AND ${table.accountId} IS NOT NULL)
    OR (${table.scope} IN ('system', 'quarantine') AND ${table.ownerUserId} IS NULL AND ${table.accountId} IS NULL)
  `),
  uniqueIndex("idx_responsibility_runs_run_id_unique").on(table.runId),
  // Exactly-once scheduled execution: the insert is the claim. Any non-deferred
  // status occupies the slot so concurrent replicas cannot each insert a run
  // for the same (timer, schedule, slot). Deferred is excluded so soft-deferral
  // retries can re-occupy the same logical slot after claimDeferredRunForRetry.
  uniqueIndex("idx_responsibility_runs_scheduled_slot_unique")
    .on(table.responsibilityId, table.scheduleId, table.scheduledSlotStart, table.scheduledSlotEnd)
    .where(sql`${table.trigger} = 'scheduled' AND ${table.status} <> 'deferred' AND ${table.scheduledSlotStart} IS NOT NULL AND ${table.scheduledSlotEnd} IS NOT NULL`),
]);

export const insertResponsibilityRunSchema = createInsertSchema(responsibilityRuns).omit({
  id: true,
});

export type ResponsibilityRunRow = typeof responsibilityRuns.$inferSelect;
export type InsertResponsibilityRun = z.infer<typeof insertResponsibilityRunSchema>;

export const timerRuns = responsibilityRuns;
export const insertTimerRunSchema = insertResponsibilityRunSchema;
export type TimerRunRow = ResponsibilityRunRow;
export type InsertTimerRun = InsertResponsibilityRun;

export const objectGrantSubjectTypes = ["user", "invited_subject", "team", "organization"] as const;
/**
 * Task assignment is the human-obligation axis and is deliberately narrower than grant subjects:
 * a task can be owed by a person, never by a team. Kept as its own single source so widening the
 * grant subject set (e.g. adding `team`) can never silently make teams task-assignable.
 */
export const taskAssigneeSubjectTypes = ["user", "invited_subject"] as const;
/** Team membership roles. `admin` may manage the team's roster; both are grant-expanded identically. */
export const teamMemberRoles = ["admin", "member"] as const;
/** Organization member roles. `admin` may manage the org roster/billing; both are grant-expanded identically. */
export const organizationMemberRoles = ["admin", "member"] as const;
export const objectGrantObjectTypes = ["project", "milestone", "task", "library_page", "vault", "drive_resource"] as const;
export const objectGrantCapabilities = ["read", "write", "admin"] as const;
export const objectGrantOriginTypes = ["meeting", "manual"] as const;

// ── Tasks ──────────────────────────────────────────────────────────────
export const tasks = pgTable("tasks", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  status: text("status").notNull().default("ready"),
  priority: text("priority").notNull().default("mid"),
  impact: text("impact").notNull().default("mid"),
  effort: text("effort").notNull().default("mid"),
  owner: text("owner").notNull().default("me"),
  /** Human obligation axis. Execution ownership remains in owner (me | agent). */
  assigneeSubjectType: text("assignee_subject_type", { enum: taskAssigneeSubjectTypes }),
  assigneeSubjectId: text("assignee_subject_id"),
  requiresReview: boolean("requires_review").notNull().default(false),
  projectId: integer("project_id"),
  milestoneId: integer("milestone_id"),
  /** Container and inheritance anchor only. Work visibility remains owner/grant based. */
  vaultId: text("vault_id").notNull().references(() => vaults.id, { onDelete: "restrict" }),
  tags: jsonb("tags").notNull().default([]),
  deliverable: text("deliverable").notNull().default(""),
  acceptanceCriteria: text("acceptance_criteria").notNull().default(""),
  context: text("context").notNull().default(""),
  output: text("output").notNull().default(""),
  deadline: text("deadline"),
  tokenEstimate: integer("token_estimate"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_tasks_status").on(table.status),
  index("idx_tasks_project").on(table.projectId),
  index("idx_tasks_scope_owner").on(table.scope, table.ownerUserId),
  index("idx_tasks_vault").on(table.vaultId),
  index("idx_tasks_assignee").on(table.assigneeSubjectType, table.assigneeSubjectId),
  check("tasks_assignee_subject_pair_check", sql`
    (${table.assigneeSubjectType} IS NULL AND ${table.assigneeSubjectId} IS NULL)
    OR (${table.assigneeSubjectType} IN ('user', 'invited_subject') AND NULLIF(BTRIM(${table.assigneeSubjectId}), '') IS NOT NULL)
  `),
]);

export type TaskRow = typeof tasks.$inferSelect;

// ── Projects ──────────────────────────────────────────────────────
export const projects = pgTable("projects", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  status: text("status").notNull().default("idea"),
  priority: text("priority").notNull().default("mid"),
  owner: text("owner").notNull().default("me"),
  requiresReview: boolean("requires_review").notNull().default(false),
  dueDate: text("due_date"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  spec: text("spec").notNull().default(""),
  goalId: text("goal_id"),
  /** Migration-compatible primary/default Vault. project_vault_memberships owns Project visibility. */
  vaultId: text("vault_id").notNull().references(() => vaults.id, { onDelete: "restrict" }),
  /** @deprecated Milestones are canonical in the milestones table. Remove after one release (target: 2026-08-05). */
  milestones: jsonb("milestones").notNull().default([]),
  tags: jsonb("tags").notNull().default([]),
  people: jsonb("people").notNull().default([]),
  notes: jsonb("notes").notNull().default([]),
  files: jsonb("files").notNull().default([]),
  pages: jsonb("pages").notNull().default([]),
  activity: jsonb("activity").notNull().default([]),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_projects_status").on(table.status),
  index("idx_projects_scope_owner").on(table.scope, table.ownerUserId),
  index("idx_projects_vault").on(table.vaultId),
]);

export type ProjectRow = typeof projects.$inferSelect;

export const projectVaultMemberships = pgTable("project_vault_memberships", {
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  vaultId: text("vault_id").notNull().references(() => vaults.id, { onDelete: "restrict" }),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id").notNull(),
  accountId: text("account_id").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  primaryKey({ columns: [table.projectId, table.vaultId] }),
  index("idx_project_vault_memberships_vault_project").on(table.vaultId, table.projectId),
  index("idx_project_vault_memberships_scope_owner").on(table.scope, table.ownerUserId),
  index("idx_project_vault_memberships_account").on(table.accountId),
]);

export type ProjectVaultMembership = typeof projectVaultMemberships.$inferSelect;

// ── Milestones ────────────────────────────────────────────────────
export const milestones = pgTable("milestones", {
  id: integer("id").notNull(),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  vaultId: text("vault_id").notNull().references(() => vaults.id, { onDelete: "restrict" }),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  scope: text("scope").notNull().default("user"),
  createdByUserId: text("created_by_user_id"),
  name: text("name").notNull(),
  status: text("status").notNull().default("planned"),
  startDate: text("start_date"),
  dueDate: text("due_date"),
  displayOrder: integer("display_order").notNull().default(0),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  primaryKey({ columns: [table.projectId, table.id] }),
  index("idx_milestones_project_order").on(table.projectId, table.displayOrder, table.id),
  index("idx_milestones_scope_owner").on(table.scope, table.ownerUserId),
  index("idx_milestones_account").on(table.accountId),
  index("idx_milestones_vault").on(table.vaultId),
  check("milestones_status_check", sql`${table.status} IN ('planned', 'active', 'completed')`),
]);

export type MilestoneRow = typeof milestones.$inferSelect;

// ── Per-object work grants ────────────────────────────────────────
export const objectGrants = pgTable("object_grants", {
  id: serial("id").primaryKey(),
  subjectType: text("subject_type", { enum: objectGrantSubjectTypes }).notNull(),
  subjectId: text("subject_id").notNull(),
  objectType: text("object_type", { enum: objectGrantObjectTypes }).notNull(),
  /** Project/task: decimal id. Milestone: <project_id>:<milestone_id>. */
  objectId: text("object_id").notNull(),
  capability: text("capability", { enum: objectGrantCapabilities }).notNull(),
  grantedByUserId: text("granted_by_user_id").notNull(),
  originType: text("origin_type", { enum: objectGrantOriginTypes }).notNull(),
  originId: text("origin_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (table) => [
  check("object_grants_subject_type_check", sql`${table.subjectType} IN ('user', 'invited_subject', 'team', 'organization')`),
  check("object_grants_object_type_check", sql`${table.objectType} IN ('project', 'milestone', 'task', 'library_page', 'vault', 'drive_resource')`),
  check("object_grants_capability_check", sql`${table.capability} IN ('read', 'write', 'admin')`),
  check("object_grants_origin_type_check", sql`${table.originType} IN ('meeting', 'manual')`),
  uniqueIndex("idx_object_grants_one_live_subject_object")
    .on(table.subjectType, table.subjectId, table.objectType, table.objectId)
    .where(sql`${table.revokedAt} IS NULL`),
  index("idx_object_grants_live_subject_object")
    .on(table.subjectType, table.subjectId, table.objectType, table.objectId, table.capability)
    .where(sql`${table.revokedAt} IS NULL`),
  index("idx_object_grants_live_object")
    .on(table.objectType, table.objectId)
    .where(sql`${table.revokedAt} IS NULL`),
]);

export type ObjectGrantRow = typeof objectGrants.$inferSelect;
export type InsertObjectGrantRow = typeof objectGrants.$inferInsert;

// ── Teams: grant-addressable groups within an account ─────────────
// A team is never an access grant by itself — it is only a *subject* an object_grant can target.
// Membership expands a team grant to its member users at authorize() time (subjectMatchPredicate).
export const teams = pgTable("teams", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  accountId: varchar("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  createdByUserId: varchar("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_teams_account").on(table.accountId),
  uniqueIndex("idx_teams_account_name_unique").on(table.accountId, table.name),
]);

export const teamMembers = pgTable("team_members", {
  id: serial("id").primaryKey(),
  teamId: text("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role", { enum: teamMemberRoles }).notNull().default("member"),
  addedByUserId: varchar("added_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  uniqueIndex("idx_team_members_team_user_unique").on(table.teamId, table.userId),
  index("idx_team_members_user").on(table.userId),
  check("team_members_role_check", sql`${table.role} IN ('admin', 'member')`),
]);

export type TeamRow = typeof teams.$inferSelect;
export type InsertTeamRow = typeof teams.$inferInsert;
export type TeamMemberRow = typeof teamMembers.$inferSelect;
export type InsertTeamMemberRow = typeof teamMembers.$inferInsert;

// ── Organizations: cross-account billing collection + grant subject ──────
// An organization sits ABOVE accounts (the inverse of a team, which lives inside one account): it
// collects member users for billing and is a grant-addressable subject. Like a team, an org grants
// no access on its own — only an object_grant targeting ('organization', orgId) does, expanded to
// member users at authorize() time. A user belongs to at most one org (0..1) — enforced by a unique
// constraint on organization_members.user_id, making "one billing home per user" a structural truth.
export const organizations = pgTable("organizations", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  /** The user who owns the org (billing authority). Ownership, not membership, roots management. */
  ownerUserId: varchar("owner_user_id").references(() => users.id, { onDelete: "set null" }),
  /** Billing-collection intent: where invoices for the collected accounts are sent. */
  billingEmail: text("billing_email"),
  createdByUserId: varchar("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_organizations_owner").on(table.ownerUserId),
]);

export const organizationMembers = pgTable("organization_members", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role", { enum: organizationMemberRoles }).notNull().default("member"),
  addedByUserId: varchar("added_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  // 0..1 org per user: a user can be a member of at most one organization (their billing home).
  uniqueIndex("idx_org_members_user_unique").on(table.userId),
  index("idx_org_members_org").on(table.organizationId),
  check("organization_members_role_check", sql`${table.role} IN ('admin', 'member')`),
]);

export type OrganizationRow = typeof organizations.$inferSelect;
export type InsertOrganizationRow = typeof organizations.$inferInsert;
export type OrganizationMemberRow = typeof organizationMembers.$inferSelect;
export type InsertOrganizationMemberRow = typeof organizationMembers.$inferInsert;

// ── Drive resources: Google Drive files/folders bound into a vault's Files branch ──
// A drive_resource is an *explicit* binding created via the Google Picker (drive.file scope). It is
// a pointer, never a copy: unbinding removes the row and never touches the underlying Google file.
// It is a first-class grantable object (Step 8) so a bound file can be shared like a native page.
export const driveResourceTypes = ["file", "folder"] as const;
export const driveResources = pgTable("drive_resources", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  accountId: varchar("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  vaultId: text("vault_id").notNull().references(() => vaults.id, { onDelete: "cascade" }),
  /** The connected account this file was picked from (drive.file grants per-file access for Google). */
  connectedAccountId: text("connected_account_id"),
  /** Provider discriminant — google | box | mantra. Part of the bind identity. */
  provider: text("provider").notNull().default("google"),
  /** Provider-native file id — the durable handle used for reads and (Step C) writes. */
  providerFileId: text("provider_file_id").notNull(),
  name: text("name").notNull(),
  mimeType: text("mime_type"),
  resourceType: text("resource_type", { enum: driveResourceTypes }).notNull().default("file"),
  iconUrl: text("icon_url"),
  webViewLink: text("web_view_link"),
  origin: text("origin").notNull().default("bind"),
  sourceSessionId: text("source_session_id"),
  addedByUserId: varchar("added_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_drive_resources_vault").on(table.vaultId),
  index("idx_drive_resources_account").on(table.accountId),
  uniqueIndex("idx_drive_resources_vault_provider_file_unique").on(
    table.vaultId,
    table.provider,
    table.providerFileId,
  ),
  check("drive_resources_resource_type_check", sql`${table.resourceType} IN ('file', 'folder')`),
  check("drive_resources_provider_check", sql`${table.provider} IN ('google', 'box', 'mantra')`),
  check("drive_resources_origin_check", sql`${table.origin} IN ('bind', 'upload')`),
]);

export const uploadResourceSources = pgTable("upload_resource_sources", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  driveResourceId: text("drive_resource_id").notNull().references(() => driveResources.id, { onDelete: "cascade" }),
  sessionId: text("session_id"),
  messageId: text("message_id"),
  sourceKind: text("source_kind").notNull().default("conversation"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  uniqueIndex("idx_upload_resource_sources_identity").on(table.driveResourceId, table.sourceKind, table.sessionId, table.messageId),
  index("idx_upload_resource_sources_session").on(table.sessionId),
]);

export type DriveResourceRow = typeof driveResources.$inferSelect;
export type InsertDriveResourceRow = typeof driveResources.$inferInsert;

// ── Files index policy + materialized indexed file sources ─────────
// Indexing is a policy over canonical drive_resources, not recursive state on every
// provider child. Folders use mode=recursive as a continuous selection rule; discovered
// files materialize as indexed_file_sources. Semantic extraction state stays in
// memory_vnext_source_queue (drive_file source ids = drive_resources.id for bound files,
// or indexed_file_sources.id for discovered descendants). v1 has no per-child exclusions.
export const fileIndexPolicyModes = ["off", "self", "recursive"] as const;
export type FileIndexPolicyMode = (typeof fileIndexPolicyModes)[number];

export const fileIndexPolicies = pgTable("file_index_policies", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  accountId: varchar("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  ownerUserId: varchar("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  vaultId: text("vault_id").notNull().references(() => vaults.id, { onDelete: "cascade" }),
  /** Canonical bound root this policy anchors to. */
  driveResourceId: text("drive_resource_id").notNull().references(() => driveResources.id, { onDelete: "cascade" }),
  mode: text("mode", { enum: fileIndexPolicyModes }).notNull().default("off"),
  createdByUserId: varchar("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  updatedByUserId: varchar("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  uniqueIndex("idx_file_index_policies_drive_resource").on(table.driveResourceId),
  index("idx_file_index_policies_vault").on(table.vaultId),
  index("idx_file_index_policies_account").on(table.accountId),
  check("file_index_policies_mode_check", sql`${table.mode} IN ('off', 'self', 'recursive')`),
]);

export type FileIndexPolicyRow = typeof fileIndexPolicies.$inferSelect;
export type InsertFileIndexPolicyRow = typeof fileIndexPolicies.$inferInsert;

export const indexedFileSourceDiscoveryStates = [
  "active",
  "inaccessible",
  "deleted",
  "unsupported",
  "retired",
] as const;
export type IndexedFileSourceDiscoveryState = (typeof indexedFileSourceDiscoveryStates)[number];

/**
 * Materialized file sources discovered under an active index policy.
 * One row per (account, vault, provider, provider_file_id). Coverage is multi-policy:
 * retiring one policy must not delete a source still covered by another active policy.
 * Do not store recursive expansion state on every provider child outside this table.
 */
export const indexedFileSources = pgTable("indexed_file_sources", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  accountId: varchar("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  ownerUserId: varchar("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  vaultId: text("vault_id").notNull().references(() => vaults.id, { onDelete: "cascade" }),
  /** Policy that last claimed/upserted this source (provenance, not exclusive coverage). */
  policyId: text("policy_id").references(() => fileIndexPolicies.id, { onDelete: "set null" }),
  /** Bound root drive_resource that owns the selecting policy, when known. */
  rootDriveResourceId: text("root_drive_resource_id").references(() => driveResources.id, {
    onDelete: "set null",
  }),
  /**
   * When the discovered file is itself an explicit bind, point at that drive_resource.
   * drive_file queue source ids prefer this id so FilesApi authorize stays bind-native.
   */
  driveResourceId: text("drive_resource_id").references(() => driveResources.id, {
    onDelete: "set null",
  }),
  provider: text("provider").notNull(),
  providerFileId: text("provider_file_id").notNull(),
  name: text("name").notNull(),
  mimeType: text("mime_type"),
  providerPath: text("provider_path"),
  providerParentId: text("provider_parent_id"),
  providerChecksum: text("provider_checksum"),
  providerModifiedAt: timestamp("provider_modified_at", { withTimezone: true }),
  discoveryState: text("discovery_state", { enum: indexedFileSourceDiscoveryStates })
    .notNull()
    .default("active"),
  title: text("title"),
  oneLiner: text("one_liner"),
  summary: text("summary"),
  tags: jsonb("tags").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  lastDiscoveredAt: timestamp("last_discovered_at", { withTimezone: true })
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  uniqueIndex("idx_indexed_file_sources_vault_provider_file").on(
    table.vaultId,
    table.provider,
    table.providerFileId,
  ),
  index("idx_indexed_file_sources_account").on(table.accountId),
  index("idx_indexed_file_sources_policy").on(table.policyId),
  index("idx_indexed_file_sources_root").on(table.rootDriveResourceId),
  index("idx_indexed_file_sources_drive_resource").on(table.driveResourceId),
  index("idx_indexed_file_sources_discovery").on(table.discoveryState),
  check(
    "indexed_file_sources_discovery_state_check",
    sql`${table.discoveryState} IN ('active', 'inaccessible', 'deleted', 'unsupported', 'retired')`,
  ),
  check("indexed_file_sources_provider_check", sql`${table.provider} IN ('google', 'box', 'mantra')`),
]);

export type IndexedFileSourceRow = typeof indexedFileSources.$inferSelect;
export type InsertIndexedFileSourceRow = typeof indexedFileSources.$inferInsert;

/** Durable reconciliation-run progress for folder recursive discovery. */
export const fileIndexReconciliationRunPhases = [
  "queued",
  "discovering",
  "indexing",
  "complete",
  "partial",
  "failed",
  "canceled",
] as const;
export type FileIndexReconciliationRunPhase = (typeof fileIndexReconciliationRunPhases)[number];

export const fileIndexReconciliationRuns = pgTable("file_index_reconciliation_runs", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  accountId: varchar("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  ownerUserId: varchar("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  vaultId: text("vault_id").notNull().references(() => vaults.id, { onDelete: "cascade" }),
  policyId: text("policy_id").notNull().references(() => fileIndexPolicies.id, { onDelete: "cascade" }),
  rootDriveResourceId: text("root_drive_resource_id")
    .notNull()
    .references(() => driveResources.id, { onDelete: "cascade" }),
  phase: text("phase", { enum: fileIndexReconciliationRunPhases }).notNull().default("queued"),
  foldersVisited: integer("folders_visited").notNull().default(0),
  filesDiscovered: integer("files_discovered").notNull().default(0),
  filesEligible: integer("files_eligible").notNull().default(0),
  filesCompleted: integer("files_completed").notNull().default(0),
  filesUnchanged: integer("files_unchanged").notNull().default(0),
  filesUnsupported: integer("files_unsupported").notNull().default(0),
  filesFailed: integer("files_failed").notNull().default(0),
  discoveryCursor: jsonb("discovery_cursor").$type<Record<string, unknown> | null>(),
  lastError: text("last_error"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_file_index_recon_runs_policy").on(table.policyId),
  index("idx_file_index_recon_runs_account_phase").on(table.accountId, table.phase),
  index("idx_file_index_recon_runs_root").on(table.rootDriveResourceId),
  check(
    "file_index_reconciliation_runs_phase_check",
    sql`${table.phase} IN ('queued', 'discovering', 'indexing', 'complete', 'partial', 'failed', 'canceled')`,
  ),
]);

export type FileIndexReconciliationRunRow = typeof fileIndexReconciliationRuns.$inferSelect;
export type InsertFileIndexReconciliationRunRow = typeof fileIndexReconciliationRuns.$inferInsert;

// ── Principles ────────────────────────────────────────────────────
export const principles = pgTable("principles", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  layer1: text("layer1").notNull().default(""),
  layer2: text("layer2").notNull().default(""),
  autoTags: jsonb("auto_tags").notNull().default([]),
  manualTags: jsonb("manual_tags").notNull().default([]),
  relatedIds: jsonb("related_ids").notNull().default([]),
  currentRevisionId: text("current_revision_id").notNull(),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_principles_scope_owner").on(table.scope, table.ownerUserId),
]);

export const principleRevisions = pgTable("principle_revisions", {
  id: text("id").primaryKey(),
  principleId: text("principle_id").notNull().references(() => principles.id, { onDelete: "cascade" }),
  revisionNumber: integer("revision_number").notNull(),
  title: text("title").notNull(),
  layer1: text("layer1").notNull().default(""),
  layer2: text("layer2").notNull().default(""),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  uniqueIndex("principle_revisions_principle_revision_idx").on(table.principleId, table.revisionNumber),
  uniqueIndex("principle_revisions_principle_id_idx").on(table.principleId, table.id),
  index("principle_revisions_account_idx").on(table.accountId),
]);

export type PrincipleRow = typeof principles.$inferSelect;
export type PrincipleRevisionRow = typeof principleRevisions.$inferSelect;

// ── Companies ─────────────────────────────────────────────────────
export const companies = pgTable("companies", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  website: text("website"),
  industry: text("industry"),
  location: text("location"),
  notes: text("notes"),
  tags: jsonb("tags").notNull().default([]),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_companies_scope_owner").on(table.scope, table.ownerUserId),
  index("idx_companies_name").on(table.name),
]);

export type CompanyRow = typeof companies.$inferSelect;

export const companyIdentityKeys = pgTable("company_identity_keys", {
  id: serial("id").primaryKey(),
  companyId: text("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  value: text("value").notNull(),
  normalizedValue: text("normalized_value").notNull(),
  identityNamespace: text("identity_namespace").notNull(),
  source: text("source").notNull().default("manual"),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  createdByUserId: text("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedByUserId: text("revoked_by_user_id"),
}, (table) => [
  index("idx_company_identity_keys_company").on(table.companyId),
  index("idx_company_identity_keys_scope_owner").on(table.scope, table.ownerUserId),
  index("idx_company_identity_keys_normalized").on(table.normalizedValue),
  uniqueIndex("uq_company_identity_keys_active_namespace_value")
    .on(table.identityNamespace, table.normalizedValue)
    .where(sql`revoked_at IS NULL`),
]);

export type CompanyIdentityKeyRow = typeof companyIdentityKeys.$inferSelect;

// ── Financial Models (investor-facing business model) ─────────────
// User-owned. One model per Business. Assumptions are stored as a normalized
// jsonb blob; shared/models/business-model.ts owns the shape, defaults, and clamps.
export const financialModels = pgTable("financial_models", {
  id: text("id").primaryKey(),
  businessId: text("business_id").references(() => businesses.id, { onDelete: "restrict" }),
  name: text("name").notNull().default("Business Model"),
  assumptions: jsonb("assumptions").notNull().default({}),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  createdByUserId: text("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  uniqueIndex("uq_financial_models_business").on(table.businessId),
  index("idx_financial_models_scope_owner").on(table.scope, table.ownerUserId),
  index("idx_financial_models_account").on(table.accountId),
]);

export type FinancialModelRow = typeof financialModels.$inferSelect;

// ── Business Budgets (non-headcount operating expenses) ─────────
// One hypothetical monthly aggregate per Business. The nested document preserves
// Department → Category → Line item ordering; totals derive from each line item's
// single monthly amount rather than becoming competing stored truth.
export const businessBudgets = pgTable("business_budgets", {
  id: text("id").primaryKey(),
  businessId: text("business_id").notNull().references(() => businesses.id, { onDelete: "restrict" }),
  // Rolling compatibility key; product/API identity is Business alone.
  year: integer("year").notNull(),
  currency: text("currency").notNull().default("USD"),
  departments: jsonb("departments").notNull().default([]),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  createdByUserId: text("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  uniqueIndex("uq_business_budgets_business_year").on(table.businessId, table.year),
  index("idx_business_budgets_scope_owner").on(table.scope, table.ownerUserId),
  index("idx_business_budgets_account").on(table.accountId),
]);

export type BusinessBudgetRow = typeof businessBudgets.$inferSelect;

// ── Job Roles (headcount cost inputs) ────────────────────────────
// Account-owned role definitions. Hiring plans will reference these stable
// IDs instead of copying compensation assumptions into the financial model.
export const jobRoles = pgTable("job_roles", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  normalizedTitle: text("normalized_title").notNull(),
  description: text("description").notNull().default(""),
  team: text("team").notNull(),
  annualSalaryMin: integer("annual_salary_min").notNull().default(0),
  annualSalaryMax: integer("annual_salary_max").notNull().default(0),
  targetBonusPercent: real("target_bonus_percent").notNull().default(0),
  equityShareCount: integer("equity_share_count").notNull().default(0),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  createdByUserId: text("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_job_roles_scope_owner").on(table.scope, table.ownerUserId),
  index("idx_job_roles_account_team_title").on(table.accountId, table.team, table.normalizedTitle),
  uniqueIndex("uq_job_roles_account_title").on(table.accountId, table.normalizedTitle).where(sql`account_id IS NOT NULL`),
  check("job_roles_salary_range", sql`${table.annualSalaryMin} >= 0 AND ${table.annualSalaryMax} >= ${table.annualSalaryMin}`),
  check("job_roles_bonus_range", sql`${table.targetBonusPercent} >= 0 AND ${table.targetBonusPercent} <= 1000`),
  check("job_roles_equity_range", sql`${table.equityShareCount} >= 0`),
]);

export type JobRoleRow = typeof jobRoles.$inferSelect;

export const businessHiringSlots = pgTable("business_hiring_slots", {
  id: text("id").primaryKey(),
  businessId: text("business_id").notNull().references(() => businesses.id, { onDelete: "restrict" }),
  roleId: text("role_id").notNull().references(() => jobRoles.id, { onDelete: "restrict" }),
  approvalMonth: text("approval_month").notNull(),
  plannedStartMonth: text("planned_start_month"),
  status: text("status").notNull().default("approved"),
  source: text("source").notNull().default("manual"),
  legacySourceKey: text("legacy_source_key"),
  idempotencyKey: text("idempotency_key"),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  createdByUserId: text("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_business_hiring_slots_business").on(table.businessId, table.status),
  index("idx_business_hiring_slots_scope_owner").on(table.scope, table.ownerUserId),
  uniqueIndex("uq_business_hiring_slots_legacy").on(table.businessId, table.legacySourceKey).where(sql`legacy_source_key IS NOT NULL`),
  uniqueIndex("uq_business_hiring_slots_idempotency").on(table.businessId, table.idempotencyKey).where(sql`idempotency_key IS NOT NULL`),
  check("business_hiring_slots_months", sql`${table.plannedStartMonth} IS NULL OR ${table.plannedStartMonth} >= ${table.approvalMonth}`),
  check("business_hiring_slots_status", sql`${table.status} IN ('approved','canceled')`),
]);

// ── Persons ───────────────────────────────────────────────────────
export const persons = pgTable("persons", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  nicknames: jsonb("nicknames").notNull().default([]),
  cabinetLevel: text("cabinet_level").notNull().default("network"),
  photo: text("photo"),
  birthday: text("birthday"),
  company: text("company"),
  companyId: text("company_id"),
  role: text("role"),
  professionalRelations: jsonb("professional_relations").notNull().default([]),
  relation: text("relation"),
  introducedBy: text("introduced_by"),
  familiarity: text("familiarity"),
  trust: text("trust"),
  met: text("met"),
  socialProfiles: jsonb("social_profiles").notNull().default({}),
  contactInfo: jsonb("contact_info").notNull().default([]),
  importantDates: jsonb("important_dates").notNull().default([]),
  notes: jsonb("notes").notNull().default([]),
  interactions: jsonb("interactions").notNull().default([]),
  tags: jsonb("tags").notNull().default([]),
  aiSummary: text("ai_summary"),
  quickSummary: text("quick_summary"),
  identityContent: text("identity_content"),
  relationshipProfile: jsonb("relationship_profile"),
  networkProfile: jsonb("network_profile"),
  dailyContact: boolean("daily_contact").notNull().default(false),
  private: boolean("private").notNull().default(false),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  lastViewedAt: timestamp("last_viewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_persons_cabinet_level").on(table.cabinetLevel),
  index("idx_persons_company_id").on(table.companyId),
  index("idx_persons_scope_owner").on(table.scope, table.ownerUserId),
]);

export type PersonRow = typeof persons.$inferSelect;

export const personVaultMemberships = pgTable("person_vault_memberships", {
  personId: text("person_id").notNull().references(() => persons.id, { onDelete: "cascade" }),
  vaultId: text("vault_id").notNull().references(() => vaults.id, { onDelete: "cascade" }),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id").notNull(),
  accountId: text("account_id").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  primaryKey({ columns: [table.personId, table.vaultId] }),
  index("idx_person_vault_memberships_vault_person").on(table.vaultId, table.personId),
  index("idx_person_vault_memberships_scope_owner").on(table.scope, table.ownerUserId),
  index("idx_person_vault_memberships_account").on(table.accountId),
]);

export type PersonVaultMembership = typeof personVaultMemberships.$inferSelect;

export const personMergeAliases = pgTable("person_merge_aliases", {
  sourceId: text("source_id").primaryKey(),
  targetId: text("target_id").notNull().references(() => persons.id, { onDelete: "restrict" }),
  sourceName: text("source_name").notNull(),
  targetName: text("target_name").notNull(),
  reason: text("reason").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  sourceSnapshot: jsonb("source_snapshot").$type<Record<string, unknown>>().notNull(),
  targetSnapshot: jsonb("target_snapshot").$type<Record<string, unknown>>().notNull(),
  mergedSnapshot: jsonb("merged_snapshot").$type<Record<string, unknown>>().notNull(),
  referenceSnapshot: jsonb("reference_snapshot").$type<Record<string, unknown>>().notNull(),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id").notNull(),
  accountId: text("account_id").notNull(),
  vaultId: text("vault_id"),
  mergedAt: timestamp("merged_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  unique("person_merge_aliases_owner_idempotency_unique").on(table.ownerUserId, table.accountId, table.idempotencyKey),
  index("idx_person_merge_aliases_target").on(table.targetId),
  index("idx_person_merge_aliases_scope_owner").on(table.scope, table.ownerUserId),
  index("idx_person_merge_aliases_account").on(table.accountId),
  index("idx_person_merge_aliases_vault").on(table.vaultId),
]);

export type PersonMergeAlias = typeof personMergeAliases.$inferSelect;

export const simplePeopleSurfaceState = pgTable("simple_people_surface_state", {
  id: serial("id").primaryKey(),
  personId: text("person_id").notNull(),
  reasonKey: text("reason_key").notNull().default("legacy"),
  dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
  dismissedReasonKey: text("dismissed_reason_key"),
  snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
  surfacedAt: timestamp("surfaced_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id").notNull(),
  vaultId: text("vault_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  unique("simple_people_surface_state_person_account_reason_unique").on(table.personId, table.accountId, table.reasonKey),
  index("idx_simple_people_surface_state_scope_owner").on(table.scope, table.ownerUserId),
  index("idx_simple_people_surface_state_person_reason").on(table.personId, table.reasonKey),
  index("idx_simple_people_surface_state_snoozed_until").on(table.snoozedUntil),
]);

export type SimplePeopleSurfaceStateRow = typeof simplePeopleSurfaceState.$inferSelect;

export const connectedAccounts = pgTable("connected_accounts", {
  id: serial("id").primaryKey(),
  accountId: text("account_id").notNull().unique(),
  ownerUserId: text("owner_user_id"),
  principalAccountId: text("principal_account_id"),
  vaultId: text("vault_id"),
  providerAccountId: text("provider_account_id"),
  provider: text("provider").notNull(),
  email: text("email"),
  label: text("label").notNull().default("Personal"),
  workspaceName: text("workspace_name"),
  tokens: jsonb("tokens"),
  permissions: jsonb("permissions"),
  healthy: boolean("healthy").default(true),
  healthError: text("health_error"),
  healthCheckedAt: timestamp("health_checked_at", { withTimezone: true }),
  missingScopes: jsonb("missing_scopes").$type<string[]>(),
  addedAt: timestamp("added_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_connected_accounts_vault").on(table.vaultId),
]);

export const googleOAuthTransactions = pgTable("google_oauth_transactions", {
  tokenHash: text("token_hash").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  principalAccountId: text("principal_account_id").notNull(),
  vaultId: text("vault_id").notNull(),
  provider: text("provider").notNull().default("google"),
  label: text("label"),
  redirectOrigin: text("redirect_origin"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [index("idx_google_oauth_transactions_expires").on(table.expiresAt)]);

/** Durable PKCE state for OpenAI/Grok subscription OAuth (multi-instance safe). */
export const subscriptionOAuthTransactions = pgTable("subscription_oauth_transactions", {
  stateHash: text("state_hash").primaryKey(),
  provider: text("provider").notNull(),
  codeVerifier: text("code_verifier").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_subscription_oauth_transactions_expires").on(table.expiresAt),
  index("idx_subscription_oauth_transactions_provider").on(table.provider),
]);

export const insertConnectedAccountSchema = createInsertSchema(connectedAccounts).omit({
  id: true,
  updatedAt: true,
});

export type ConnectedAccount = typeof connectedAccounts.$inferSelect;
export type InsertConnectedAccount = z.infer<typeof insertConnectedAccountSchema>;

// Intention infrastructure removed — see autonomy skill for replacement


export const voiceSessionActive = pgTable("voice_session_active", {
  id: serial("id").primaryKey(),
  sessionId: text("session_id").notNull().unique(),
  chatSessionId: text("conversation_id"),
  startedAt: timestamp("started_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  status: text("status").notNull().default("active"),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  bootId: text("boot_id"),
  scope: text("scope").notNull().default("system"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  startRequestId: text("start_request_id"),
  startResponse: jsonb("start_response"),
  startReadyAt: timestamp("start_ready_at", { withTimezone: true }),
  inflightTurn: integer("inflight_turn").default(0),
  lastHeartbeat: timestamp("last_heartbeat", { withTimezone: true }),
}, (table) => [
  uniqueIndex("idx_vsa_active_account_conversation_unique")
    .on(table.accountId, table.chatSessionId)
    .where(sql`${table.status} = 'active' AND ${table.scope} = 'user' AND ${table.chatSessionId} IS NOT NULL`),
  uniqueIndex("idx_vsa_account_request_unique")
    .on(table.accountId, table.startRequestId)
    .where(sql`${table.scope} = 'user' AND ${table.startRequestId} IS NOT NULL`),
]);

export const insertVoiceSessionActiveSchema = createInsertSchema(voiceSessionActive).omit({
  id: true,
  startedAt: true,
  endedAt: true,
});

export type VoiceSessionActive = typeof voiceSessionActive.$inferSelect;
export type InsertVoiceSessionActive = z.infer<typeof insertVoiceSessionActiveSchema>;

export const twilioNumberBindings = pgTable("twilio_number_bindings", {
  id: text("id").primaryKey(),
  phoneNumber: text("phone_number").notNull().unique(),
  ownerUserId: text("owner_user_id").notNull(),
  accountId: text("account_id").notNull(),
  vaultId: text("vault_id").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [index("idx_twilio_number_binding_owner").on(table.ownerUserId, table.accountId)]);

export const phoneCallRecords = pgTable("phone_call_records", {
  id: text("id").primaryKey(),
  callSid: text("call_sid").notNull().unique(),
  sessionId: text("session_id").notNull(),
  voiceSessionId: text("voice_session_id").notNull(),
  direction: text("direction").notNull(),
  fromNumber: text("from_number").notNull(),
  toNumber: text("to_number").notNull(),
  personId: text("person_id"),
  personName: text("person_name"),
  ownerUserId: text("owner_user_id").notNull(),
  accountId: text("account_id").notNull(),
  vaultId: text("vault_id").notNull(),
  status: text("status").notNull().default("queued"),
  interactionLogged: boolean("interaction_logged").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
}, (table) => [index("idx_phone_call_owner").on(table.ownerUserId, table.accountId), index("idx_phone_call_session").on(table.sessionId)]);

// intentions, parkedIdeas, intentionAttempts tables removed — see autonomy skill

export const emailTriageLog = pgTable("email_triage_log", {
  id: serial("id").primaryKey(),
  gmailMessageId: text("gmail_message_id").notNull(),
  accountId: text("account_id").notNull(),
  ownerUserId: text("owner_user_id"),
  principalAccountId: text("principal_account_id"),
  vaultId: text("vault_id"),
  cachedMessageId: integer("cached_message_id"),
  tier: text("tier").notNull(),
  senderEmail: text("sender_email"),
  subject: text("subject"),
  triagedAt: timestamp("triaged_at", { withTimezone: true, precision: 6 }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  unique("email_triage_log_message_account_unique").on(table.gmailMessageId, table.accountId),
  index("idx_email_triage_log_owner").on(table.ownerUserId),
  index("idx_email_triage_log_principal_account").on(table.principalAccountId),
  index("idx_email_triage_log_vault").on(table.vaultId),
]);

export const insertEmailTriageLogSchema = createInsertSchema(emailTriageLog).omit({
  id: true,
  triagedAt: true,
});

export type EmailTriageLog = typeof emailTriageLog.$inferSelect;
export type InsertEmailTriageLog = z.infer<typeof insertEmailTriageLogSchema>;

export const emailMessages = pgTable("email_messages", {
  id: serial("id").primaryKey(),
  provider: text("provider").notNull().default("gmail"),
  accountId: text("account_id").notNull(),
  ownerUserId: text("owner_user_id"),
  principalAccountId: text("principal_account_id"),
  vaultId: text("vault_id"),
  providerMessageId: text("provider_message_id").notNull(),
  providerThreadId: text("provider_thread_id"),
  historyId: text("history_id"),
  subject: text("subject"),
  snippet: text("snippet"),
  fromAddress: text("from_address"),
  toAddresses: text("to_addresses"),
  ccAddresses: text("cc_addresses"),
  direction: text("direction").notNull().default("unknown"),
  primaryAction: text("primary_action").notNull().default("reply"),
  date: timestamp("date", { withTimezone: true }),
  labelIds: jsonb("label_ids").$type<string[]>(),
  bodyText: text("body_text"),
  bodyHtml: text("body_html"),
  isRead: boolean("is_read").default(false),
  isStarred: boolean("is_starred").default(false),
  triageStatus: text("triage_status").notNull().default("untriaged"),
  triageTier: text("triage_tier"),
  triageReason: text("triage_reason"),
  triagedAt: timestamp("triaged_at", { withTimezone: true }),
  isDone: boolean("is_done").default(false).notNull(),
  doneReason: text("done_reason"),
  doneAt: timestamp("done_at", { withTimezone: true }),
  snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
  cachedAt: timestamp("cached_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  unique("email_messages_provider_account_message_unique").on(table.provider, table.accountId, table.providerMessageId),
  index("idx_email_messages_owner").on(table.ownerUserId),
  index("idx_email_messages_principal_account").on(table.principalAccountId),
  index("idx_email_messages_vault").on(table.vaultId),
]);

export const insertEmailMessageSchema = createInsertSchema(emailMessages).omit({
  id: true,
  cachedAt: true,
  updatedAt: true,
});

export type EmailMessage = typeof emailMessages.$inferSelect;
export type InsertEmailMessage = z.infer<typeof insertEmailMessageSchema>;



export const personEmails = pgTable("person_emails", {
  accountId: text("account_id").notNull(),
  ownerUserId: text("owner_user_id").notNull(),
  email: text("email").notNull(),
  personId: text("person_id").notNull().references(() => persons.id, { onDelete: "cascade" }),
  personName: text("person_name").notNull(),
  source: text("source").notNull().default("contact_info"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  primaryKey({ columns: [table.accountId, table.email] }),
  index("idx_person_emails_person").on(table.personId),
  index("idx_person_emails_owner").on(table.ownerUserId, table.accountId),
]);

export type PersonEmail = typeof personEmails.$inferSelect;

export const peopleImportCandidates = pgTable("people_import_candidates", {
  email: text("email").primaryKey(),
  candidate: jsonb("candidate").$type<Record<string, any>>().notNull(),
  decision: text("decision").notNull().default("pending"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  mergedPersonId: text("merged_person_id"),
  source: text("source"),
  accountId: text("account_id"),
  ownerUserId: text("owner_user_id"),
  principalAccountId: text("principal_account_id"),
  firstInteractionAt: timestamp("first_interaction_at", { withTimezone: true }),
  lastInteractionAt: timestamp("last_interaction_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_people_import_candidates_decision_updated").on(table.decision, table.updatedAt),
  index("idx_people_import_candidates_account").on(table.accountId),
  index("idx_people_import_candidates_owner").on(table.ownerUserId, table.principalAccountId),
]);

export type PeopleImportCandidate = typeof peopleImportCandidates.$inferSelect;

export const peopleImportDecisions = pgTable("people_import_decisions", {
  id: text("id").primaryKey(),
  candidateId: text("candidate_id").notNull(),
  action: text("action").notNull(),
  outcome: text("outcome").notNull(),
  personId: text("person_id"),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  result: jsonb("result").$type<Record<string, any>>().notNull(),
  undoData: jsonb("undo_data").$type<Record<string, any>>(),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  undoneAt: timestamp("undone_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  unique("people_import_decisions_owner_idempotency_unique").on(table.ownerUserId, table.accountId, table.idempotencyKey),
  index("idx_people_import_decisions_candidate_created").on(table.candidateId, table.createdAt),
  index("idx_people_import_decisions_owner").on(table.ownerUserId, table.accountId),
]);

export type PeopleImportDecision = typeof peopleImportDecisions.$inferSelect;

export const peopleImportBatches = pgTable("people_import_batches", {
  id: text("id").primaryKey(),
  proposalHash: text("proposal_hash").notNull(),
  proposal: jsonb("proposal").$type<Record<string, any>>().notNull(),
  preview: jsonb("preview").$type<Record<string, any>>().notNull(),
  status: text("status").notNull().default("previewed"),
  idempotencyKey: text("idempotency_key"),
  result: jsonb("result").$type<Record<string, any>>(),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  unique("people_import_batches_owner_idempotency_unique").on(table.ownerUserId, table.accountId, table.idempotencyKey),
  index("idx_people_import_batches_owner_created").on(table.ownerUserId, table.accountId, table.createdAt),
  index("idx_people_import_batches_expires").on(table.expiresAt),
]);

export type PeopleImportBatch = typeof peopleImportBatches.$inferSelect;

export const emailSyncCursors = pgTable("email_sync_cursors", {
  id: serial("id").primaryKey(),
  provider: text("provider").notNull().default("gmail"),
  accountId: text("account_id").notNull(),
  ownerUserId: text("owner_user_id"),
  principalAccountId: text("principal_account_id"),
  vaultId: text("vault_id"),
  historyId: text("history_id"),
  lastFullSyncAt: timestamp("last_full_sync_at", { withTimezone: true }),
  lastIncrementalSyncAt: timestamp("last_incremental_sync_at", { withTimezone: true }),
  lastSyncStatus: text("last_sync_status"),
  lastSyncError: text("last_sync_error"),
  messagesCached: integer("messages_cached").default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  unique("email_sync_cursors_provider_account_unique").on(table.provider, table.accountId),
  index("idx_email_sync_cursors_owner").on(table.ownerUserId),
  index("idx_email_sync_cursors_principal_account").on(table.principalAccountId),
  index("idx_email_sync_cursors_vault").on(table.vaultId),
]);

export const insertEmailSyncCursorSchema = createInsertSchema(emailSyncCursors).omit({
  id: true,
  updatedAt: true,
});

export type EmailSyncCursor = typeof emailSyncCursors.$inferSelect;
export type InsertEmailSyncCursor = z.infer<typeof insertEmailSyncCursorSchema>;

export const emailDraftStatuses = ["draft", "sending", "sent", "discarded"] as const;
export const emailDraftStatusSchema = z.enum(emailDraftStatuses);
export const emailDraftBodyFormats = ["text", "markdown"] as const;
export const emailDraftBodyFormatSchema = z.enum(emailDraftBodyFormats);
export const emailDraftPurposes = ["ordinary", "meeting_recap"] as const;
export const emailDraftPurposeSchema = z.enum(emailDraftPurposes);

export const emailDrafts = pgTable("email_drafts", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  scope: text("scope").notNull().default("user"),
  createdByUserId: text("created_by_user_id"),
  vaultId: text("vault_id"),
  sessionId: text("session_id"),
  purpose: text("purpose", { enum: emailDraftPurposes }).notNull().default("ordinary"),
  gmailAccountId: text("gmail_account_id"),
  to: text("to").array().notNull().default(sql`'{}'::text[]`),
  cc: text("cc").array().notNull().default(sql`'{}'::text[]`),
  bcc: text("bcc").array().notNull().default(sql`'{}'::text[]`),
  subject: text("subject").notNull().default(""),
  body: text("body").notNull().default(""),
  bodyFormat: text("body_format", { enum: emailDraftBodyFormats }).notNull().default("text"),
  threadId: text("thread_id"),
  inReplyTo: text("in_reply_to"),
  status: text("status", { enum: emailDraftStatuses }).notNull().default("draft"),
  sentMessageId: text("sent_message_id"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_email_drafts_owner").on(table.ownerUserId),
  index("idx_email_drafts_account").on(table.accountId),
  index("idx_email_drafts_session").on(table.sessionId),
  index("idx_email_drafts_vault").on(table.vaultId),
]);

export const insertEmailDraftSchema = createInsertSchema(emailDrafts).omit({
  id: true,
  sentMessageId: true,
  sentAt: true,
  createdAt: true,
  updatedAt: true,
});

export type EmailDraft = typeof emailDrafts.$inferSelect;
export type InsertEmailDraft = z.infer<typeof insertEmailDraftSchema>;

export const meetingDraftStatuses = ["draft", "scheduling", "scheduled", "discarded"] as const;
export const meetingDrafts = pgTable("meeting_drafts", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  scope: text("scope").notNull().default("user"),
  createdByUserId: text("created_by_user_id"),
  sessionId: text("session_id"),
  googleAccountId: text("google_account_id"),
  calendarId: text("calendar_id").notNull().default("primary"),
  summary: text("summary").notNull().default(""),
  startAt: text("start_at").notNull().default(""),
  endAt: text("end_at"),
  timeZone: text("time_zone").notNull().default("America/Chicago"),
  attendees: text("attendees").array().notNull().default(sql`'{}'::text[]`),
  location: text("location"),
  description: text("description"),
  visibility: text("visibility").notNull().default("default"),
  status: text("status", { enum: meetingDraftStatuses }).notNull().default("draft"),
  googleEventId: text("google_event_id"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, table => [
  index("idx_meeting_drafts_owner").on(table.ownerUserId),
  index("idx_meeting_drafts_account").on(table.accountId),
  index("idx_meeting_drafts_session").on(table.sessionId),
]);

export type MeetingDraft = typeof meetingDrafts.$inferSelect;

export const MEETING_JOIN_MODES = ["dont_join", "note_taking", "join_and_talk"] as const;
export type MeetingJoinMode = typeof MEETING_JOIN_MODES[number];

export function resolveMeetingJoinMode(value: unknown, legacyEnabled = false, legacyOverride?: boolean | null): MeetingJoinMode {
  if (typeof value === "string" && MEETING_JOIN_MODES.includes(value as MeetingJoinMode)) {
    return value as MeetingJoinMode;
  }
  if (legacyOverride === false) return "dont_join";
  return legacyEnabled || legacyOverride === true ? "join_and_talk" : "dont_join";
}

export const calendarEventMetadata = pgTable("calendar_event_metadata", {
  id: serial("id").primaryKey(),
  googleEventId: text("google_event_id").notNull(),
  accountId: text("account_id").notNull(),
  ownerUserId: text("owner_user_id"),
  principalAccountId: text("principal_account_id"),
  vaultId: text("vault_id"),
  calendarId: text("calendar_id").notNull(),
  eventType: text("event_type").notNull().default("meeting"),
  capacityType: text("capacity_type"),
  notes: text("notes"),
  /** Legacy private agenda text. The canonical preparation artifact is agendaLibraryPageId. */
  agenda: text("agenda"),
  /** The meeting's single canonical preparation page. Agenda and legacy brief workflows share this slot. */
  agendaLibraryPageId: text("agenda_library_page_id").references(() => libraryPages.id, { onDelete: "set null" }),
  /** Meeting-level physical audio topology policy for acoustic diarization. */
  speakerPolicy: jsonb("speaker_policy"),
  // Meeting agent auto-join materialization. Status discriminant computed at
  // the source: scheduled | no_link | joined | failed. Detail carries the
  // human-visible reason for no_link/failed.
  /** Explicit per-event participation choice. Nullable only during migration from the legacy booleans. */
  agentJoinMode: text("agent_join_mode", { enum: MEETING_JOIN_MODES }),
  /** @deprecated Compatibility projection. Derived from agentJoinMode. */
  agentJoinEnabled: boolean("agent_join_enabled").notNull().default(false),
  /** @deprecated Compatibility projection. Derived from agentJoinMode. */
  agentJoinOverride: boolean("agent_join_override"),
  agentJoinStatus: text("agent_join_status"),
  agentJoinDetail: text("agent_join_detail"),
  agentJoinSessionId: text("agent_join_session_id"),
  agentJoinStartAt: timestamp("agent_join_start_at", { withTimezone: true }),
  agentJoinAttemptedAt: timestamp("agent_join_attempted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  unique("calendar_event_metadata_event_account_calendar_unique").on(table.googleEventId, table.accountId, table.calendarId),
  index("idx_calendar_event_metadata_owner").on(table.ownerUserId),
  index("idx_calendar_event_metadata_principal_account").on(table.principalAccountId),
  check("calendar_event_metadata_agent_join_mode_check", sql`${table.agentJoinMode} IS NULL OR ${table.agentJoinMode} IN ('dont_join', 'note_taking', 'join_and_talk')`),
]);

export const insertCalendarEventMetadataSchema = createInsertSchema(calendarEventMetadata).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type CalendarEventMetadata = typeof calendarEventMetadata.$inferSelect;
export type InsertCalendarEventMetadata = z.infer<typeof insertCalendarEventMetadataSchema>;

export const calendarEventPeople = pgTable("calendar_event_people", {
  id: serial("id").primaryKey(),
  metadataId: integer("metadata_id").notNull().references(() => calendarEventMetadata.id, { onDelete: "cascade" }),
  ownerUserId: text("owner_user_id"),
  principalAccountId: text("principal_account_id"),
  vaultId: text("vault_id"),
  personId: text("person_id").notNull(),
  personName: text("person_name").notNull(),
  attendeeEmail: text("attendee_email"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  unique("calendar_event_people_metadata_person_unique").on(table.metadataId, table.personId),
]);

export const insertCalendarEventPersonSchema = createInsertSchema(calendarEventPeople).omit({
  id: true,
  createdAt: true,
});

export type CalendarEventPerson = typeof calendarEventPeople.$inferSelect;
export type InsertCalendarEventPerson = z.infer<typeof insertCalendarEventPersonSchema>;


export const calendarEventArtifacts = pgTable("calendar_event_artifacts", {
  id: serial("id").primaryKey(),
  metadataId: integer("metadata_id").notNull().references(() => calendarEventMetadata.id, { onDelete: "cascade" }),
  ownerUserId: text("owner_user_id"),
  principalAccountId: text("principal_account_id"),
  vaultId: text("vault_id"),
  artifactType: text("artifact_type").notNull().default("library_page"),
  libraryPageId: text("library_page_id").notNull().references(() => libraryPages.id, { onDelete: "cascade" }),
  artifactKind: text("artifact_kind").notNull(),
  title: text("title"),
  source: text("source"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  unique("calendar_event_artifacts_metadata_page_unique").on(table.metadataId, table.libraryPageId),
  index("idx_calendar_event_artifacts_metadata").on(table.metadataId),
  index("idx_calendar_event_artifacts_owner").on(table.ownerUserId),
  index("idx_calendar_event_artifacts_principal_account").on(table.principalAccountId),
]);

export const insertCalendarEventArtifactSchema = createInsertSchema(calendarEventArtifacts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type CalendarEventArtifact = typeof calendarEventArtifacts.$inferSelect;
export type InsertCalendarEventArtifact = z.infer<typeof insertCalendarEventArtifactSchema>;

export const emailSyncLog = pgTable("email_sync_log", {
  id: serial("id").primaryKey(),
  accountId: text("account_id").notNull(),
  ownerUserId: text("owner_user_id"),
  principalAccountId: text("principal_account_id"),
  vaultId: text("vault_id"),
  syncStartedAt: timestamp("sync_started_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  syncCompletedAt: timestamp("sync_completed_at", { withTimezone: true }),
  messagesSynced: integer("messages_synced").default(0).notNull(),
  cursorState: text("cursor_state"),
  status: text("status").notNull().default("running"),
  errorMessage: text("error_message"),
  resyncReason: text("resync_reason"),
  reconciledCount: integer("reconciled_count").notNull().default(0),
}, (table) => [
  index("idx_email_sync_log_owner").on(table.ownerUserId),
  index("idx_email_sync_log_principal_account").on(table.principalAccountId),
  index("idx_email_sync_log_vault").on(table.vaultId),
]);

export const insertEmailSyncLogSchema = createInsertSchema(emailSyncLog).omit({
  id: true,
  syncStartedAt: true,
});

export type EmailSyncLog = typeof emailSyncLog.$inferSelect;
export type InsertEmailSyncLog = z.infer<typeof insertEmailSyncLogSchema>;

export const emailEnrichments = pgTable("email_enrichments", {
  id: serial("id").primaryKey(),
  providerThreadId: text("provider_thread_id").notNull(),
  accountId: text("account_id").notNull(),
  ownerUserId: text("owner_user_id"),
  principalAccountId: text("principal_account_id"),
  vaultId: text("vault_id"),
  messageId: integer("message_id").references(() => emailMessages.id),
  summary: text("summary").notNull().default(""),
  decisions: jsonb("decisions").$type<string[]>(),
  actions: jsonb("actions").$type<string[]>(),
  contextSnapshot: jsonb("context_snapshot").$type<Record<string, any>>(),
  dismissed: boolean("dismissed").default(false).notNull(),
  dismissReason: text("dismiss_reason"),
  model: text("model"),
  tokensUsed: integer("tokens_used"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  unique("email_enrichments_thread_account_unique").on(table.providerThreadId, table.accountId),
  index("idx_email_enrichments_owner").on(table.ownerUserId),
  index("idx_email_enrichments_principal_account").on(table.principalAccountId),
  index("idx_email_enrichments_vault").on(table.vaultId),
]);

export const insertEmailEnrichmentSchema = createInsertSchema(emailEnrichments).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type EmailEnrichment = typeof emailEnrichments.$inferSelect;
export type InsertEmailEnrichment = z.infer<typeof insertEmailEnrichmentSchema>;

export const emailDismissals = pgTable("email_dismissals", {
  id: serial("id").primaryKey(),
  messageId: integer("message_id").references(() => emailMessages.id),
  providerThreadId: text("provider_thread_id").notNull(),
  accountId: text("account_id").notNull(),
  ownerUserId: text("owner_user_id"),
  principalAccountId: text("principal_account_id"),
  vaultId: text("vault_id"),
  tier: text("tier").notNull(),
  sender: text("sender"),
  subject: text("subject"),
  reason: text("reason").notNull(),
  dismissedBy: text("dismissed_by").notNull().default("auto"),
  dismissedAt: timestamp("dismissed_at", { withTimezone: true, precision: 6 }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_email_dismissals_owner").on(table.ownerUserId),
  index("idx_email_dismissals_principal_account").on(table.principalAccountId),
  index("idx_email_dismissals_vault").on(table.vaultId),
]);

export const insertEmailDismissalSchema = createInsertSchema(emailDismissals).omit({
  id: true,
  dismissedAt: true,
});

export type EmailDismissal = typeof emailDismissals.$inferSelect;
export type InsertEmailDismissal = z.infer<typeof insertEmailDismissalSchema>;

export const sessionTree = pgTable("session_tree", {
  sessionId: text("session_id").primaryKey(),
  parentSessionId: text("parent_session_id"),
  spawnReason: text("spawn_reason"),
  spawnerTool: text("spawner_tool"),
  spawnerSkillRun: text("spawner_skill_run"),
  spawnStatus: text("spawn_status").notNull().default("succeeded"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_session_tree_parent").on(table.parentSessionId),
  // Partial unique index: only one non-terminal spawn per (parent, reason, skillRun).
  // Failed/succeeded spawns don't block retries.
  // Note: The old uk_session_tree_spawn_idem is dropped in migration and replaced by this.
  // Drizzle schema defines intent; actual constraint is managed by migration SQL.
]);

export const insertSessionTreeSchema = createInsertSchema(sessionTree).omit({
  createdAt: true,
  updatedAt: true,
});

export type SessionTreeRow = typeof sessionTree.$inferSelect;
export type InsertSessionTree = z.infer<typeof insertSessionTreeSchema>;

// ---------------------------------------------------------------------------
// Session Output Buffer
// Rolling log of the last 50 sessions — captures title, topics, and what
// was produced (library pages created/updated, people touched). Retained as
// bounded source material for REM dream generation; HISTORY owns bootstrap
// chronology.
// ---------------------------------------------------------------------------
export const sessionOutputBuffer = pgTable("session_output_buffer", {
  id: serial("id").primaryKey(),
  sessionId: text("session_id").notNull().unique(),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  sessionType: text("session_type").notNull().default("user"),
  title: text("title"),
  topics: text("topics").array().notNull().default(sql`'{}'::text[]`),
  pagesCreated: text("pages_created").array().notNull().default(sql`'{}'::text[]`),
  pagesUpdated: text("pages_updated").array().notNull().default(sql`'{}'::text[]`),
  peopleTouched: text("people_touched").array().notNull().default(sql`'{}'::text[]`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_session_output_buffer_created_at").on(table.createdAt),
  index("idx_session_output_buffer_owner").on(table.ownerUserId),
  index("idx_session_output_buffer_account").on(table.accountId),
]);

export const insertSessionOutputBufferSchema = createInsertSchema(sessionOutputBuffer).omit({
  id: true,
  createdAt: true,
});

export type SessionOutputBufferRow = typeof sessionOutputBuffer.$inferSelect;
export type InsertSessionOutputBuffer = z.infer<typeof insertSessionOutputBufferSchema>;

// ---------------------------------------------------------------------------
// Session Artifacts
// Structural, bidirectional linking between sessions and the artifacts they
// produce. Recorded at the tool layer the moment an artifact is created.
// Replaces regex-based extraction and outputRef strings.
// ---------------------------------------------------------------------------
export const sessionArtifacts = pgTable("session_artifacts", {
  id: serial("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  artifactType: text("artifact_type").notNull(),
  artifactId: text("artifact_id").notNull(),
  /** Canonical target identity; legacy type/id remain execution/scoring compatibility. */
  artifactAddress: text("artifact_address"),
  /** Generic explicit produced assertion created from this compatibility row. */
  addressLinkId: uuid("address_link_id"),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_session_artifacts_unique").on(table.sessionId, table.artifactType, table.artifactId),
  index("idx_session_artifacts_session").on(table.sessionId),
  index("idx_session_artifacts_artifact").on(table.artifactType, table.artifactId),
  index("idx_session_artifacts_address").on(table.ownerUserId, table.accountId, table.artifactAddress),
  index("idx_session_artifacts_owner").on(table.ownerUserId),
  index("idx_session_artifacts_account").on(table.accountId),
]);

export type SessionArtifactRow = typeof sessionArtifacts.$inferSelect;

// ---------------------------------------------------------------------------
// Plan Executions
// Database-backed plan state. The Library page is a rendered view, never read
// as the source of truth for execution decisions.
// ---------------------------------------------------------------------------
export const planExecutions = pgTable("plan_executions", {
  id: text("id").primaryKey(),
  pageId: text("page_id").notNull(),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  status: text("status").notNull().default("created"),
  originSessionId: text("origin_session_id").notNull(),
  blocking: boolean("blocking").notNull().default(true),
  workspace: text("workspace"),
  workspaceDir: text("workspace_dir"),
  goalId: text("goal_id"),
  projectId: integer("project_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  executionLeaseId: text("execution_lease_id"),
  executionLeaseOwner: text("execution_lease_owner"),
  executionLeaseExpiresAt: timestamp("execution_lease_expires_at", { withTimezone: true }),
  executionClaimedAt: timestamp("execution_claimed_at", { withTimezone: true }),
}, (table) => [
  index("idx_plan_executions_status").on(table.status),
  index("idx_plan_executions_archived_at").on(table.archivedAt),
  index("idx_plan_executions_origin_session_id").on(table.originSessionId),
  index("idx_plan_executions_owner").on(table.ownerUserId),
  index("idx_plan_executions_account").on(table.accountId),
  index("idx_plan_executions_lease").on(table.executionLeaseExpiresAt),
]);

export const insertPlanExecutionSchema = createInsertSchema(planExecutions).omit({
  createdAt: true,
  updatedAt: true,
});

export type PlanExecutionRow = typeof planExecutions.$inferSelect;
export type InsertPlanExecution = z.infer<typeof insertPlanExecutionSchema>;

// ---------------------------------------------------------------------------
// Plan Steps
// Individual steps within a plan execution. Composite PK on (planId, id).
// ---------------------------------------------------------------------------
export const planSteps = pgTable("plan_steps", {
  id: text("id").notNull(),
  planId: text("plan_id").notNull().references(() => planExecutions.id, { onDelete: "cascade" }),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  position: integer("position").notNull(),
  title: text("title").notNull(),
  instructions: text("instructions"),
  persona: text("persona"),
  status: text("status").notNull().default("pending"),
  sessionId: text("session_id"),
  outcome: text("outcome"),
  error: text("error"),
  durationSeconds: integer("duration_seconds"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  totalAttempts: integer("total_attempts").default(0),
  timeoutMinutes: integer("timeout_minutes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_plan_steps_plan_id").on(table.planId),
  index("idx_plan_steps_owner").on(table.ownerUserId),
  index("idx_plan_steps_account").on(table.accountId),
  primaryKey({ columns: [table.planId, table.id] }),
]);

export type PlanStepRow = typeof planSteps.$inferSelect;

export const insertPlanStepSchema = createInsertSchema(planSteps).omit({
  createdAt: true,
  updatedAt: true,
});

export type InsertPlanStep = z.infer<typeof insertPlanStepSchema>;

// ---------------------------------------------------------------------------
// Plan Session Links
// Durable session associations for inline plan widgets. origin_session_id remains
// immutable provenance; visibility/placement belongs here.
// ---------------------------------------------------------------------------
export const planSessionLinks = pgTable("plan_session_links", {
  id: serial("id").primaryKey(),
  planId: text("plan_id").notNull().references(() => planExecutions.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull(),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  anchorMessageId: text("anchor_message_id"),
  linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
  unlinkedAt: timestamp("unlinked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_plan_session_links_plan").on(table.planId),
  index("idx_plan_session_links_session").on(table.sessionId),
  index("idx_plan_session_links_owner").on(table.ownerUserId),
  index("idx_plan_session_links_account").on(table.accountId),
  uniqueIndex("idx_plan_session_links_active_unique").on(table.planId, table.sessionId).where(sql`unlinked_at IS NULL`),
]);

export type PlanSessionLinkRow = typeof planSessionLinks.$inferSelect;
export type InsertPlanSessionLink = typeof planSessionLinks.$inferInsert;

// ---------------------------------------------------------------------------
// Plan Step Attempts
// One durable child-session attempt per plan step execution or retry.
// ---------------------------------------------------------------------------
export const planStepAttempts = pgTable("plan_step_attempts", {
  id: serial("id").primaryKey(),
  planId: text("plan_id").notNull().references(() => planExecutions.id, { onDelete: "cascade" }),
  stepId: text("step_id").notNull(),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  attemptNumber: integer("attempt_number").notNull(),
  childSessionId: text("child_session_id"),
  status: text("status").notNull().default("pending"),
  outcome: text("outcome"),
  error: text("error"),
  durationSeconds: integer("duration_seconds"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_plan_step_attempts_plan").on(table.planId),
  index("idx_plan_step_attempts_step").on(table.planId, table.stepId),
  index("idx_plan_step_attempts_child_session").on(table.childSessionId),
  index("idx_plan_step_attempts_owner").on(table.ownerUserId),
  index("idx_plan_step_attempts_account").on(table.accountId),
  uniqueIndex("idx_plan_step_attempts_attempt_unique").on(table.planId, table.stepId, table.attemptNumber),
]);

export type PlanStepAttemptRow = typeof planStepAttempts.$inferSelect;
export type InsertPlanStepAttempt = typeof planStepAttempts.$inferInsert;

// ---------------------------------------------------------------------------
// Plan Step Reviews
// Durable human-review gates bound to one exact Plan step attempt.
// ---------------------------------------------------------------------------
export const planStepReviews = pgTable("plan_step_reviews", {
  id: serial("id").primaryKey(),
  planId: text("plan_id").notNull().references(() => planExecutions.id, { onDelete: "cascade" }),
  stepId: text("step_id").notNull(),
  attemptId: integer("attempt_id").references(() => planStepAttempts.id, { onDelete: "set null" }),
  ownerUserId: text("owner_user_id").notNull(),
  accountId: text("account_id").notNull(),
  status: text("status").notNull().default("open"),
  prompt: text("prompt").notNull(),
  detail: text("detail"),
  decision: text("decision"),
  decisionReason: text("decision_reason"),
  openedBySessionId: text("opened_by_session_id"),
  resolvedByUserId: text("resolved_by_user_id"),
  resolvedBySessionId: text("resolved_by_session_id"),
  resolutionSource: text("resolution_source"),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_plan_step_reviews_plan").on(table.planId),
  index("idx_plan_step_reviews_step").on(table.planId, table.stepId),
  index("idx_plan_step_reviews_attempt").on(table.attemptId),
  index("idx_plan_step_reviews_owner").on(table.ownerUserId),
  index("idx_plan_step_reviews_account").on(table.accountId),
  uniqueIndex("idx_plan_step_reviews_open_unique").on(table.planId, table.stepId).where(sql`status = 'open'`),
  check("chk_plan_step_reviews_status", sql`${table.status} IN ('open', 'resolved')`),
  check("chk_plan_step_reviews_decision", sql`${table.decision} IS NULL OR ${table.decision} IN (${sql.join(PLAN_REVIEW_DECISIONS.map((decision) => sql`${decision}`), sql`, `)})`),
  check("chk_plan_step_reviews_resolution", sql`(${table.status} = 'open' AND ${table.decision} IS NULL AND ${table.resolvedAt} IS NULL AND ${table.resolvedByUserId} IS NULL) OR (${table.status} = 'resolved' AND ${table.decision} IS NOT NULL AND ${table.resolvedAt} IS NOT NULL AND ${table.resolvedByUserId} IS NOT NULL)`),
]);

export type PlanStepReviewRow = typeof planStepReviews.$inferSelect;
export type InsertPlanStepReview = typeof planStepReviews.$inferInsert;

// ---------------------------------------------------------------------------
// Workflow System
// Reusable lifecycle templates and durable workflow run state. PostgreSQL is
// the execution source of truth; Library pages are rendered checkpoints only.
// ---------------------------------------------------------------------------
export const workflowTemplateStatuses = ["draft", "active", "deprecated"] as const;
export const workflowRunStatuses = ["draft", "active", "blocked", "needs_review", "completed", "failed", "canceled", "paused"] as const;
export const workflowStageStatuses = ["pending", "active", "passed", "failed", "blocked", "skipped", "needs_review"] as const;
export const workflowAttemptResults = [
  "passed",
  "changes_requested",
  "product_failure",
  "specification_failure",
  "continue",
  "update_docs",
  "gate",
  "fail_back",
  "failed",
  "blocked",
  "skipped",
  "needs_review",
] as const;
export const workflowAutonomyModes = ["autonomous", "requires_user_review", "requires_agent_review", "manual_external"] as const;
export const workflowTransitionTriggers = ["autonomous", "agent_review", "user_review", "system", "manual"] as const;
export const workflowArtifactKinds = ["spec", "plan", "pr", "commit", "deployment", "screenshot", "logs", "review", "docs", "calibration", "acceptance", "library_page", "session", "other"] as const;
export const workflowGateStatuses = ["open", "approved", "rejected", "canceled"] as const;

export const workflowTemplateStatusSchema = z.enum(workflowTemplateStatuses);
export const workflowRunStatusSchema = z.enum(workflowRunStatuses);
export const workflowStageStatusSchema = z.enum(workflowStageStatuses);
export const workflowAttemptResultSchema = z.enum(workflowAttemptResults);
export const workflowAutonomyModeSchema = z.enum(workflowAutonomyModes);
export const workflowStagePersonaSchema = z.enum(["Engineer", "Architect", "Default"]);
export const workflowTransitionTriggerSchema = z.enum(workflowTransitionTriggers);
export const workflowArtifactKindSchema = z.enum(workflowArtifactKinds);
export const workflowGateStatusSchema = z.enum(workflowGateStatuses);

export const workflowStageDefinitionSchema = z.object({
  key: z.string().trim().min(1),
  title: z.string().trim().min(1),
  position: z.number().int().nonnegative(),
  autonomyMode: workflowAutonomyModeSchema,
  persona: workflowStagePersonaSchema.default("Default"),
  entryCriteria: z.array(z.string()).optional(),
  exitCriteria: z.array(z.string()).optional(),
  evidenceRequirements: z.array(z.string()).optional(),
  maxAttempts: z.number().int().positive().optional(),
  allowedTransitions: z.array(z.object({
    toStageKey: z.string().nullable(),
    on: workflowAttemptResultSchema,
    reason: z.string().optional(),
  })).default([]),
});

export const workflowTemplateDefinitionSchema = z.object({
  stages: z.array(workflowStageDefinitionSchema).default([]),
  terminalStatuses: z.array(z.string()).default(["completed", "failed", "canceled"]),
});

export type WorkflowTemplateDefinition = z.infer<typeof workflowTemplateDefinitionSchema>;
export type WorkflowStageDefinition = z.infer<typeof workflowStageDefinitionSchema>;
export type WorkflowRunStatus = z.infer<typeof workflowRunStatusSchema>;
export type WorkflowStageStatus = z.infer<typeof workflowStageStatusSchema>;
export type WorkflowAttemptResult = z.infer<typeof workflowAttemptResultSchema>;
export type WorkflowAutonomyMode = z.infer<typeof workflowAutonomyModeSchema>;
export type WorkflowTransitionTrigger = z.infer<typeof workflowTransitionTriggerSchema>;

export const workflowTemplates = pgTable("workflow_templates", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  description: text("description").notNull().default(""),
  version: text("version").notNull().default("1.0"),
  status: text("status").notNull().default("draft"),
  definition: jsonb("definition").notNull().default({}),
  defaultAutonomyPolicy: jsonb("default_autonomy_policy").notNull().default({}),
  enabled: boolean("enabled").notNull().default(true),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_workflow_templates_type_status").on(table.type, table.status),
  index("idx_workflow_templates_scope_owner").on(table.scope, table.ownerUserId),
  index("idx_workflow_templates_account").on(table.accountId),
]);

export const workflowRuns = pgTable("workflow_runs", {
  id: text("id").primaryKey(),
  templateId: text("template_id").notNull().references(() => workflowTemplates.id, { onDelete: "restrict" }),
  title: text("title").notNull(),
  objective: text("objective").notNull(),
  status: text("status").notNull().default("draft"),
  currentStageKey: text("current_stage_key"),
  autonomyPolicy: jsonb("autonomy_policy").notNull().default({}),
  retryPolicy: jsonb("retry_policy").notNull().default({ maxAttempts: 10 }),
  lifecycleSnapshot: jsonb("lifecycle_snapshot"),
  failurePacket: jsonb("failure_packet"),
  parentSessionId: text("parent_session_id"),
  linkedLibraryPageId: text("linked_library_page_id"),
  linkedPlanId: text("linked_plan_id").references(() => planExecutions.id, { onDelete: "set null" }),
  linkedProjectId: integer("linked_project_id"),
  linkedPlatformId: integer("linked_platform_id"),
  linkedProductId: integer("linked_product_id"),
  linkedEnvironmentId: integer("linked_environment_id"),
  createdBySessionId: text("created_by_session_id"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_workflow_runs_status").on(table.status),
  index("idx_workflow_runs_current_stage").on(table.currentStageKey),
  index("idx_workflow_runs_template").on(table.templateId),
  index("idx_workflow_runs_environment").on(table.linkedEnvironmentId),
  index("idx_workflow_runs_project").on(table.linkedProjectId),
  index("idx_workflow_runs_parent_session").on(table.parentSessionId),
  index("idx_workflow_runs_library_page").on(table.linkedLibraryPageId),
  index("idx_workflow_runs_owner_updated").on(table.ownerUserId, table.updatedAt),
  index("idx_workflow_runs_account_updated").on(table.accountId, table.updatedAt),
]);

export const workflowStageAttempts = pgTable("workflow_stage_attempts", {
  id: serial("id").primaryKey(),
  workflowRunId: text("workflow_run_id").notNull().references(() => workflowRuns.id, { onDelete: "cascade" }),
  stageKey: text("stage_key").notNull(),
  stageTitle: text("stage_title").notNull().default(""),
  attemptNumber: integer("attempt_number").notNull(),
  status: text("status").notNull().default("pending"),
  autonomyMode: text("autonomy_mode").notNull(),
  childSessionId: text("child_session_id"),
  linkedPlanId: text("linked_plan_id").references(() => planExecutions.id, { onDelete: "set null" }),
  inputContext: jsonb("input_context").notNull().default({}),
  evidence: jsonb("evidence").notNull().default({}),
  outputSummary: text("output_summary"),
  failureContext: jsonb("failure_context"),
  result: text("result"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  durationSeconds: integer("duration_seconds"),
  executionLeaseId: text("execution_lease_id"),
  executionLeaseOwner: text("execution_lease_owner"),
  executionLeaseExpiresAt: timestamp("execution_lease_expires_at", { withTimezone: true }),
  executionClaimedAt: timestamp("execution_claimed_at", { withTimezone: true }),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("uk_workflow_stage_attempt").on(table.workflowRunId, table.stageKey, table.attemptNumber),
  index("idx_workflow_stage_attempts_run").on(table.workflowRunId),
  index("idx_workflow_stage_attempts_stage").on(table.workflowRunId, table.stageKey),
  index("idx_workflow_stage_attempts_status").on(table.status),
  index("idx_workflow_stage_attempts_child_session").on(table.childSessionId),
  index("idx_workflow_stage_attempts_owner").on(table.ownerUserId),
  index("idx_workflow_stage_attempts_account").on(table.accountId),
  index("idx_workflow_stage_attempts_execution_lease").on(table.executionLeaseExpiresAt),
]);

export const workflowTransitions = pgTable("workflow_transitions", {
  id: serial("id").primaryKey(),
  workflowRunId: text("workflow_run_id").notNull().references(() => workflowRuns.id, { onDelete: "cascade" }),
  fromStageKey: text("from_stage_key"),
  toStageKey: text("to_stage_key"),
  fromAttemptId: integer("from_attempt_id").references(() => workflowStageAttempts.id, { onDelete: "set null" }),
  trigger: text("trigger").notNull(),
  reason: text("reason").notNull().default(""),
  evidence: jsonb("evidence").notNull().default({}),
  createdBySessionId: text("created_by_session_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
}, (table) => [
  index("idx_workflow_transitions_run_created").on(table.workflowRunId, table.createdAt),
  index("idx_workflow_transitions_to_stage").on(table.toStageKey),
  index("idx_workflow_transitions_owner").on(table.ownerUserId),
  index("idx_workflow_transitions_account").on(table.accountId),
]);

export const workflowArtifacts = pgTable("workflow_artifacts", {
  id: serial("id").primaryKey(),
  workflowRunId: text("workflow_run_id").notNull().references(() => workflowRuns.id, { onDelete: "cascade" }),
  stageAttemptId: integer("stage_attempt_id").references(() => workflowStageAttempts.id, { onDelete: "set null" }),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  refType: text("ref_type").notNull().default("text"),
  refId: text("ref_id"),
  /** Canonical target identity; legacy ref_type/ref_id remain workflow compatibility. */
  artifactAddress: text("artifact_address"),
  /** Generic explicit produced assertion created from this compatibility row. */
  addressLinkId: uuid("address_link_id"),
  url: text("url"),
  summary: text("summary").notNull().default(""),
  metadata: jsonb("metadata").notNull().default({}),
  createdBySessionId: text("created_by_session_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
}, (table) => [
  index("idx_workflow_artifacts_run").on(table.workflowRunId),
  index("idx_workflow_artifacts_stage").on(table.stageAttemptId),
  index("idx_workflow_artifacts_kind").on(table.kind),
  index("idx_workflow_artifacts_address").on(table.ownerUserId, table.accountId, table.artifactAddress),
  index("idx_workflow_artifacts_owner").on(table.ownerUserId),
  index("idx_workflow_artifacts_account").on(table.accountId),
]);

export const workflowGates = pgTable("workflow_gates", {
  id: serial("id").primaryKey(),
  workflowRunId: text("workflow_run_id").notNull().references(() => workflowRuns.id, { onDelete: "cascade" }),
  stageAttemptId: integer("stage_attempt_id").references(() => workflowStageAttempts.id, { onDelete: "cascade" }),
  gateType: text("gate_type").notNull(),
  status: text("status").notNull().default("open"),
  prompt: text("prompt").notNull(),
  decision: text("decision"),
  decisionReason: text("decision_reason"),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedByUserId: text("resolved_by_user_id"),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
}, (table) => [
  index("idx_workflow_gates_run_status").on(table.workflowRunId, table.status),
  index("idx_workflow_gates_stage").on(table.stageAttemptId),
  index("idx_workflow_gates_owner").on(table.ownerUserId),
  index("idx_workflow_gates_account").on(table.accountId),
]);

export const workflowSessions = pgTable("workflow_sessions", {
  id: serial("id").primaryKey(),
  workflowRunId: text("workflow_run_id").notNull().references(() => workflowRuns.id, { onDelete: "cascade" }),
  stageAttemptId: integer("stage_attempt_id").references(() => workflowStageAttempts.id, { onDelete: "set null" }),
  sessionId: text("session_id").notNull(),
  role: text("role").notNull(),
  spawnReason: text("spawn_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
}, (table) => [
  unique("uk_workflow_session").on(table.workflowRunId, table.sessionId),
  index("idx_workflow_sessions_run").on(table.workflowRunId),
  index("idx_workflow_sessions_session").on(table.sessionId),
  index("idx_workflow_sessions_stage").on(table.stageAttemptId),
  index("idx_workflow_sessions_owner").on(table.ownerUserId),
  index("idx_workflow_sessions_account").on(table.accountId),
]);

export type WorkflowTemplate = typeof workflowTemplates.$inferSelect;
export type WorkflowRun = typeof workflowRuns.$inferSelect;
export type WorkflowStageAttempt = typeof workflowStageAttempts.$inferSelect;
export type WorkflowTransition = typeof workflowTransitions.$inferSelect;
export type WorkflowArtifact = typeof workflowArtifacts.$inferSelect;
export type WorkflowGate = typeof workflowGates.$inferSelect;
export type WorkflowSession = typeof workflowSessions.$inferSelect;

export const insertWorkflowTemplateSchema = createInsertSchema(workflowTemplates).omit({ createdAt: true, updatedAt: true });
export const insertWorkflowRunSchema = createInsertSchema(workflowRuns).omit({ createdAt: true, updatedAt: true });

// ─── Meeting Turn Orchestration ───

export const meetingTurnAssemblyStatuses = ["collecting", "complete"] as const;
export const meetingTurnParticipationStatuses = ["pending", "claimed", "respond", "silent", "failed"] as const;
export const meetingTurnExecutionStatuses = ["waiting", "pending", "claimed", "completed", "failed", "not_applicable"] as const;
export const meetingTurnEnrollmentStatuses = ["pending", "enrolled", "failed"] as const;

/**
 * Durable handoff from the canonical transcript document into turn orchestration.
 * Transcript text remains in the session document; this sidecar stores only the
 * replay-safe enrollment metadata and outcome.
 */
export const meetingTurnEnrollments = pgTable("meeting_turn_enrollments", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: text("session_id").notNull(),
  sessionKey: text("session_key").notNull(),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id").notNull(),
  accountId: text("account_id").notNull(),
  sourceTurnId: text("source_turn_id").notNull(),
  sourceMessageId: text("source_message_id").notNull(),
  speakerKey: text("speaker_key").notNull(),
  speakerLabel: text("speaker_label").notNull(),
  participationMode: text("participation_mode").notNull().default("contextual"),
  executionAffinityBootId: text("execution_affinity_boot_id"),
  status: text("status", { enum: meetingTurnEnrollmentStatuses }).notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  enrolledTurnId: uuid("enrolled_turn_id"),
  postgresCode: text("postgres_code"),
  errorType: text("error_type"),
  enrolledAt: timestamp("enrolled_at", { withTimezone: true }),
  failedAt: timestamp("failed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uk_meeting_turn_enrollment_source")
    .on(table.ownerUserId, table.accountId, table.sessionId, table.sourceTurnId),
  index("idx_meeting_turn_enrollments_due").on(table.status, table.nextAttemptAt),
  index("idx_meeting_turn_enrollments_session").on(table.sessionId, table.createdAt),
  index("idx_meeting_turn_enrollments_owner").on(table.ownerUserId),
  index("idx_meeting_turn_enrollments_account").on(table.accountId),
  check("meeting_turn_enrollments_status_check", sql`${table.status} IN ('pending', 'enrolled', 'failed')`),
  check("meeting_turn_enrollments_participation_mode_check", sql`${table.participationMode} IN ('contextual', 'always')`),
]);

export type MeetingTurnEnrollment = typeof meetingTurnEnrollments.$inferSelect;

/**
 * Durable orchestration for live-meeting turns. Transcript words remain canonical
 * in the session document; this table owns grouping, participation, and execution.
 */
export const meetingTurns = pgTable("meeting_turns", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: text("session_id").notNull(),
  sessionKey: text("session_key").notNull(),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id").notNull(),
  accountId: text("account_id").notNull(),
  speakerKey: text("speaker_key").notNull(),
  speakerLabel: text("speaker_label").notNull(),
  participationMode: text("participation_mode").notNull().default("contextual"),
  executionAffinityBootId: text("execution_affinity_boot_id"),
  text: text("text").notNull(),
  sourceTurnIds: text("source_turn_ids").array().notNull().default(sql`'{}'::text[]`),
  sourceMessageIds: text("source_message_ids").array().notNull().default(sql`'{}'::text[]`),
  revision: integer("revision").notNull().default(1),
  assemblyStatus: text("assembly_status", { enum: meetingTurnAssemblyStatuses }).notNull().default("collecting"),
  participationStatus: text("participation_status", { enum: meetingTurnParticipationStatuses }).notNull().default("pending"),
  executionStatus: text("execution_status", { enum: meetingTurnExecutionStatuses }).notNull().default("waiting"),
  participationDecision: jsonb("participation_decision"),
  prompt: text("prompt"),
  completenessDeferrals: integer("completeness_deferrals").notNull().default(0),
  readyAt: timestamp("ready_at", { withTimezone: true }).notNull(),
  firstFragmentAt: timestamp("first_fragment_at", { withTimezone: true }).notNull().defaultNow(),
  lastFragmentAt: timestamp("last_fragment_at", { withTimezone: true }).notNull().defaultNow(),
  claimToken: text("claim_token"),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
  attemptCount: integer("attempt_count").notNull().default(0),
  assistantMessageId: text("assistant_message_id"),
  error: text("error"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_meeting_turns_ready").on(table.assemblyStatus, table.readyAt),
  index("idx_meeting_turns_session").on(table.sessionId, table.createdAt),
  index("idx_meeting_turns_owner").on(table.ownerUserId),
  index("idx_meeting_turns_account").on(table.accountId),
  index("idx_meeting_turns_affinity").on(table.executionAffinityBootId),
  uniqueIndex("idx_meeting_turns_claimed_session")
    .on(table.sessionId)
    .where(sql`${table.executionStatus} = 'claimed'`),
]);

export type MeetingTurn = typeof meetingTurns.$inferSelect;

// ─── Meeting Recap Distributions ───

export const meetingRecapDistributionStatuses = [
  "pending",
  "draft_created",
  "sent",
  "failed",
] as const;
export type MeetingRecapDistributionStatus = typeof meetingRecapDistributionStatuses[number];

export const meetingRecapDistributions = pgTable("meeting_recap_distributions", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: text("session_id").notNull(),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  scope: text("scope").notNull().default("user"),
  attendeeEmail: text("attendee_email").notNull(),
  attendeeName: text("attendee_name"),
  recipientPersonId: text("recipient_person_id").references(() => persons.id, { onDelete: "restrict" }),
  isMantraUser: boolean("is_mantra_user").notNull().default(false),
  accessTokenHash: text("access_token_hash"),
  accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }),
  accessRevokedAt: timestamp("access_revoked_at", { withTimezone: true }),
  onboardingTokenHash: text("onboarding_token_hash"),
  draftId: uuid("draft_id"),
  sendMethod: text("send_method").notNull().default("gmail_draft"),
  status: text("status", { enum: meetingRecapDistributionStatuses }).notNull().default("pending"),
  error: text("error"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  discardedAt: timestamp("discarded_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_mrd_session").on(table.sessionId),
  uniqueIndex("idx_mrd_access_token_hash_unique").on(table.accessTokenHash),
  uniqueIndex("idx_mrd_onboarding_token_hash_unique").on(table.onboardingTokenHash),
  index("idx_mrd_owner").on(table.ownerUserId),
  index("idx_mrd_account").on(table.accountId),
  unique("unique_mrd_session_attendee").on(table.accountId, table.sessionId, table.attendeeEmail),
  index("idx_mrd_status_account").on(table.accountId, table.status),
]);

export type MeetingRecapDistribution = typeof meetingRecapDistributions.$inferSelect;
export const insertMeetingRecapDistributionSchema = createInsertSchema(meetingRecapDistributions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
