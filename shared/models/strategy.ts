import { pgTable, text, timestamp, jsonb, real, integer, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { sql } from "drizzle-orm";

export const strategyMoveStatuses = ["unexplored", "explored", "terminal"] as const;
export type StrategyMoveStatus = typeof strategyMoveStatuses[number];

export const strategyMoveSources = ["manual", "simulated"] as const;
export type StrategyMoveSource = typeof strategyMoveSources[number];

export const strategyContextTypes = ["historical", "current_position"] as const;
export type StrategyContextType = typeof strategyContextTypes[number];

export const simulationModes = ["clear_and_simulate", "update"] as const;
export type SimulationMode = typeof simulationModes[number];

export const simulationStatuses = ["running", "completed", "cancelled", "error"] as const;
export type SimulationStatus = typeof simulationStatuses[number];

export const strategies = pgTable("strategy_goals", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  currentMoveInstanceId: text("current_move_instance_id"),
  archived: boolean("archived").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_strategy_goals_scope_owner").on(table.scope, table.ownerUserId),
  index("idx_strategy_goals_account").on(table.accountId),
]);

export const strategyActors = pgTable("strategy_actors", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  goalId: text("goal_id").notNull().references(() => strategies.id, { onDelete: "cascade" }),
  personId: text("person_id").notNull(),
  name: text("name").notNull(),
  notes: text("notes").notNull().default(""),
  influence: real("influence").notNull().default(0.5),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_strategy_actors_goal").on(table.goalId),
]);

export const strategyMoveDefinitions = pgTable("strategy_move_definitions", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  goalId: text("goal_id").notNull().references(() => strategies.id, { onDelete: "cascade" }),
  actorId: text("actor_id").notNull().references(() => strategyActors.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_strategy_move_defs_goal").on(table.goalId),
  index("idx_strategy_move_defs_actor").on(table.actorId),
]);

export const strategyMoveInstances = pgTable("strategy_move_instances", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  refId: text("ref_id").notNull().default(""),
  goalId: text("goal_id").notNull().references(() => strategies.id, { onDelete: "cascade" }),
  parentMoveInstanceId: text("parent_move_instance_id"),
  parentStateId: text("parent_state_id"),
  terminatingStateId: text("terminating_state_id"),
  moveDefinitionId: text("move_definition_id").references(() => strategyMoveDefinitions.id, { onDelete: "set null" }),
  actorId: text("actor_id").references(() => strategyActors.id, { onDelete: "set null" }),
  title: text("title").notNull().default(""),
  description: text("description").notNull().default(""),
  evaluation: text("evaluation").notNull().default(""),
  impact: text("impact").notNull().default(""),
  probability: real("probability").notNull().default(0.5),
  baseProbability: real("base_probability").notNull().default(0.5),
  depth: integer("depth").notNull().default(0),
  path: text("path").notNull().default(""),
  status: text("status").notNull().default("unexplored"),
  actorStates: jsonb("actor_states").notNull().default(sql`'[]'::jsonb`),
  source: text("source").notNull().default("manual"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_strategy_move_inst_goal").on(table.goalId),
  index("idx_strategy_move_inst_parent").on(table.parentMoveInstanceId),
  index("idx_strategy_move_inst_parent_state").on(table.parentStateId),
  index("idx_strategy_move_inst_terminating_state").on(table.terminatingStateId),
  index("idx_strategy_move_inst_path").on(table.path),
  index("idx_strategy_move_inst_def").on(table.moveDefinitionId),
  index("idx_strategy_move_inst_actor").on(table.actorId),
]);

export const strategyStates = pgTable("strategy_states", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  goalId: text("goal_id").notNull().references(() => strategies.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_strategy_states_goal").on(table.goalId),
]);

export const strategyMoveEndConditionEffectValues = ["satisfies", "blocks", "none"] as const;
export type StrategyMoveEndConditionEffectValue = typeof strategyMoveEndConditionEffectValues[number];

export const strategyMoveEndConditionEffects = pgTable("strategy_move_end_condition_effects", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  moveInstanceId: text("move_instance_id").notNull().references(() => strategyMoveInstances.id, { onDelete: "cascade" }),
  endConditionId: text("end_condition_id").notNull().references(() => strategyEndConditions.id, { onDelete: "cascade" }),
  effect: text("effect").notNull(),
}, (table) => [
  index("idx_strategy_move_ec_effects_move").on(table.moveInstanceId),
  index("idx_strategy_move_ec_effects_ec").on(table.endConditionId),
  uniqueIndex("uniq_strategy_move_ec_effects").on(table.moveInstanceId, table.endConditionId),
]);

export const strategyAssumptions = pgTable("strategy_assumptions", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  goalId: text("goal_id").notNull().references(() => strategies.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  probability: real("probability").notNull().default(0.5),
  affectedMoveIds: text("affected_move_ids").array().default(sql`'{}'::text[]`),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_strategy_assumptions_goal").on(table.goalId),
]);

export const assumptionLinkPolarityValues = ["positive", "negative"] as const;
export type AssumptionLinkPolarity = (typeof assumptionLinkPolarityValues)[number];

export const strategyAssumptionLinks = pgTable("strategy_assumption_links", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  assumptionId: text("assumption_id").notNull().references(() => strategyAssumptions.id, { onDelete: "cascade" }),
  moveInstanceId: text("move_instance_id").notNull().references(() => strategyMoveInstances.id, { onDelete: "cascade" }),
  polarity: text("polarity").notNull().default("positive"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_strategy_assumption_links_assumption").on(table.assumptionId),
  index("idx_strategy_assumption_links_move").on(table.moveInstanceId),
  uniqueIndex("uniq_strategy_assumption_links").on(table.assumptionId, table.moveInstanceId),
]);

export const strategyEndConditions = pgTable("strategy_end_conditions", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  goalId: text("goal_id").notNull().references(() => strategies.id, { onDelete: "cascade" }),
  description: text("description").notNull(),
  isRequired: boolean("is_required").notNull().default(false),
  isSatisfied: boolean("is_satisfied").notNull().default(false),
}, (table) => [
  index("idx_strategy_end_conditions_goal").on(table.goalId),
]);

export const strategyContextEntries = pgTable("strategy_context_entries", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  goalId: text("goal_id").notNull().references(() => strategies.id, { onDelete: "cascade" }),
  type: text("type").notNull().default("historical"),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_strategy_context_entries_goal").on(table.goalId),
]);

export const strategyArtifacts = pgTable("strategy_artifacts", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  goalId: text("goal_id").notNull().references(() => strategies.id, { onDelete: "cascade" }),
  fileName: text("file_name").notNull(),
  fileSize: integer("file_size").notNull().default(0),
  contentType: text("content_type").notNull().default("application/octet-stream"),
  objectPath: text("object_path").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_strategy_artifacts_goal").on(table.goalId),
]);

export const simulationProgressSchema = z.object({
  movesProcessed: z.number().default(0),
  movesTotal: z.number().default(0),
  currentDepth: z.number().default(0),
  currentMoveName: z.string().default(""),
});

export type SimulationProgress = z.infer<typeof simulationProgressSchema>;

export const strategySimulationRuns = pgTable("strategy_simulation_runs", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  goalId: text("goal_id").notNull().references(() => strategies.id, { onDelete: "cascade" }),
  rootMoveInstanceId: text("root_move_instance_id").notNull().references(() => strategyMoveInstances.id, { onDelete: "cascade" }),
  mode: text("mode").notNull(),
  status: text("status").notNull().default("running"),
  progress: jsonb("progress").default({ movesProcessed: 0, movesTotal: 0, currentDepth: 0, currentMoveName: "" }),
  startedAt: timestamp("started_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  error: text("error"),
}, (table) => [
  index("idx_strategy_sim_runs_goal").on(table.goalId),
  index("idx_strategy_sim_runs_status").on(table.status),
]);

export const insertStrategySchema = createInsertSchema(strategies).omit({
  id: true,
  scope: true,
  ownerUserId: true,
  accountId: true,
  createdAt: true,
  updatedAt: true,
});

export const insertStrategyActorSchema = createInsertSchema(strategyActors).omit({
  id: true,
  createdAt: true,
});

export const insertStrategyMoveDefinitionSchema = createInsertSchema(strategyMoveDefinitions).omit({
  id: true,
  createdAt: true,
});

export const insertStrategyMoveInstanceSchema = createInsertSchema(strategyMoveInstances).omit({
  id: true,
  refId: true,
  createdAt: true,
});

export const insertStrategyAssumptionSchema = createInsertSchema(strategyAssumptions).omit({
  id: true,
  createdAt: true,
});

export const insertStrategyEndConditionSchema = createInsertSchema(strategyEndConditions).omit({
  id: true,
});

export const insertStrategyContextEntrySchema = createInsertSchema(strategyContextEntries).omit({
  id: true,
  createdAt: true,
});

export const insertStrategySimulationRunSchema = createInsertSchema(strategySimulationRuns).omit({
  id: true,
  startedAt: true,
  completedAt: true,
});

export const insertStrategyArtifactSchema = createInsertSchema(strategyArtifacts).omit({
  id: true,
  createdAt: true,
});

export const insertStrategyStateSchema = createInsertSchema(strategyStates).omit({
  id: true,
  createdAt: true,
});

export const insertStrategyAssumptionLinkSchema = createInsertSchema(strategyAssumptionLinks).omit({
  id: true,
  createdAt: true,
}).extend({
  polarity: z.enum(assumptionLinkPolarityValues).default("positive"),
});

export const insertStrategyMoveEndConditionEffectSchema = createInsertSchema(strategyMoveEndConditionEffects).omit({
  id: true,
}).extend({
  effect: z.enum(strategyMoveEndConditionEffectValues),
});

export const actorStateSchema = z.object({
  actorId: z.string(),
  state: z.string(),
});
export type ActorState = z.infer<typeof actorStateSchema>;

export type Strategy = typeof strategies.$inferSelect;
export type InsertStrategy = z.infer<typeof insertStrategySchema>;

export type StrategyActor = typeof strategyActors.$inferSelect;
export type InsertStrategyActor = z.infer<typeof insertStrategyActorSchema>;

export type StrategyMoveDefinition = typeof strategyMoveDefinitions.$inferSelect;
export type InsertStrategyMoveDefinition = z.infer<typeof insertStrategyMoveDefinitionSchema>;

export type StrategyMoveInstance = typeof strategyMoveInstances.$inferSelect;
export type InsertStrategyMoveInstance = z.infer<typeof insertStrategyMoveInstanceSchema>;

export type StrategyAssumption = typeof strategyAssumptions.$inferSelect;
export type StrategyAssumptionLink = typeof strategyAssumptionLinks.$inferSelect;
export type InsertStrategyAssumptionLink = z.infer<typeof insertStrategyAssumptionLinkSchema>;
export type InsertStrategyAssumption = z.infer<typeof insertStrategyAssumptionSchema>;

export type StrategyEndCondition = typeof strategyEndConditions.$inferSelect;
export type InsertStrategyEndCondition = z.infer<typeof insertStrategyEndConditionSchema>;

export type StrategyContextEntry = typeof strategyContextEntries.$inferSelect;
export type InsertStrategyContextEntry = z.infer<typeof insertStrategyContextEntrySchema>;

export type StrategySimulationRun = typeof strategySimulationRuns.$inferSelect;
export type InsertStrategySimulationRun = z.infer<typeof insertStrategySimulationRunSchema>;

export type StrategyArtifact = typeof strategyArtifacts.$inferSelect;
export type InsertStrategyArtifact = z.infer<typeof insertStrategyArtifactSchema>;

export type StrategyState = typeof strategyStates.$inferSelect;
export type InsertStrategyState = z.infer<typeof insertStrategyStateSchema>;

export type StrategyMoveEndConditionEffect = typeof strategyMoveEndConditionEffects.$inferSelect;
export type InsertStrategyMoveEndConditionEffect = z.infer<typeof insertStrategyMoveEndConditionEffectSchema>;

export const decisionStatuses = ["open", "closed"] as const;
export type DecisionStatus = typeof decisionStatuses[number];

export const decisionTrafficLights = ["green", "yellow", "red"] as const;
export type DecisionTrafficLight = typeof decisionTrafficLights[number];

export const decisionLinkTargetTypes = ["strategy", "project"] as const;
export type DecisionLinkTargetType = typeof decisionLinkTargetTypes[number];

export const decisions = pgTable("decisions", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  status: text("status").notNull().default("open"),
  trafficLight: text("traffic_light"),
  dataContent: jsonb("data_content"),
  dataPlainText: text("data_plain_text").notNull().default(""),
  scenariosContent: jsonb("scenarios_content"),
  scenariosPlainText: text("scenarios_plain_text").notNull().default(""),
  planContent: jsonb("plan_content"),
  planPlainText: text("plan_plain_text").notNull().default(""),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_decisions_status").on(table.status),
  index("idx_decisions_scope_owner").on(table.scope, table.ownerUserId),
  index("idx_decisions_account").on(table.accountId),
]);

export const decisionUpdates = pgTable("decision_updates", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  decisionId: text("decision_id").notNull().references(() => decisions.id, { onDelete: "cascade" }),
  content: text("content").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true, precision: 6 }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_decision_updates_decision").on(table.decisionId),
]);

export const decisionLinks = pgTable("decision_links", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  decisionId: text("decision_id").notNull().references(() => decisions.id, { onDelete: "cascade" }),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_decision_links_decision").on(table.decisionId),
  index("idx_decision_links_target").on(table.targetType, table.targetId),
  uniqueIndex("uniq_decision_links_decision_target").on(table.decisionId, table.targetType, table.targetId),
]);

export const insertDecisionSchema = createInsertSchema(decisions).omit({
  id: true,
  scope: true,
  ownerUserId: true,
  accountId: true,
  createdAt: true,
  updatedAt: true,
  closedAt: true,
}).extend({
  trafficLight: z.enum(decisionTrafficLights).nullable().optional(),
  status: z.enum(decisionStatuses).optional(),
});

export const insertDecisionUpdateSchema = createInsertSchema(decisionUpdates).omit({
  id: true,
  createdAt: true,
}).extend({
  content: z.string().min(1),
});

export const insertDecisionLinkSchema = createInsertSchema(decisionLinks).omit({
  id: true,
  createdAt: true,
}).extend({
  targetType: z.enum(decisionLinkTargetTypes),
  targetId: z.string().min(1),
});

export type Decision = typeof decisions.$inferSelect;
export type InsertDecision = z.infer<typeof insertDecisionSchema>;
export type DecisionUpdate = typeof decisionUpdates.$inferSelect;
export type InsertDecisionUpdate = z.infer<typeof insertDecisionUpdateSchema>;
export type DecisionLink = typeof decisionLinks.$inferSelect;
export type InsertDecisionLink = z.infer<typeof insertDecisionLinkSchema>;
