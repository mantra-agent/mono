// Use createLogger for logging ONLY
import type { Express } from "express";
import { db, APP_NAME } from "../db";
import { Client, type ClientConfig } from "pg";
import { pathExists } from "./shared";
import { WORKSPACE_DIR } from "../paths";
import { documentStorage } from "../memory";
import { storage } from "../storage";
import { readFile, writeFile, readdir, stat, mkdir, unlink, rm } from "fs/promises";
import { createWriteStream, createReadStream } from "fs";
import { join } from "path";

import { exec, spawn } from "child_process";
import { promisify } from "util";
import { z } from "zod";
import { createLogger } from "../log";
import { requireAuth, requireAdmin } from "../auth";
import { getDbSyncImportSecretFromEnv, verifyDbSyncImportAuthHeader } from "../lib/db-sync-import-auth";
import { fingerprintDbUrl, redactDbUrl } from "../lib/db-sync-safety";
import { runSchemaBootstrap } from "../schema-bootstrap";
import { eq, sql, count, getTableColumns, getTableName } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import {
  users as usersTable,
  accounts,
  memberships,
  userPermissions,
  userProfiles,
  agentProfiles,
  systemSettings,
  timers,
  responsibilityRuns,
  tasks,
  projects,
  principles,
  persons,
  simplePeopleSurfaceState,
  connectedAccounts,
  emailTriageLog,
  emailMessages,
  personEmails,
  peopleImportCandidates,
  emailDrafts,
  emailDismissals,
  emailEnrichments,
  emailSyncCursors,
  emailSyncLog,
  calendarEventMetadata,
  calendarEventTasks,
  calendarEventPeople,
  calendarEventArtifacts,
  sessionTree,
  sessionOutputBuffer,
  sessionArtifacts,
  planExecutions,
  planSteps,
  workflowTemplates,
  workflowRuns,
  workflowStageAttempts,
  workflowTransitions,
  workflowArtifacts,
  workflowGates,
  workflowSessions,
  theses,
  thesisEvidence,
  thesisPredictions,
} from "@shared/schema";
import { workspaceDocuments, memoryEntries, memorySourceRefs, memoryLinks, memoryTransitions, memoryContentBlocks, memoryEvents, memoryEntityLinks, codeEmbeddings } from "@shared/models/memory";
import { chatSessions, messages } from "@shared/models/chat";
import { strategies, strategyActors, strategyMoveDefinitions, strategyMoveInstances, strategyAssumptions, strategyEndConditions, strategyContextEntries, strategyArtifacts, strategySimulationRuns, strategyStates, strategyAssumptionLinks, strategyMoveEndConditionEffects, decisions, decisionUpdates, decisionLinks } from "@shared/models/strategy";
import { skills, skillReferences, skillRuns, skillFailureDismissals } from "@shared/models/skills";
import { infoNotes, libraryPages, libraryPageLinks, libraryAnnotations, libraryPageViews } from "@shared/models/info";
import { thoughts } from "@shared/models/thought";
import { healthMetrics, wellnessActivities, wellnessLogs, gratitudeEntries, learningEntries } from "@shared/models/health";
import { emotionalStates, personas } from "@shared/models/cognition";
import { captures } from "@shared/models/captures";
import { contentQueue } from "@shared/models/content";
import { indexedContent } from "@shared/models/indexed-content";
import { plaidAccounts, plaidTransactions, plaidSecurities, plaidHoldings, plaidLiabilities, plaidSyncCursors, manualAssets, manualLiabilities, financialGoals, recurringExpenses, expenseCategories, merchantCategoryOverrides, budgetEntries, budgetIncomeOverride, budgetMonthlyOverrides, incomeSources, incomeDeductions, incomeDeposits, debtPayments, financedAssets, futureCashEvents, transactionAmortizations, transferPairOverrides, manual401kAccounts } from "@shared/models/finance";
import { signalSources, signalItems, scanRuns } from "@shared/models/signal";
import { execSkills, execExperience, execMetrics, execEducation, execPassions, experienceSkills } from "@shared/models/exec";
import { opportunities, opportunitySkills, opportunityArtifacts } from "@shared/models/opportunities";
import { platforms, platformProducts, platformProductEnvironments, environmentBuildLifecycleConfigs, providerConnections, environmentSourceBindings, environmentHostingBindings, environmentRuntimeVariables, environmentCapabilityBindings } from "@shared/models/platforms";
import { promptModules, promptModuleVersions } from "@shared/models/prompt-modules";
import { systemHooks, systemHookExecutions } from "@shared/models/events";
import { reflectionEntries } from "@shared/models/health";


const log = createLogger("BrainRoutes");
const execAsyncBrain = promisify(exec);

// Run tar via spawn instead of exec so we don't hit `exec`'s default
// 1 MB stdout/stderr buffer. On large Data+ archives (~1.5 GB) tar can
// emit "file changed as we read it" warnings or harmless leading-/
// notices that overflow the buffer and make exec abort with a generic
// "Command failed" — which is exactly what the deploy log surfaced as
// "Sync failed at table: library_page_views — Command failed: tar -czf …"
// (the table name was just whatever `lastTable` was when the post-loop
// tar step blew up). spawn streams stderr line-by-line so we surface
// the real reason on failure, and we widen the timeout to 10 minutes
// for the gzip pass on big archives.
async function runTar(args: string[], timeoutMs = 600_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderrTail = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
      reject(new Error(`tar ${args[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stderr?.on("data", (chunk: Buffer) => {
      // Keep only the last 4 KB of stderr so a chatty tar can't OOM us
      // but we still surface the actual error message on failure.
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4096);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        const tail = stderrTail.trim() || "(no stderr)";
        reject(new Error(`tar ${args[0]} exited ${code}: ${tail}`));
      }
    });
  });
}

// Module-scope helpers reused by server/routes/db-sync.ts.

export const BRAIN_EXPORT_DIR = "/tmp/brain-exports";
import { getBrainFormatVersion } from "@shared/instance-config";
export const BRAIN_FORMAT_VERSION = getBrainFormatVersion();

export type BrainDomain = "core" | "memory" | "chat" | "finance" | "strategy" | "skills" | "info" | "health" | "cognition" | "email" | "calendar" | "other";

export interface TableRegistryEntry {
  key: string;
  table: PgTable;
  domain: BrainDomain;
  hasSerial: boolean;
  serialCol?: string;
  sensitiveFields?: string[];
  dependsOn?: string[];
}

export const TABLE_REGISTRY: TableRegistryEntry[] = [
  { key: "users", table: usersTable, domain: "core", hasSerial: false, sensitiveFields: ["password", "reset_token"] },
  { key: "accounts", table: accounts, domain: "core", hasSerial: false },
  { key: "memberships", table: memberships, domain: "core", hasSerial: true, dependsOn: ["users", "accounts"] },
  { key: "user_permissions", table: userPermissions, domain: "core", hasSerial: true, dependsOn: ["users"] },
  { key: "user_profiles", table: userProfiles, domain: "core", hasSerial: false, dependsOn: ["users", "accounts"] },
  { key: "agent_profiles", table: agentProfiles, domain: "core", hasSerial: false, dependsOn: ["users", "accounts"] },
  { key: "system_settings", table: systemSettings, domain: "core", hasSerial: true },
  { key: "timers", table: timers, domain: "core", hasSerial: false },
  { key: "connected_accounts", table: connectedAccounts, domain: "core", hasSerial: true, sensitiveFields: ["tokens"] },
  { key: "responsibility_runs", table: responsibilityRuns, domain: "core", hasSerial: true },

  { key: "tasks", table: tasks, domain: "core", hasSerial: true },
  { key: "projects", table: projects, domain: "core", hasSerial: true },
  { key: "principles", table: principles, domain: "core", hasSerial: true },
  { key: "persons", table: persons, domain: "core", hasSerial: false },
  { key: "person_emails", table: personEmails, domain: "core", hasSerial: false, dependsOn: ["persons"] },
  { key: "simple_people_surface_state", table: simplePeopleSurfaceState, domain: "core", hasSerial: true, dependsOn: ["persons"] },
  { key: "people_import_candidates", table: peopleImportCandidates, domain: "core", hasSerial: true },

  { key: "expense_categories", table: expenseCategories, domain: "finance", hasSerial: true },
  { key: "income_sources", table: incomeSources, domain: "finance", hasSerial: true },
  { key: "plaid_accounts", table: plaidAccounts, domain: "finance", hasSerial: true },
  { key: "plaid_securities", table: plaidSecurities, domain: "finance", hasSerial: true },
  { key: "plaid_sync_cursors", table: plaidSyncCursors, domain: "finance", hasSerial: true },
  { key: "plaid_transactions", table: plaidTransactions, domain: "finance", hasSerial: true },
  { key: "plaid_holdings", table: plaidHoldings, domain: "finance", hasSerial: true },
  { key: "plaid_liabilities", table: plaidLiabilities, domain: "finance", hasSerial: true },
  { key: "manual_assets", table: manualAssets, domain: "finance", hasSerial: true },
  { key: "manual_liabilities", table: manualLiabilities, domain: "finance", hasSerial: true },
  { key: "financial_goals", table: financialGoals, domain: "finance", hasSerial: true },
  { key: "recurring_expenses", table: recurringExpenses, domain: "finance", hasSerial: true },
  { key: "merchant_category_overrides", table: merchantCategoryOverrides, domain: "finance", hasSerial: true, dependsOn: ["expense_categories"] },
  { key: "budget_entries", table: budgetEntries, domain: "finance", hasSerial: true },
  { key: "budget_income_override", table: budgetIncomeOverride, domain: "finance", hasSerial: true },
  { key: "budget_monthly_overrides", table: budgetMonthlyOverrides, domain: "finance", hasSerial: true },
  { key: "income_deductions", table: incomeDeductions, domain: "finance", hasSerial: true, dependsOn: ["income_sources"] },
  { key: "income_deposits", table: incomeDeposits, domain: "finance", hasSerial: true, dependsOn: ["income_sources"] },
  { key: "debt_payments", table: debtPayments, domain: "finance", hasSerial: true },
  { key: "financed_assets", table: financedAssets, domain: "finance", hasSerial: true },
  { key: "future_cash_events", table: futureCashEvents, domain: "finance", hasSerial: true },
  { key: "transaction_amortizations", table: transactionAmortizations, domain: "finance", hasSerial: true, dependsOn: ["plaid_transactions"] },
  { key: "transfer_pair_overrides", table: transferPairOverrides, domain: "finance", hasSerial: true },
  { key: "manual_401k_accounts", table: manual401kAccounts, domain: "finance", hasSerial: true },

  { key: "health_metrics", table: healthMetrics, domain: "health", hasSerial: true },
  { key: "wellness_activities", table: wellnessActivities, domain: "health", hasSerial: true },
  { key: "wellness_logs", table: wellnessLogs, domain: "health", hasSerial: true, dependsOn: ["wellness_activities"] },
  { key: "gratitude_entries", table: gratitudeEntries, domain: "health", hasSerial: true },
  { key: "learning_entries", table: learningEntries, domain: "health", hasSerial: true },
  { key: "reflection_entries", table: reflectionEntries, domain: "health", hasSerial: true },

  { key: "thoughts", table: thoughts, domain: "other", hasSerial: false },
  { key: "email_triage_log", table: emailTriageLog, domain: "other", hasSerial: true },
  { key: "captures", table: captures, domain: "other", hasSerial: false },
  { key: "content_queue", table: contentQueue, domain: "other", hasSerial: false },
  { key: "indexed_content", table: indexedContent, domain: "other", hasSerial: false },

  { key: "system_hooks", table: systemHooks, domain: "other", hasSerial: true },
  { key: "system_hook_executions", table: systemHookExecutions, domain: "other", hasSerial: true, dependsOn: ["system_hooks"] },

  { key: "signal_sources", table: signalSources, domain: "other", hasSerial: false },
  { key: "signal_items", table: signalItems, domain: "other", hasSerial: false, dependsOn: ["signal_sources"] },
  { key: "scan_runs", table: scanRuns, domain: "other", hasSerial: false },

  { key: "prompt_modules", table: promptModules, domain: "other", hasSerial: false },
  { key: "prompt_module_versions", table: promptModuleVersions, domain: "other", hasSerial: true, dependsOn: ["prompt_modules"] },

  { key: "platforms", table: platforms, domain: "other", hasSerial: true },
  { key: "platform_products", table: platformProducts, domain: "other", hasSerial: true, dependsOn: ["platforms"] },
  { key: "platform_product_environments", table: platformProductEnvironments, domain: "other", hasSerial: true, dependsOn: ["platform_products"] },
  { key: "provider_connections", table: providerConnections, domain: "other", hasSerial: true, sensitiveFields: ["encryptedCredential", "credentialIv", "credentialTag"] },
  { key: "environment_source_bindings", table: environmentSourceBindings, domain: "other", hasSerial: true, dependsOn: ["platform_product_environments", "provider_connections"] },
  { key: "environment_hosting_bindings", table: environmentHostingBindings, domain: "other", hasSerial: true, dependsOn: ["platform_product_environments", "provider_connections"] },
  { key: "environment_runtime_variables", table: environmentRuntimeVariables, domain: "other", hasSerial: true, dependsOn: ["platform_product_environments"] },
  { key: "environment_capability_bindings", table: environmentCapabilityBindings, domain: "other", hasSerial: true, dependsOn: ["platform_product_environments", "provider_connections"] },
  { key: "environment_build_lifecycle_configs", table: environmentBuildLifecycleConfigs, domain: "other", hasSerial: true, dependsOn: ["platform_product_environments"] },

  { key: "exec_skills", table: execSkills, domain: "other", hasSerial: true },
  { key: "exec_experience", table: execExperience, domain: "other", hasSerial: true },
  { key: "exec_metrics", table: execMetrics, domain: "other", hasSerial: true, dependsOn: ["exec_experience"] },
  { key: "exec_education", table: execEducation, domain: "other", hasSerial: true },
  { key: "exec_passions", table: execPassions, domain: "other", hasSerial: true },
  { key: "experience_skills", table: experienceSkills, domain: "other", hasSerial: true, dependsOn: ["exec_experience", "exec_skills"] },

  { key: "opportunities", table: opportunities, domain: "other", hasSerial: true },
  { key: "opportunity_skills", table: opportunitySkills, domain: "other", hasSerial: true, dependsOn: ["opportunities", "exec_skills"] },
  { key: "opportunity_artifacts", table: opportunityArtifacts, domain: "other", hasSerial: true, dependsOn: ["opportunities", "library_pages"] },

  { key: "skills", table: skills, domain: "skills", hasSerial: false },

  { key: "skill_references", table: skillReferences, domain: "skills", hasSerial: true, dependsOn: ["skills"] },
  { key: "skill_runs", table: skillRuns, domain: "skills", hasSerial: true },
  { key: "skill_failure_dismissals", table: skillFailureDismissals, domain: "skills", hasSerial: true },

  { key: "emotional_states", table: emotionalStates, domain: "cognition", hasSerial: true },
  { key: "personas", table: personas, domain: "cognition", hasSerial: true },

  { key: "email_messages", table: emailMessages, domain: "email", hasSerial: true },
  { key: "email_drafts", table: emailDrafts, domain: "email", hasSerial: true, dependsOn: ["email_messages"] },
  { key: "email_dismissals", table: emailDismissals, domain: "email", hasSerial: true, dependsOn: ["email_messages"] },
  { key: "email_enrichments", table: emailEnrichments, domain: "email", hasSerial: true, dependsOn: ["email_messages"] },
  { key: "email_sync_cursors", table: emailSyncCursors, domain: "email", hasSerial: true },
  { key: "email_sync_log", table: emailSyncLog, domain: "email", hasSerial: true },

  { key: "calendar_event_metadata", table: calendarEventMetadata, domain: "calendar", hasSerial: true },
  { key: "calendar_event_tasks", table: calendarEventTasks, domain: "calendar", hasSerial: true, dependsOn: ["calendar_event_metadata"] },
  { key: "calendar_event_people", table: calendarEventPeople, domain: "calendar", hasSerial: true, dependsOn: ["calendar_event_metadata"] },
  { key: "calendar_event_artifacts", table: calendarEventArtifacts, domain: "calendar", hasSerial: true, dependsOn: ["calendar_event_metadata", "library_pages"] },

  { key: "workspace_documents", table: workspaceDocuments, domain: "memory", hasSerial: true },
  { key: "memory_entries", table: memoryEntries, domain: "memory", hasSerial: true },
  { key: "memory_sources", table: memorySourceRefs, domain: "memory", hasSerial: true, dependsOn: ["memory_entries"] },
  { key: "memory_links", table: memoryLinks, domain: "memory", hasSerial: true, dependsOn: ["memory_entries"] },
  { key: "memory_transitions", table: memoryTransitions, domain: "memory", hasSerial: true, dependsOn: ["memory_entries"] },
  { key: "memory_content_blocks", table: memoryContentBlocks, domain: "memory", hasSerial: true, dependsOn: ["memory_entries"] },
  { key: "memory_events", table: memoryEvents, domain: "memory", hasSerial: true, dependsOn: ["memory_entries"] },
  { key: "memory_entity_links", table: memoryEntityLinks, domain: "memory", hasSerial: true, dependsOn: ["memory_entries"] },
  { key: "code_embeddings", table: codeEmbeddings, domain: "memory", hasSerial: true },

  { key: "sessions", table: chatSessions, domain: "chat", hasSerial: true },
  { key: "session_tree", table: sessionTree, domain: "chat", hasSerial: true, dependsOn: ["sessions"] },
  { key: "session_output_buffer", table: sessionOutputBuffer, domain: "chat", hasSerial: true, dependsOn: ["sessions"] },
  { key: "session_artifacts", table: sessionArtifacts, domain: "chat", hasSerial: true, dependsOn: ["sessions"] },
  { key: "messages", table: messages, domain: "chat", hasSerial: true, dependsOn: ["sessions"] },

  { key: "plan_executions", table: planExecutions, domain: "chat", hasSerial: false },
  { key: "plan_steps", table: planSteps, domain: "chat", hasSerial: false, dependsOn: ["plan_executions"] },

  { key: "workflow_templates", table: workflowTemplates, domain: "chat", hasSerial: false },
  { key: "workflow_runs", table: workflowRuns, domain: "chat", hasSerial: false, dependsOn: ["workflow_templates"] },
  { key: "workflow_stage_attempts", table: workflowStageAttempts, domain: "chat", hasSerial: true, dependsOn: ["workflow_runs"] },
  { key: "workflow_transitions", table: workflowTransitions, domain: "chat", hasSerial: true, dependsOn: ["workflow_runs"] },
  { key: "workflow_artifacts", table: workflowArtifacts, domain: "chat", hasSerial: true, dependsOn: ["workflow_runs", "workflow_stage_attempts"] },
  { key: "workflow_gates", table: workflowGates, domain: "chat", hasSerial: true, dependsOn: ["workflow_runs"] },
  { key: "workflow_sessions", table: workflowSessions, domain: "chat", hasSerial: true, dependsOn: ["workflow_runs", "sessions"] },

  { key: "strategy_goals", table: strategies, domain: "strategy", hasSerial: false },
  { key: "strategy_actors", table: strategyActors, domain: "strategy", hasSerial: false, dependsOn: ["strategy_goals"] },
  { key: "strategy_move_definitions", table: strategyMoveDefinitions, domain: "strategy", hasSerial: false, dependsOn: ["strategy_goals", "strategy_actors"] },
  // strategy_states must come BEFORE move_instances even though the
  // Drizzle schema declares parent_state_id / terminating_state_id as
  // plain text columns. The actual FKs (parent_state_fkey,
  // terminating_state_fkey → strategy_states.id) are added at boot by
  // server/strategy-storage.ts, so the sync registry has to know about
  // them or the deferred FK check fires at commit and drops every
  // move_instances row (which then cascades into 0-row imports for
  // strategy_assumption_links and strategy_move_end_condition_effects).
  { key: "strategy_move_instances", table: strategyMoveInstances, domain: "strategy", hasSerial: false, dependsOn: ["strategy_goals", "strategy_move_definitions", "strategy_actors", "strategy_states"] },
  { key: "strategy_assumptions", table: strategyAssumptions, domain: "strategy", hasSerial: false, dependsOn: ["strategy_goals"] },
  { key: "strategy_end_conditions", table: strategyEndConditions, domain: "strategy", hasSerial: false, dependsOn: ["strategy_goals"] },
  { key: "strategy_context_entries", table: strategyContextEntries, domain: "strategy", hasSerial: false, dependsOn: ["strategy_goals"] },
  { key: "strategy_artifacts", table: strategyArtifacts, domain: "strategy", hasSerial: false, dependsOn: ["strategy_goals"] },
  { key: "strategy_simulation_runs", table: strategySimulationRuns, domain: "strategy", hasSerial: false, dependsOn: ["strategy_goals", "strategy_move_instances"] },
  { key: "strategy_states", table: strategyStates, domain: "strategy", hasSerial: false, dependsOn: ["strategy_goals"] },
  { key: "strategy_assumption_links", table: strategyAssumptionLinks, domain: "strategy", hasSerial: false, dependsOn: ["strategy_assumptions", "strategy_move_instances"] },
  { key: "strategy_move_end_condition_effects", table: strategyMoveEndConditionEffects, domain: "strategy", hasSerial: false, dependsOn: ["strategy_move_instances", "strategy_end_conditions"] },
  { key: "decisions", table: decisions, domain: "strategy", hasSerial: false },
  { key: "decision_updates", table: decisionUpdates, domain: "strategy", hasSerial: false, dependsOn: ["decisions"] },
  { key: "decision_links", table: decisionLinks, domain: "strategy", hasSerial: false, dependsOn: ["decisions"] },
  { key: "theses", table: theses, domain: "world", hasSerial: false },
  { key: "thesis_evidence", table: thesisEvidence, domain: "world", hasSerial: false, dependsOn: ["theses"] },
  { key: "thesis_predictions", table: thesisPredictions, domain: "world", hasSerial: false, dependsOn: ["theses"] },

  { key: "info_notes", table: infoNotes, domain: "info", hasSerial: true, serialCol: "note_id" },
  { key: "library_pages", table: libraryPages, domain: "info", hasSerial: true, serialCol: "page_id", dependsOn: ["memory_entries"] },
  { key: "library_page_links", table: libraryPageLinks, domain: "info", hasSerial: true, serialCol: "id", dependsOn: ["library_pages"] },
  { key: "library_annotations", table: libraryAnnotations, domain: "info", hasSerial: false, dependsOn: ["library_pages"] },
  { key: "library_page_views", table: libraryPageViews, domain: "info", hasSerial: false, dependsOn: ["library_pages"] },
];

function topoSortRegistry(entries: TableRegistryEntry[]): TableRegistryEntry[] {
  const keyMap = new Map<string, TableRegistryEntry>();
  for (const e of entries) keyMap.set(e.key, e);

  for (const e of entries) {
    for (const dep of e.dependsOn ?? []) {
      if (!keyMap.has(dep)) {
        log.error(`TABLE_REGISTRY error: "${e.key}" depends on unknown key "${dep}"`);
      }
    }
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();
  const sorted: TableRegistryEntry[] = [];

  function visit(key: string) {
    if (visited.has(key)) return;
    if (inStack.has(key)) {
      log.error(`TABLE_REGISTRY error: cycle detected involving "${key}"`);
      return;
    }
    inStack.add(key);
    const entry = keyMap.get(key);
    if (!entry) return;
    for (const dep of entry.dependsOn ?? []) {
      visit(dep);
    }
    inStack.delete(key);
    visited.add(key);
    sorted.push(entry);
  }

  for (const e of entries) visit(e.key);
  return sorted;
}

export const INSERT_ORDER: TableRegistryEntry[] = topoSortRegistry(TABLE_REGISTRY);
export const DELETE_ORDER: TableRegistryEntry[] = [...INSERT_ORDER].reverse();

const EXPORT_BATCH_SIZE = 5000;

// Tables whose row content can be large enough (multi-MB blobs) to wedge
// a buffered batch export. These get streamed via a SQL cursor on a
// dedicated pg.Client with a small FETCH window — bounded memory, bounded
// per-tick JSON.stringify time, mid-table progress callbacks. See
// .local/tasks/task-1017.md for the post-mortem.
const LARGE_ROW_TABLES = new Set<string>([
  "memory_entries",
  "workspace_documents",
  // email_messages.body_html is frequently hundreds of KB per row.
  // The buffered EXPORT_BATCH_SIZE=5000 path was loading ~5000 rows
  // and JSON.stringify'ing them in one tick, blowing the 2GB heap on
  // production. Symptom: last log was a SLOW query on email_messages
  // followed by total silence (OOM kills the process before any
  // logger.error fires). Streaming via SQL cursor with FETCH 200
  // bounds memory regardless of table size.
  "email_messages",
  // email_drafts has the same body_html shape — pre-emptively guard
  // it so the next sync doesn't repeat the OOM on a different table.
  "email_drafts",
]);

// FETCH window for the streaming-cursor path. Small enough that a single
// fat row can't blow the heap (worst case: STREAMING_FETCH_SIZE * row size),
// large enough to keep round-trip overhead negligible.
const STREAMING_FETCH_SIZE = 200;

// Returns a column projection (every column EXCEPT the named ones).
function columnsExcept<T extends Record<string, unknown>>(
  cols: T,
  exclude: readonly (keyof T)[],
): Record<string, T[keyof T]> {
  const out: Record<string, T[keyof T]> = {};
  for (const k of Object.keys(cols) as (keyof T)[]) {
    if (exclude.includes(k)) continue;
    out[k as string] = cols[k];
  }
  return out;
}

// Data-mode projections: every column EXCEPT embedding vectors.
export const memoryEntryDataColumns = columnsExcept(
  getTableColumns(memoryEntries),
  ["embedding"] as const,
);
export const workspaceDocDataColumns = columnsExcept(
  getTableColumns(workspaceDocuments),
  ["embedding"] as const,
);
export const workspaceDocLightColumns = workspaceDocDataColumns;

type ColumnProjection = Record<string, unknown>;

async function runSelect(
  table: PgTable,
  columns: ColumnProjection | undefined,
  limit?: number,
  offset?: number,
): Promise<unknown[]> {
  const builder = columns
    ? db.select(columns as Record<string, never>).from(table)
    : db.select().from(table);
  if (limit !== undefined) {
    return (builder as unknown as {
      limit: (n: number) => { offset: (n: number) => Promise<unknown[]> };
    }).limit(limit).offset(offset ?? 0);
  }
  return builder as unknown as Promise<unknown[]>;
}

// Quote a Postgres identifier (column or table name). Escapes embedded
// double-quotes; throws on null bytes (which can't legally appear in our
// schema-derived names).
function quoteIdent(name: string): string {
  if (name.includes("\0")) throw new Error(`identifier contains NUL: ${name}`);
  return `"${name.replace(/"/g, '""')}"`;
}

// Build a SELECT with explicit "<sql_name>" AS "<js_key>" aliases for every
// column in the projection. Raw pg results then come back keyed by the JS
// names (camelCase) — byte-equivalent to drizzle's runtime row mapping —
// so the JSON wire format and the import-side deserializer are unaffected.
//
// Also returns the JS keys of any vector columns. node-postgres returns
// pgvector values as the raw wire string ("[1,2,3]") whereas Drizzle's
// vector() column mapper parses them to number[]. We post-process those
// columns per row in the streaming path so the JSON output matches the
// buffered/Drizzle path byte-for-byte.
function buildAliasedSelectSQL(
  table: PgTable,
  columns: ColumnProjection | undefined,
): { sql: string; vectorKeys: string[] } {
  const tableName = getTableName(table);
  const allCols = getTableColumns(table) as Record<string, unknown>;
  const proj = (columns ?? allCols) as Record<string, { name: string; columnType?: string }>;
  const fragments: string[] = [];
  const vectorKeys: string[] = [];
  for (const [jsKey, col] of Object.entries(proj)) {
    const sqlName = col?.name;
    if (typeof sqlName !== "string" || sqlName.length === 0) {
      throw new Error(`column "${jsKey}" on table "${tableName}" has no .name`);
    }
    if (col?.columnType === "PgVector") vectorKeys.push(jsKey);
    fragments.push(
      jsKey === sqlName
        ? quoteIdent(sqlName)
        : `${quoteIdent(sqlName)} AS ${quoteIdent(jsKey)}`,
    );
  }
  if (fragments.length === 0) {
    throw new Error(`empty column projection for table "${tableName}"`);
  }
  return {
    sql: `SELECT ${fragments.join(", ")} FROM ${quoteIdent(tableName)}`,
    vectorKeys,
  };
}

// Parse a pgvector wire-format string ("[1,2,3]") into number[]. Returns
// the input unchanged if it's already an array (defensive — node-postgres
// could ship a vector parser in the future) or null/undefined.
function parseVectorString(value: unknown): unknown {
  if (value == null) return value;
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return value;
  // pgvector wire format is "[v1,v2,...]" with no whitespace.
  if (value.length < 2 || value.charCodeAt(0) !== 0x5b /* [ */) return value;
  // JSON.parse handles the format directly since it's a JSON array of numbers.
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

// Stream rows for a large-row table via a SQL cursor on a dedicated
// pg.Client. The connection comes from outside the main pool, so an
// export wedge here can't exhaust the live API's connections. Memory is
// bounded by STREAMING_FETCH_SIZE rows; JSON.stringify runs per-row with
// awaits between batches so the event loop never blocks for long. Calls
// onProgress after each batch so the sync orchestrator can stamp
// lastProgressAt and the reaper sees fresh activity within seconds.
async function exportTableStreamingCursor(
  tableKey: string,
  table: PgTable,
  columns: ColumnProjection | undefined,
  filePath: string,
  onProgress?: (rowsInTable: number) => void | Promise<void>,
  shouldCancel?: () => boolean | Promise<boolean>,
): Promise<number> {
  const { sql: selectSql, vectorKeys } = buildAliasedSelectSQL(table, columns);
  const cursorName = `xyz_export_${tableKey.replace(/[^a-zA-Z0-9_]/g, "_")}_${Date.now().toString(36)}`;

  // statement_timeout is a runtime-supported pg option but is typed as
  // pg-client-only in some @types/pg versions, so we declare it via the
  // ClientConfig & {} intersection rather than `as any`.
  const clientConfig: ClientConfig & { statement_timeout?: number } = {
    connectionString: process.env.DATABASE_URL,
    application_name: `${APP_NAME}-sync`,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    // Cursor exports run for minutes on large tables. The reaper
    // (lastProgressAt + EXPORT_STALE_TIMEOUT_MS, default 60s) is the
    // safety net for hung exports, not statement_timeout.
    statement_timeout: 0,
  };
  const client = new Client(clientConfig);

  await client.connect();

  const fd = createWriteStream(filePath);
  let total = 0;
  let first = true;
  let inTx = false;
  let cursorOpen = false;

  // Write with backpressure: pause if the OS sink can't keep up.
  const write = (data: string) => new Promise<void>((resolve, reject) => {
    const onErr = (err: Error) => reject(err);
    fd.once("error", onErr);
    if (fd.write(data)) {
      fd.removeListener("error", onErr);
      resolve();
    } else {
      fd.once("drain", () => {
        fd.removeListener("error", onErr);
        resolve();
      });
    }
  });

  try {
    await write("[");
    await client.query("BEGIN");
    inTx = true;
    await client.query(`DECLARE ${cursorName} NO SCROLL CURSOR FOR ${selectSql}`);
    cursorOpen = true;

    while (true) {
      if (shouldCancel) {
        const stop = await shouldCancel();
        if (stop) break;
      }
      const r = await client.query(`FETCH ${STREAMING_FETCH_SIZE} FROM ${cursorName}`);
      if (r.rows.length === 0) break;
      for (const row of r.rows) {
        // Convert pgvector wire-format strings to number[] so the JSON
        // output matches the buffered/Drizzle path byte-for-byte. No-op
        // for tables with no vector columns.
        for (const k of vectorKeys) {
          row[k] = parseVectorString(row[k]);
        }
        const prefix = first ? "" : ",";
        first = false;
        await write(prefix + JSON.stringify(row));
      }
      total += r.rows.length;
      if (onProgress) await onProgress(total);
    }
  } finally {
    if (cursorOpen) {
      try { await client.query(`CLOSE ${cursorName}`); } catch {}
    }
    if (inTx) {
      try { await client.query("COMMIT"); } catch {
        try { await client.query("ROLLBACK"); } catch {}
      }
    }
    try { await client.end(); } catch {}
    try { await write("]"); } catch {}
    await new Promise<void>((resolve) => fd.end(() => resolve()));
  }

  return total;
}

export async function exportTableBatched(
  table: PgTable,
  filePath: string,
  columns?: ColumnProjection,
  tableKey?: string,
  onProgress?: (rowsInTable: number) => void | Promise<void>,
  shouldCancel?: () => boolean | Promise<boolean>,
): Promise<number> {
  // Large-row tables: stream via cursor on a dedicated connection. Bypasses
  // the buffered LIMIT/OFFSET path entirely — no full batch ever lives in
  // memory at once, and progress is reported per-FETCH.
  if (tableKey && LARGE_ROW_TABLES.has(tableKey)) {
    return exportTableStreamingCursor(
      tableKey,
      table,
      columns,
      filePath,
      onProgress,
      shouldCancel,
    );
  }

  const [{ total }] = await db.select({ total: count() }).from(table);
  if (total === 0) {
    await writeFile(filePath, "[]");
    return 0;
  }

  if (total <= EXPORT_BATCH_SIZE) {
    const rows = await runSelect(table, columns);
    await writeFile(filePath, JSON.stringify(rows));
    return rows.length;
  }

  let offset = 0;
  let first = true;
  const fd = createWriteStream(filePath);
  await new Promise<void>((resolve, reject) => {
    fd.on("error", reject);
    fd.write("[", (err) => err ? reject(err) : resolve());
  });

  while (offset < total) {
    if (shouldCancel) {
      const stop = await shouldCancel();
      if (stop) break;
    }
    const rows = await runSelect(table, columns, EXPORT_BATCH_SIZE, offset);
    if (rows.length === 0) break;
    for (const row of rows) {
      const prefix = first ? "" : ",";
      first = false;
      await new Promise<void>((resolve, reject) => {
        fd.write(prefix + JSON.stringify(row), (err) => err ? reject(err) : resolve());
      });
    }
    offset += rows.length;
    // Per-batch heartbeat so the reaper sees fresh activity for the
    // buffered path too. Without this, any non-allowlisted table whose
    // batch fetch + serialize exceeds EXPORT_STALE_TIMEOUT_MS (default
    // 60s) could be wrongly reaped as stale despite running healthily.
    if (onProgress) await onProgress(offset);
  }

  await new Promise<void>((resolve, reject) => {
    fd.write("]", (err) => err ? reject(err) : resolve());
  });
  await new Promise<void>((resolve, reject) => {
    fd.end(() => resolve());
    fd.on("error", reject);
  });

  // Return rows actually written, not the up-front count() — this matters
  // when shouldCancel breaks the loop early, so callers (and the
  // exportBrain summary) see the true partial count and can act on it.
  return offset;
}

export interface TableExportResult {
  key: string;
  domain: BrainDomain;
  rows: number;
  durationMs: number;
  error?: string;
  sensitiveFields?: string[];
}

export interface DomainSummary {
  tables: Record<string, { rows: number; durationMs: number; error?: string; sensitiveFields?: string[] }>;
  totalRows: number;
}

export type ExportMode = "schema" | "data" | "data_plus";

export interface ExportBrainOptions {
  mode: ExportMode;
  onTableStart?: (table: string, index: number, total: number) => void | Promise<void>;
  onTableDone?: (table: string, index: number, total: number, rows: number) => void | Promise<void>;
  // Fires from inside exportTableBatched on each FETCH window (~200 rows)
  // for streaming-cursor tables, so the orchestrator can stamp
  // lastProgressAt and the reaper sees mid-table activity. Non-streaming
  // tables only emit the boundary callbacks above.
  onProgress?: (rowsInTable: number, totalRowsSoFar: number, currentTable: string) => void | Promise<void>;
  // Fires once at the start of a data/data_plus export with the sum of
  // count(*) across every exportable table. Lets the orchestrator drive a
  // smooth row-based progress bar (rowsExported / totalRowsExpected)
  // instead of a chunky table-boundary one. Skipped for schema mode.
  onPreflight?: (totalRowsExpected: number) => void | Promise<void>;
  shouldCancel?: () => boolean | Promise<boolean>;
}

export interface ExportBrainResult {
  archivePath: string;
  archiveName: string;
  sizeBytes: number;
  totalRows: number;
  totalTables: number;
  failedTables: string[];
  domains: Record<string, DomainSummary>;
  durationMs: number;
  cancelled: boolean;
  mode: ExportMode;
}

// Returns the column projection to use when exporting `key` in `mode`.
// `null` means "skip this table entirely". `undefined` means "all columns".
function columnsForMode(key: string, mode: ExportMode): ColumnProjection | null | undefined {
  if (mode === "data_plus") return undefined;
  if (mode === "schema") {
    // Schema mode writes empty arrays; columns selection doesn't matter, but
    // returning undefined here means we never actually run a query — see
    // exportBrain below where schema mode short-circuits to writeFile("[]").
    return undefined;
  }
  // mode === "data": every column EXCEPT embedding vectors.
  if (key === "code_embeddings") return null;
  if (key === "memory_entries") return memoryEntryDataColumns as ColumnProjection;
  if (key === "workspace_documents") return workspaceDocDataColumns as ColumnProjection;
  return undefined;
}

export async function exportBrain(options: ExportBrainOptions): Promise<ExportBrainResult> {
  const { mode } = options;
  await mkdir(BRAIN_EXPORT_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stagingDir = join(BRAIN_EXPORT_DIR, `brain-${timestamp}`);
  await mkdir(join(stagingDir, "db"), { recursive: true });

  const exportStart = Date.now();
  const results: TableExportResult[] = [];
  const failed: string[] = [];
  let cancelled = false;

  log.debug(`Starting export of ${INSERT_ORDER.length} tables (mode=${mode})`);

  // Pre-flight count: for data/data_plus modes, sum count(*) across every
  // table that will actually emit rows so the orchestrator can drive a
  // smooth row-based progress bar (rowsExported / totalRowsExpected)
  // instead of a chunky table-boundary one. Skipped for schema mode (all
  // tables write empty arrays). Failures here are non-fatal — they just
  // mean the bar falls back to table-boundary granularity.
  //
  // The counts run on a dedicated pg.Client (NOT the main API pool) so
  // they don't compete with live request traffic for connections — same
  // isolation rationale as the streaming-cursor path. Counts are issued
  // sequentially on the single client (Postgres protocol allows only one
  // in-flight query per connection); on this dataset the whole sweep is
  // sub-second, well below any reaper window.
  if (mode !== "schema" && options.onPreflight) {
    const preflightClient = new Client({
      connectionString: process.env.DATABASE_URL,
      application_name: `${APP_NAME}-sync-preflight`,
      keepAlive: true,
    });
    try {
      await preflightClient.connect();
      const countable = INSERT_ORDER.filter(
        (e) => columnsForMode(e.key, mode) !== null,
      );
      let totalRowsExpected = 0;
      const skipped: string[] = [];
      for (const e of countable) {
        try {
          const tableName = getTableName(e.table);
          // tableName comes from the drizzle schema (developer-controlled
          // identifier list), but we still quote it to defend against
          // future schema changes that introduce reserved-word names.
          const r = await preflightClient.query<{ total: string }>(
            `SELECT count(*)::text AS total FROM "${tableName.replace(/"/g, '""')}"`,
          );
          const n = Number(r.rows[0]?.total ?? "0");
          if (Number.isFinite(n)) {
            totalRowsExpected += n;
          } else {
            skipped.push(e.key);
          }
        } catch (err: any) {
          // Per-table failure is non-fatal — we just under-count, which
          // can let the UI hit 100% before the export actually finishes.
          // The summary log below makes that visible.
          skipped.push(e.key);
          log.warn(`Preflight count failed for "${e.key}" (non-fatal): ${err?.message ?? err}`);
        }
      }
      const succeeded = countable.length - skipped.length;
      const skipNote = skipped.length > 0 ? ` — ${skipped.length} skipped: ${skipped.join(", ")}` : "";
      log.debug(
        `Preflight: ${totalRowsExpected.toLocaleString()} rows expected across ${succeeded}/${countable.length} tables${skipNote}`,
      );
      await options.onPreflight(totalRowsExpected);
    } catch (err: any) {
      log.warn(`Preflight count failed (non-fatal): ${err?.message ?? err}`);
    } finally {
      await preflightClient.end().catch(() => {});
    }
  }

  // Cumulative row count across all completed tables — passed to onProgress
  // so the orchestrator can report a running total during the streaming
  // path without re-reading state.
  let totalRowsSoFar = 0;

  for (let i = 0; i < INSERT_ORDER.length; i++) {
    const entry = INSERT_ORDER[i];

    if (options.shouldCancel) {
      const stop = await options.shouldCancel();
      if (stop) {
        cancelled = true;
        log.debug(`Export cancelled before table "${entry.key}" (${i}/${INSERT_ORDER.length})`);
        break;
      }
    }

    if (options.onTableStart) {
      await options.onTableStart(entry.key, i, INSERT_ORDER.length);
    }

    log.debug(`${entry.key}: starting (${entry.domain})`);
    const tableStart = Date.now();
    const filePath = join(stagingDir, "db", `${entry.key}.json`);
    try {
      let rowCount = 0;
      if (mode === "schema") {
        await writeFile(filePath, "[]");
      } else {
        const cols = columnsForMode(entry.key, mode);
        if (cols === null) {
          // Skip entirely — write empty array so import wipes the table on
          // the dev side without inserting anything.
          await writeFile(filePath, "[]");
        } else {
          const tableProgress = options.onProgress
            ? (rowsInTable: number) =>
                options.onProgress!(rowsInTable, totalRowsSoFar + rowsInTable, entry.key)
            : undefined;
          rowCount = await exportTableBatched(
            entry.table,
            filePath,
            cols,
            entry.key,
            tableProgress,
            options.shouldCancel,
          );
        }
      }
      totalRowsSoFar += rowCount;
      const dur = Date.now() - tableStart;
      results.push({ key: entry.key, domain: entry.domain, rows: rowCount, durationMs: dur, sensitiveFields: entry.sensitiveFields });
      log.debug(`${entry.key}: done — ${rowCount} rows (${dur}ms)`);
    } catch (err: any) {
      const dur = Date.now() - tableStart;
      results.push({ key: entry.key, domain: entry.domain, rows: 0, durationMs: dur, error: err.message });
      failed.push(entry.key);
      log.error(`${entry.key}: FAILED (${dur}ms) — ${err.message}`);
    }

    if (options.onTableDone) {
      await options.onTableDone(entry.key, i, INSERT_ORDER.length, results[results.length - 1].rows);
    }

    // Re-check cancel AFTER each table completes (not just at the top of
    // the next iteration) so that if cancel was requested while the last
    // table was being exported, we mark the run cancelled and skip the
    // archive/upload step rather than uploading a partial table as if
    // it succeeded. Both export paths (streaming + buffered) return
    // their actual exported row count when interrupted, so the partial
    // count above is honest.
    if (options.shouldCancel) {
      const stop = await options.shouldCancel();
      if (stop) {
        cancelled = true;
        log.debug(`Export cancelled during/after table "${entry.key}" (${i + 1}/${INSERT_ORDER.length})`);
        break;
      }
    }
  }

  const domains: Record<string, DomainSummary> = {};
  for (const r of results) {
    if (!domains[r.domain]) domains[r.domain] = { tables: {}, totalRows: 0 };
    domains[r.domain].tables[r.key] = { rows: r.rows, durationMs: r.durationMs };
    if (r.error) domains[r.domain].tables[r.key].error = r.error;
    if (r.sensitiveFields) domains[r.domain].tables[r.key].sensitiveFields = r.sensitiveFields;
    domains[r.domain].totalRows += r.rows;
  }

  const totalRows = results.reduce((s, r) => s + r.rows, 0);
  const totalDuration = Date.now() - exportStart;

  const manifest = {
    format: BRAIN_FORMAT_VERSION,
    mode,
    exportedAt: new Date().toISOString(),
    totalTables: INSERT_ORDER.length,
    successfulTables: INSERT_ORDER.length - failed.length,
    failedTables: failed,
    totalRows,
    durationMs: totalDuration,
    cancelled,
    domains,
  };

  await writeFile(join(stagingDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  if (cancelled) {
    // Don't bother building an archive if the caller cancelled — the dev DB
    // will not be touched. Clean up staging and return an empty archive
    // descriptor so the caller can react accordingly.
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    return {
      archivePath: "",
      archiveName: "",
      sizeBytes: 0,
      totalRows,
      totalTables: INSERT_ORDER.length,
      failedTables: failed,
      domains,
      durationMs: totalDuration,
      cancelled: true,
      mode,
    };
  }

  const archiveName = `xyz-brain-${timestamp}.tar.gz`;
  const archivePath = join(BRAIN_EXPORT_DIR, archiveName);
  // Use gzip -1 (fastest level) + spawn to keep big-archive packing
  // under the timeout and surface real stderr if it fails.
  await runTar([
    "--use-compress-program=gzip -1",
    "-cf", archivePath,
    "-C", BRAIN_EXPORT_DIR,
    `brain-${timestamp}`,
  ], 600_000);
  await rm(stagingDir, { recursive: true, force: true });

  const stats = await stat(archivePath);
  log.debug(`Export complete: ${totalRows} rows across ${INSERT_ORDER.length} tables in ${totalDuration}ms (${failed.length} failures, mode=${mode})`);

  return {
    archivePath,
    archiveName,
    sizeBytes: stats.size,
    totalRows,
    totalTables: INSERT_ORDER.length,
    failedTables: failed,
    domains,
    durationMs: totalDuration,
    cancelled: false,
    mode,
  };
}

export interface ImportTableFailure {
  key: string;
  expected: number;
  imported: number;
  error: string;
}

export interface ImportDbResult {
  imported: Record<string, number>;
  expected: Record<string, number>;
  failed: string[];
  failures: ImportTableFailure[];
}

// Find the single primary-key column for a table, if any. Returns the
// drizzle column object (which carries both the JS key via the projection
// caller and the SQL `.name`). Used to build ON CONFLICT (pk) DO UPDATE
// targets dynamically. Tables with composite PKs return null → caller
// falls back to ON CONFLICT DO NOTHING.
function findSinglePkColumn(table: PgTable): { jsKey: string; col: any } | null {
  const cols = getTableColumns(table) as Record<string, { primary?: boolean; name: string }>;
  const pks = Object.entries(cols).filter(([, c]) => c.primary === true);
  if (pks.length !== 1) return null;
  const [jsKey, col] = pks[0];
  return { jsKey, col };
}

// ── Shared helpers for buffered and streaming import ────────────────

/** Hydrate ISO-8601 date strings in a row to Date objects (in-place). */
function hydrateRow(row: any): any {
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) {
      const d = new Date(v);
      if (!isNaN(d.getTime())) row[k] = d;
    }
  }
  return row;
}

/** Size threshold in bytes — tables larger than this use streaming. */
const STREAM_THRESHOLD_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Async generator that stream-reads a JSON array file and yields one
 * parsed object at a time. Uses a bracket-depth state machine to find
 * object boundaries without loading the whole file into memory.
 *
 * Assumes the file is a JSON array of objects: [{...}, {...}, ...].
 * Handles nested braces, strings with escaped characters, and
 * multi-byte UTF-8 correctly (reads as utf-8 text chunks).
 */
async function* streamJsonArrayFile(filePath: string): AsyncGenerator<any> {
  const stream = createReadStream(filePath, { encoding: "utf-8", highWaterMark: 64 * 1024 });
  let depth = 0;       // brace nesting depth (0 = outside any object)
  let inString = false; // inside a JSON string literal
  let escape = false;   // previous char was backslash inside a string
  let objStart = -1;    // char index within current buffer where current object started
  let partial = "";     // leftover chars from previous chunk when object spans chunks

  for await (const chunk of stream) {
    const text = chunk as string;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      if (escape) { escape = false; continue; }
      if (inString) {
        if (ch === "\\") { escape = true; continue; }
        if (ch === '"') { inString = false; }
        continue;
      }

      // Outside a string
      if (ch === '"') { inString = true; continue; }
      if (ch === "{") {
        if (depth === 0) { objStart = i; }
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0 && objStart !== -1) {
          // Complete object found
          const objStr = partial + text.slice(objStart, i + 1);
          partial = "";
          objStart = -1;
          yield JSON.parse(objStr);
        } else if (depth === 0 && partial.length > 0) {
          // Object started in a previous chunk and ends here
          const objStr = partial + text.slice(0, i + 1);
          partial = "";
          yield JSON.parse(objStr);
        }
      }
    }

    // If we're mid-object at end of chunk, save the partial
    if (depth > 0) {
      if (objStart !== -1) {
        partial += text.slice(objStart);
        objStart = -1; // reset — continuation is in `partial`
      } else {
        partial += text;
      }
    }
  }
}

/**
 * Stream-parse a large JSON array file and insert rows in batches.
 * Keeps memory bounded: only one batch (BATCH_SIZE rows) is alive at a time.
 * Returns the total number of rows inserted.
 */
async function importTableStreaming(
  tx: any,
  table: PgTable,
  tableName: string,
  filePath: string,
  pk: { jsKey: string; col: any } | null,
  updateSet: Record<string, any>,
  logger: ReturnType<typeof createLogger>,
): Promise<number> {
  const BATCH_SIZE = 500;
  let batch: any[] = [];
  let totalImported = 0;
  let batchNum = 0;

  async function flushBatch(sp: any) {
    if (batch.length === 0) return;
    const insert = sp.insert(table).values(batch);
    if (pk && Object.keys(updateSet).length > 0) {
      await insert.onConflictDoUpdate({ target: pk.col, set: updateSet });
    } else {
      await insert.onConflictDoNothing();
    }
    batchNum++;
    totalImported += batch.length;
    if (batchNum % 10 === 0 || batchNum <= 3) {
      logger.log(`[Import] ${tableName}: batch ${batchNum} (${batch.length} rows, total ${totalImported})`);
    }
    batch = [];
  }

  // Run inside a savepoint so a per-table failure doesn't abort the
  // outer transaction.
  await tx.transaction(async (sp: any) => {
    for await (const obj of streamJsonArrayFile(filePath)) {
      batch.push(hydrateRow(obj));
      if (batch.length >= BATCH_SIZE) {
        await flushBatch(sp);
      }
    }
    // Flush remaining rows
    await flushBatch(sp);
  });

  logger.log(`[Import] ${tableName}: stream complete (${totalImported} rows in ${batchNum} batches)`);
  return totalImported;
}

// Promote every FK constraint on the registry tables to DEFERRABLE
// INITIALLY IMMEDIATE so per-table `SET CONSTRAINTS ALL DEFERRED` inside
// the import transaction actually defers them. Postgres only honors
// SET CONSTRAINTS for constraints declared DEFERRABLE; Drizzle's default
// `.references(...)` produces NOT DEFERRABLE FKs, which is the exact
// reason child-before-parent inserts on `library_pages.parent_id` were
// rejected and the whole batch failed.
//
// Idempotent: ALTER ... DEFERRABLE on an already-deferrable constraint
// is a no-op (the catalog query filters those out). Runs once per
// import; the change is persistent in the target DB so subsequent
// syncs skip it entirely.
async function ensureFkConstraintsDeferrable(): Promise<void> {
  const tableNames = INSERT_ORDER.map((e) => getTableName(e.table));
  const result = await db.execute<{ table_name: string; conname: string }>(sql`
    SELECT c.relname AS table_name, con.conname AS conname
    FROM pg_constraint con
    JOIN pg_class c ON con.conrelid = c.oid
    JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE con.contype = 'f'
      AND NOT con.condeferrable
      AND n.nspname = ANY (current_schemas(false))
      AND c.relname = ANY (ARRAY[${sql.join(tableNames, sql`, `)}]::text[])
  `);
  const rows = (result as unknown as { rows?: Array<{ table_name: string; conname: string }> }).rows
    ?? (result as unknown as Array<{ table_name: string; conname: string }>);
  if (!Array.isArray(rows) || rows.length === 0) {
    log.debug("FK deferral: all registry FKs already DEFERRABLE");
    return;
  }
  log.debug(`FK deferral: promoting ${rows.length} FK constraint(s) to DEFERRABLE INITIALLY IMMEDIATE`);
  for (const r of rows) {
    try {
      await db.execute(sql.raw(
        `ALTER TABLE ${quoteIdent(r.table_name)} ALTER CONSTRAINT ${quoteIdent(r.conname)} DEFERRABLE INITIALLY IMMEDIATE`,
      ));
    } catch (err: any) {
      // Non-fatal — log and continue. SET CONSTRAINTS ALL DEFERRED for this
      // FK will silently no-op, but the post-import row-count parity check
      // will surface any rows that get rejected.
      log.warn(`FK deferral: failed for ${r.table_name}.${r.conname}: ${err?.message ?? err}`);
    }
  }
}

export async function importDbTables(dbDir: string): Promise<ImportDbResult> {
  const imported: Record<string, number> = {};
  const expected: Record<string, number> = {};
  const failed: string[] = [];
  const failures: ImportTableFailure[] = [];

  log.debug("Running DB Sync schema bootstrap via app auto-heal");
  await runSchemaBootstrap("db-sync", INSERT_ORDER.map((entry) => entry.table));
  log.debug("DB Sync schema bootstrap complete");

  // Make every registry FK DEFERRABLE so the per-table SET CONSTRAINTS
  // ALL DEFERRED below actually defers self-referencing checks
  // (library_pages.parent_id) and cross-table FKs to commit time.
  // Without this, Drizzle's default NOT DEFERRABLE constraints reject
  // child-before-parent inserts immediately, which is what dropped
  // library_pages rows in the first place.
  try {
    await ensureFkConstraintsDeferrable();
  } catch (err: any) {
    log.warn(`FK deferral pass failed (non-fatal): ${err?.message ?? err}`);
  }

  // ── TRANSACTIONAL IMPORT ────────────────────────────────────────
  // Wrap the entire delete-then-insert sequence in a single Postgres
  // transaction. If the process dies mid-import (e.g. Railway deploy
  // kills the container), the uncommitted transaction is automatically
  // rolled back by PostgreSQL and the original data is preserved.
  // Individual table operations use savepoints (via nested
  // tx.transaction()) so we can capture precise per-table diagnostics.
  // Restore still fails closed below: if any table fails or has row-count
  // mismatch, we throw inside this transaction so Postgres rolls the entire
  // delete-then-insert sequence back instead of leaving a partial restore.
  return await db.transaction(async (tx) => {

  // Defer all FK constraints for the duration of this transaction so
  // insert ordering doesn't matter.
  await tx.execute(sql.raw("SET CONSTRAINTS ALL DEFERRED"));
  await tx.execute(sql.raw("SET LOCAL statement_timeout = 0"));

  log.debug(`Deleting existing data from ${DELETE_ORDER.length} tables`);
  for (const { key, table } of DELETE_ORDER) {
    const filePath = join(dbDir, `${key}.json`);
    if (await pathExists(filePath)) {
      try {
        // Wrap each delete in a savepoint so a failure doesn't abort
        // the outer transaction — the ON CONFLICT fallback still works.
        await tx.transaction(async (sp) => { await sp.delete(table); });
        log.debug(`Cleared ${key}`);
      } catch (err: any) {
        // Non-fatal here: the per-table import below uses ON CONFLICT
        // (DO UPDATE / DO NOTHING) so leftover rows from a failed delete
        // don't block the insert. The post-import row-count parity
        // check is the real safety net for missing rows.
        log.warn(`Failed to clear ${key} (will rely on ON CONFLICT): ${err.message}`);
      }
    }
  }

  log.debug(`Inserting data into ${INSERT_ORDER.length} tables`);

  for (const entry of INSERT_ORDER) {
    const { key, table } = entry;
    const filePath = join(dbDir, `${key}.json`);
    if (!await pathExists(filePath)) {
      imported[key] = 0;
      expected[key] = 0;
      continue;
    }

    const tableStart = Date.now();
    try {
      // ── Route by file size ────────────────────────────────────────
      // Tables larger than STREAM_THRESHOLD_BYTES are stream-parsed to
      // keep memory bounded. Small tables and tables with special
      // pre-processing (library_pages orphan heal, parentBackfill) use
      // the buffered path.
      const fileStat = await stat(filePath);
      const fileSizeMB = (fileStat.size / (1024 * 1024)).toFixed(1);
      const needsSpecialHandling = key === "library_pages" || key === "library_page_views" || key === "messages";
      const useStreaming = fileStat.size > STREAM_THRESHOLD_BYTES && !needsSpecialHandling;

      // Build ON CONFLICT clause (shared by both paths). Tables with a
      // single PK column use DO UPDATE so a re-sync overwrites stale
      // target rows with source values. Composite-PK / multi-PK tables
      // fall back to DO NOTHING.
      const pk = findSinglePkColumn(table);
      const allCols = getTableColumns(table) as Record<string, { name: string }>;
      const updateSet: Record<string, any> = {};
      if (pk) {
        for (const [jsKey, c] of Object.entries(allCols)) {
          if (jsKey === pk.jsKey) continue;
          updateSet[jsKey] = sql.raw(`excluded.${quoteIdent(c.name)}`);
        }
      }

      if (useStreaming) {
        // ── STREAMING PATH ────────────────────────────────────────
        // Stream-parse large JSON files one object at a time to avoid
        // loading the entire file into memory. Inserts in 500-row
        // batches with per-batch logging for crash diagnosis.
        log.debug(`[Import] ${key}: starting (${entry.domain}, ${fileSizeMB} MB — streaming)`);
        const streamedCount = await importTableStreaming(
          tx, table, key, filePath, pk, updateSet, log,
        );
        expected[key] = streamedCount;

        // Sequence reset for streaming tables — we don't have a `rows`
        // array, so query the max id from the DB instead.
        if (entry.hasSerial) {
          try {
            const seqCol = entry.serialCol ?? "id";
            const seqName = entry.serialCol
              ? `${key}_${entry.serialCol}_seq`
              : `${key}_id_seq`;
            const colObj = allCols[seqCol];
            const colName = colObj?.name ?? seqCol;
            // Wrap in savepoint so a failure can't poison the outer transaction.
            await tx.transaction(async (sp: any) => {
              const result = await sp.execute(
                sql.raw(`SELECT COALESCE(MAX(${quoteIdent(colName)}), 0) AS "maxVal" FROM ${quoteIdent(key)}`),
              );
              const maxVal = Number(Array.isArray(result) ? result[0]?.maxVal : (result as any).rows?.[0]?.maxVal);
              if (Number.isFinite(maxVal) && maxVal > 0) {
                await sp.execute(sql.raw(`SELECT setval('${seqName}', ${maxVal}, true)`));
              }
            });
          } catch (err) { log.warn("Sequence reset failed", { key, error: err instanceof Error ? err.message : String(err) }); }
        }

        // Row-count parity for streaming path
        const [{ total }] = await tx
          .select({ total: count() })
          .from(table) as Array<{ total: number }>;
        const actual = Number(total);
        const dur = Date.now() - tableStart;

        if (actual !== streamedCount) {
          const delta = streamedCount - actual;
          const msg = `row-count mismatch: expected ${streamedCount}, got ${actual} (delta ${delta})`;
          imported[key] = actual;
          failed.push(key);
          failures.push({ key, expected: streamedCount, imported: actual, error: msg });
          log.error(`${key}: FAILED — ${msg} (${dur}ms)`);
        } else {
          imported[key] = actual;
          log.debug(`[Import] ${key}: complete (${actual} rows in ${(dur / 1000).toFixed(1)}s)`);
        }
        continue;
      }

      // ── BUFFERED PATH ─────────────────────────────────────────────
      // Small tables and tables needing special pre-processing
      // (library_pages orphan heal, library_page_views FK scrub).
      log.debug(`[Import] ${key}: starting (${entry.domain}, ${fileSizeMB} MB — buffered)`);
      const rows = JSON.parse(await readFile(filePath, "utf-8"));
      if (!Array.isArray(rows) || rows.length === 0) {
        imported[key] = 0;
        expected[key] = 0;
        continue;
      }

      expected[key] = rows.length;

      const hydratedRows = rows.map((row: any) => hydrateRow({ ...row }));

      // ── FK orphan auto-heal ─────────────────────────────────────
      // The deferred-FK + DEFERRABLE-promotion machinery handles
      // ordering, but it cannot rescue source dumps that contain rows
      // pointing at parent ids which were never exported (orphans
      // accumulated over time on the source side). Those still get
      // rejected at commit time and abort the whole batch (0/N).
      //
      // We pre-scrub known offenders here:
      //   • library_pages.parent_id — self-FK, NULLABLE → null orphans
      //   • library_page_views.page_id — FK → library_pages, NOT NULL → drop
      //   • messages.conversation_id — FK → sessions, NOT NULL → drop
      // These degrade gracefully: orphan parent_ids become top-level pages,
      // orphan view rows are analytics records, and orphan messages cannot
      // render without their parent session anyway.
      let workingRows = hydratedRows;
      let orphanNulled = 0;
      let orphanDropped = 0;
      // NOTE: the export emits Drizzle JS keys (camelCase), not raw
      // Postgres column names — both the buffered and streaming paths
      // alias columns to JS keys (see buildAliasedSelectSQL). So we
      // check `parentId` / `pageId`, not `parent_id` / `page_id`.
      //
      // For `library_pages` we ALSO stash original parentId values and
      // null them out for the bulk insert. We re-apply the parents in
      // a second-pass UPDATE inside the same transaction, after every
      // row exists. This sidesteps the entire DEFERRABLE question:
      // child-before-parent ordering inside the batched insert can no
      // longer trigger fk_library_pages_parent because every row is
      // inserted with parent_id = NULL.
      const parentBackfill: Array<{ id: string; parentId: string }> = [];
      if (key === "library_pages") {
        const pageIds = new Set(hydratedRows.map((r: any) => r.id));
        for (const r of hydratedRows) {
          if (r.parentId && !pageIds.has(r.parentId)) {
            r.parentId = null;
            orphanNulled++;
          }
          if (r.parentId) {
            parentBackfill.push({ id: r.id, parentId: r.parentId });
            r.parentId = null;
          }
        }
      } else if (key === "library_page_views") {
        const parentPath = join(dbDir, "library_pages.json");
        if (await pathExists(parentPath)) {
          try {
            const parents = JSON.parse(await readFile(parentPath, "utf-8"));
            const parentIds = new Set((parents as any[]).map((r) => r.id));
            workingRows = hydratedRows.filter((r: any) => {
              if (parentIds.has(r.pageId)) return true;
              orphanDropped++;
              return false;
            });
          } catch (err: any) {
            log.warn(`${key}: orphan-scrub failed to read library_pages.json: ${err?.message ?? err}`);
          }
        }
      } else if (key === "messages") {
        const parentPath = join(dbDir, "sessions.json");
        if (await pathExists(parentPath)) {
          try {
            const parents = JSON.parse(await readFile(parentPath, "utf-8"));
            const parentIds = new Set((parents as any[]).map((r) => r.id));
            workingRows = hydratedRows.filter((r: any) => {
              if (parentIds.has(r.sessionId)) return true;
              orphanDropped++;
              return false;
            });
          } catch (err: any) {
            log.warn(`${key}: orphan-scrub failed to read sessions.json: ${err?.message ?? err}`);
          }
        }
      }
      if (orphanNulled > 0) {
        log.warn(`${key}: nulled ${orphanNulled} orphan parent_id refs (auto-heal)`);
      }
      if (orphanDropped > 0) {
        log.warn(`${key}: dropped ${orphanDropped} orphan rows with missing parent (auto-heal)`);
      }
      // After auto-heal, the source-of-truth row count is workingRows.
      const expectedCount = workingRows.length;
      expected[key] = expectedCount;

      // Use a savepoint (nested transaction) for each table so a
      // per-table error doesn't abort the outer import transaction.
      await tx.transaction(async (sp: any) => {
        const batchSize = 100;
        for (let i = 0; i < workingRows.length; i += batchSize) {
          const batch = workingRows.slice(i, i + batchSize);
          const insert = sp.insert(table).values(batch);
          if (pk && Object.keys(updateSet).length > 0) {
            await insert.onConflictDoUpdate({
              target: pk.col,
              set: updateSet,
            });
          } else {
            await insert.onConflictDoNothing();
          }
        }

        // Second-pass parentId backfill for library_pages.
        if (parentBackfill.length > 0) {
          const updateBatch = 200;
          for (let i = 0; i < parentBackfill.length; i += updateBatch) {
            const chunk = parentBackfill.slice(i, i + updateBatch);
            const tuples = chunk.map(
              (p) => sql`(${p.id}::text, ${p.parentId}::text)`,
            );
            await sp.execute(sql`
              UPDATE library_pages AS lp
              SET parent_id = v.parent_id
              FROM (VALUES ${sql.join(tuples, sql`, `)}) AS v(id, parent_id)
              WHERE lp.id = v.id
            `);
          }
          log.debug(`${key}: backfilled ${parentBackfill.length} parent_id refs in second pass`);
        }
      });

      if (entry.hasSerial) {
        try {
          const seqCol = entry.serialCol ?? "id";
          const seqName = entry.serialCol
            ? `${key}_${entry.serialCol}_seq`
            : `${key}_id_seq`;
          const colName = seqCol;  // serialCol is already the SQL column name
          // Query the actual DB for max value — avoids camelCase/snake_case
          // mismatch when scanning JS rows from the JSON export.
          // Wrap in savepoint so a failure can't poison the outer transaction.
          await tx.transaction(async (sp: any) => {
            const result = await sp.execute(
              sql.raw(`SELECT COALESCE(MAX("${colName}"), 0) AS "maxVal" FROM "${key}"`),
            );
            const maxVal = Number(Array.isArray(result) ? result[0]?.maxVal : (result as any).rows?.[0]?.maxVal);
            if (Number.isFinite(maxVal) && maxVal > 0) {
              await sp.execute(sql.raw(`SELECT setval('${seqName}', ${maxVal}, true)`));
            }
          });
        } catch (err) { log.warn("Sequence reset failed", { key, error: err instanceof Error ? err.message : String(err) }); }
      }

      // Row-count parity assertion
      const [{ total }] = await tx
        .select({ total: count() })
        .from(table) as Array<{ total: number }>;
      const actual = Number(total);

      if (actual !== expectedCount) {
        const delta = expectedCount - actual;
        const msg = `row-count mismatch: expected ${expectedCount}, got ${actual} (delta ${delta})`;
        imported[key] = actual;
        failed.push(key);
        failures.push({ key, expected: expectedCount, imported: actual, error: msg });
        log.error(`${key}: FAILED — ${msg}`);
        continue;
      }

      const dur = Date.now() - tableStart;
      imported[key] = expectedCount;
      const skippedNote = (orphanNulled || orphanDropped)
        ? ` (auto-heal: nulled=${orphanNulled} dropped=${orphanDropped})`
        : "";
      log.debug(`[Import] ${key}: complete (${expectedCount} rows in ${(dur / 1000).toFixed(1)}s)${skippedNote}`);
    } catch (err: any) {
      const dur = Date.now() - tableStart;
      const exp = expected[key] ?? 0;
      imported[key] = 0;
      failed.push(key);
      failures.push({ key, expected: exp, imported: 0, error: err.message });
      log.error(`${key}: FAILED (${dur}ms) - ${err.message}`);
    }
  }

  if (failed.length > 0) {
    const detail = failures
      .map((f) => `${f.key}: expected ${f.expected}, imported ${f.imported} — ${f.error}`)
      .join("; ");
    throw new Error(`Database restore failed for ${failed.length} table(s): ${detail}`);
  }

  return { imported, expected, failed, failures };

  }); // end db.transaction

}

export async function registerBrainRoutes(app: Express) {
  app.use("/api/brain", (req, res, next) => {
    const isSignedDbSyncRequest =
      (req.method === "POST" && req.path === "/import") ||
      (req.method === "GET" && req.path === "/db-identity");
    if (isSignedDbSyncRequest && verifyDbSyncImportAuthHeader(req, getDbSyncImportSecretFromEnv())) {
      return next();
    }
    return requireAuth(req, res, (authErr?: unknown) => {
      if (authErr) return next(authErr);
      return requireAdmin(req, res, next);
    });
  });

  app.get("/api/brain/db-identity", (_req, res) => {
    const url = process.env.DATABASE_URL;
    if (!url) return res.status(500).json({ error: "DATABASE_URL not set" });
    try {
      const fingerprint = fingerprintDbUrl(url);
      res.json({
        fingerprint,
        redactedUrl: redactDbUrl(url),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });


  const exportBodySchema = z.object({
    mode: z.enum(["schema", "data", "data_plus"]).optional().default("data_plus"),
  });




  app.post("/api/brain/export", async (req, res) => {
    try {
      const parsed = exportBodySchema.safeParse(req.body ?? {});
      const mode: ExportMode = parsed.success ? parsed.data.mode : "data_plus";

      const result = await exportBrain({ mode });

      res.json({
        downloadUrl: `/api/brain/download/${result.archiveName}`,
        filename: result.archiveName,
        sizeBytes: result.sizeBytes,
        format: BRAIN_FORMAT_VERSION,
        mode: result.mode,
        totalRows: result.totalRows,
        totalTables: result.totalTables,
        failedTables: result.failedTables,
        summary: result.domains,
      });
    } catch (error: any) {
      log.error(`Export fatal error: ${error.message}`);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/brain/download/:filename", async (req, res) => {
    const filename = req.params.filename;
    if (!filename.endsWith(".tar.gz") || filename.includes("..")) {
      return res.status(400).json({ error: "Invalid filename" });
    }
    const filePath = join(BRAIN_EXPORT_DIR, filename);
    if (!await pathExists(filePath)) {
      return res.status(404).json({ error: "File not found" });
    }
    res.download(filePath, filename, { dotfiles: "allow" }, (err) => {
      if (!err) {
        unlink(filePath).catch(err => log.debug("brain export cleanup failed", err));
      }
    });
  });

  async function importLegacyFiles(filesDir: string): Promise<Record<string, number>> {
    const summary: Record<string, number> = {};
    const { setSetting } = await import("../system-settings");
    const { documentStorage } = await import("../memory/document-storage");

    const configDir = join(filesDir, "workspace", "config");
    if (await pathExists(configDir)) {
      const configMappings: Record<string, string> = {
        "profiles.json": "model_profiles",
        "voice-prompts.json": "voice_prompts",
        "current-agenda.json": "current_agenda",
        "agenda-history.json": "agenda_history",
        "weekly-priorities.json": "weekly_priorities",
        "import-queue.json": "import_queue",
        "tool_stats.json": "tool_stats",
      };
      let configCount = 0;
      for (const [file, dbKey] of Object.entries(configMappings)) {
        const cfgPath = join(configDir, file);
        if (await pathExists(cfgPath)) {
          try {
            const data = JSON.parse(await readFile(cfgPath, "utf-8"));
            await setSetting(dbKey, data);
            configCount++;
          } catch (err) { log.warn("config import failed", cfgPath, err); }
        }
      }
      summary.configFiles = configCount;
    }

    const openclawJson = join(filesDir, "openclaw.json");
    if (await pathExists(openclawJson)) {
      try {
        const legacyConfig = JSON.parse(await readFile(openclawJson, "utf-8"));
        await setSetting("agent_config", legacyConfig);
      } catch (err) { log.warn("legacy openclaw config import failed", err); }
    }

    const workspaceDir = join(filesDir, "workspace");
    if (!await pathExists(workspaceDir)) return summary;

    await db.delete(memoryEntries).where(eq(memoryEntries.layer, "workspace"));

    const yamlLib = await import("yaml");
    function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
      const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
      if (!match) return { meta: {}, body: raw };
      try {
        const meta = yamlLib.parse(match[1]) || {};
        return { meta, body: match[2] };
      } catch (e: any) {
        log.error(`YAML parse error: ${e.message}`);
        return { meta: {}, body: match[2] };
      }
    }

    async function safeReadDir(dir: string): Promise<string[]> {
      try {
        if (!await pathExists(dir)) return [];
        return (await readdir(dir)).filter(f => !f.startsWith("."));
      } catch { return []; }
    }

    async function importJsonDir(
      dir: string,
      docType: string,
      titleKey: string
    ): Promise<number> {
      const files = (await safeReadDir(dir)).filter(f => f.endsWith(".json") && f !== "index.json");
      let count = 0;
      for (const file of files) {
        try {
          const raw = await readFile(join(dir, file), "utf-8");
          const obj = JSON.parse(raw);
          const docId = String(obj.id || file.replace(/\.json$/, ""));
          const title = String(obj[titleKey] || obj.title || obj.name || "Untitled");
          const ts = {
            createdAt: obj.createdAt ? new Date(obj.createdAt) : undefined,
            updatedAt: obj.updatedAt ? new Date(obj.updatedAt) : undefined,
          };
          await documentStorage.upsertDocument(
            docType as any,
            docId,
            `${docType}s/${docId}.json`,
            title,
            raw,
            obj,
            ts
          );
          count++;
        } catch (e: any) {
          log.error(`Failed to import ${docType} ${file}: ${e.message}`);
        }
      }
      return count;
    }

    function parsePersonBody(body: string): { interactions: any[]; notes: any[] } {
      const interactions: any[] = [];
      const notes: any[] = [];

      const interactionsMatch = body.match(/## Interactions\s*\n([\s\S]*?)(?=\n## |\s*$)/);
      if (interactionsMatch) {
        const blocks = interactionsMatch[1].split(/\n### /).map(b => b.replace(/^### /, "")).filter(b => b.trim());
        for (const block of blocks) {
          const headerMatch = block.match(/^(\d{4}-\d{2}-\d{2})\s*[—–-]\s*(.+?)\s*\n/);
          if (!headerMatch) continue;
          const [, date, type] = headerMatch;
          const rest = block.slice(headerMatch[0].length);
          const idMatch = rest.match(/^- id:\s*(\S+)\s*\n/);
          const id = idMatch ? idMatch[1] : `ix-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const afterId = idMatch ? rest.slice(idMatch[0].length) : rest;
          const contextLines: string[] = [];
          const summaryLines: string[] = [];
          for (const line of afterId.split("\n")) {
            if (line.startsWith("> ")) {
              contextLines.push(line.slice(2));
            } else {
              summaryLines.push(line);
            }
          }
          const summary = summaryLines.join("\n").trim();
          const context = contextLines.length > 0 ? contextLines.join("\n").trim() : undefined;
          interactions.push({
            id,
            date,
            type: type.trim(),
            summary,
            ...(context ? { context } : {}),
          });
        }
      }

      const notesMatch = body.match(/## Notes\s*\n([\s\S]*?)(?=\n## |\s*$)/);
      if (notesMatch) {
        const blocks = notesMatch[1].split(/\n### /).map(b => b.replace(/^### /, "")).filter(b => b.trim());
        for (const block of blocks) {
          const lines = block.split("\n");
          const noteId = lines[0].trim();
          let createdAt = new Date().toISOString();
          let updatedAt = createdAt;
          const contentLines: string[] = [];
          let pastMeta = false;
          for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            const createdMatch = line.match(/^- created:\s*(.+)/);
            const updatedMatch = line.match(/^- updated:\s*(.+)/);
            if (createdMatch) { createdAt = createdMatch[1].trim(); continue; }
            if (updatedMatch) { updatedAt = updatedMatch[1].trim(); pastMeta = true; continue; }
            if (!pastMeta && line.trim() === "") continue;
            pastMeta = true;
            contentLines.push(line);
          }
          notes.push({
            id: noteId,
            content: contentLines.join("\n").trim(),
            createdAt,
            updatedAt,
          });
        }
      }

      return { interactions, notes };
    }

    async function importMdDir(
      dir: string,
      docType: string,
      titleKey: string
    ): Promise<number> {
      const files = (await safeReadDir(dir)).filter(f => f.endsWith(".md"));
      let count = 0;
      for (const file of files) {
        try {
          const raw = await readFile(join(dir, file), "utf-8");
          const { meta, body } = parseFrontmatter(raw);
          const docId = String(meta.id || file.replace(/\.md$/, ""));
          const title = String(meta[titleKey] || meta.title || meta.name || file.replace(/\.md$/, ""));
          const ts = {
            createdAt: meta.createdAt ? new Date(meta.createdAt as any) : undefined,
            updatedAt: meta.updatedAt ? new Date(meta.updatedAt as any) : undefined,
          };

          if (docType === "person" && body) {
            const { interactions, notes } = parsePersonBody(body);
            if (interactions.length > 0 && !Array.isArray(meta.interactions)) {
              meta.interactions = interactions;
            }
            if (notes.length > 0 && !Array.isArray(meta.notes)) {
              meta.notes = notes;
            }
          }

          await documentStorage.upsertDocument(
            docType as any,
            docId,
            `${docType}s/${docId}.md`,
            title,
            body,
            meta,
            ts
          );
          count++;
        } catch (e: any) {
          log.error(`Failed to import ${docType} ${file}: ${e.message}`);
        }
      }
      return count;
    }

    const principlesDir = join(workspaceDir, "principles");
    if (await pathExists(principlesDir)) {
      summary.principles = await importJsonDir(principlesDir, "principle", "title");
    }

    const tasksDir = join(workspaceDir, "tasks");
    if (await pathExists(tasksDir)) {
      summary.tasks = await importMdDir(tasksDir, "task", "title");
    }

    const peopleDir = join(workspaceDir, "people");
    if (await pathExists(peopleDir)) {
      summary.people = await importMdDir(peopleDir, "person", "name");
    }

    const projectsDir = join(workspaceDir, "projects");
    if (await pathExists(projectsDir)) {
      summary.projects = await importMdDir(projectsDir, "project", "title");
    }

    const issuesDir = join(workspaceDir, "issues");
    if (await pathExists(issuesDir)) {
      summary.issues = await importMdDir(issuesDir, "issue", "title");
    }

    const goalsLifeDir = join(workspaceDir, "goals", "life");
    if (await pathExists(goalsLifeDir)) {
      summary.lifeGoals = await importJsonDir(goalsLifeDir, "goal", "shortName");
    }

    // Legacy check-in import removed — goals now stored in GoalsService

    const tagsIndex = join(workspaceDir, "tags", "index.json");
    if (await pathExists(tagsIndex)) {
      try {
        const raw = await readFile(tagsIndex, "utf-8");
        const obj = JSON.parse(raw);
        const tags = obj.tags || obj;
        let tagCount = 0;
        for (const [slug, tagData] of Object.entries(tags)) {
          const td = tagData as any;
          await documentStorage.upsertDocument(
            "tag" as any,
            slug,
            `tags/${slug}.json`,
            td.label || slug,
            JSON.stringify(td),
            td,
            {
              createdAt: td.createdAt ? new Date(td.createdAt) : undefined,
              updatedAt: td.updatedAt ? new Date(td.updatedAt) : undefined,
            }
          );
          tagCount++;
        }
        summary.tags = tagCount;
      } catch (err) { log.warn("tag import failed", err); }
    }

    const identityFiles = ["SOUL.md", "USER.md", "IDENTITY.md", "PRINCIPLES.md", "SKILL.md", "TOOLS.md"];
    let identityCount = 0;
    for (const file of identityFiles) {
      const filePath = join(workspaceDir, file);
      if (await pathExists(filePath)) {
        try {
          const raw = await readFile(filePath, "utf-8");
          const docId = file.replace(/\.md$/, "").toLowerCase();
          await documentStorage.upsertDocument(
            "identity" as any,
            docId,
            `identity/${docId}.md`,
            file.replace(/\.md$/, ""),
            raw,
            { filename: file }
          );
          identityCount++;
        } catch (err) { log.warn("identity file import failed", file, err); }
      }
    }
    if (identityCount > 0) summary.identityFiles = identityCount;

    const plansDir = join(workspaceDir, "plans");
    if (await pathExists(plansDir)) {
      const mdCount = await importMdDir(plansDir, "template", "title");
      summary.plans = mdCount;
    }

    return summary;
  }

  app.post("/api/brain/import", async (req, res) => {
    const multer = (await import("multer")).default;
    // 4 GB cap; Data+ archives can exceed 1 GB. Multer streams to disk.
    const upload = multer({ dest: "/tmp/brain-uploads/", limits: { fileSize: 4 * 1024 * 1024 * 1024 } });

    upload.single("brain")(req, res, async (err: any) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      const uploadedPath = req.file.path;
      const extractDir = join("/tmp/brain-imports", `import-${Date.now()}`);

      try {
        await mkdir(extractDir, { recursive: true });

        const { stdout: listOutput } = await execAsyncBrain(`tar -tzf "${uploadedPath}" 2>/dev/null`, { timeout: 30000 });
        const tarEntries = listOutput.split("\n").filter(Boolean);
        const hasDangerousPath = tarEntries.some(e => e.includes("..") || e.startsWith("/") || e.includes("\\"));
        if (hasDangerousPath) {
          return res.status(400).json({ error: "Archive contains unsafe paths" });
        }

        await runTar(["-xzf", uploadedPath, "-C", extractDir], 600_000);

        const entries = await readdir(extractDir);
        const brainDir = entries.length === 1 ? join(extractDir, entries[0]) : extractDir;

        const dbDir = join(brainDir, "db");
        const filesDir = join(brainDir, "files");
        const manifestPath = join(brainDir, "manifest.json");

        let detectedFormat = "legacy-v1";
        if (await pathExists(manifestPath)) {
          try {
            const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
            detectedFormat = manifest.format || "legacy-v1";
          } catch (err) { log.debug("manifest parse failed", err); }
        }

        const summary: Record<string, unknown> = { detectedFormat };

        if (!await pathExists(dbDir)) {
          return res.status(400).json({ error: "Invalid brain archive: missing db/ directory" });
        }

        const dbResult = await importDbTables(dbDir);
        summary.tables = dbResult.imported;
        summary.expected = dbResult.expected;
        summary.failedTables = dbResult.failed;
        summary.failures = dbResult.failures;

        if (await pathExists(filesDir)) {
          const fileSummary = await importLegacyFiles(filesDir);
          summary.legacyFiles = fileSummary;
        }

        const totalImported = Object.values(dbResult.imported).reduce((s, n) => s + n, 0);
        log.debug(`Import complete: ${totalImported} rows imported, ${dbResult.failed.length} failures`);

        if (dbResult.failed.length > 0) {
          // Surface as 5xx so the source-side sync orchestrator marks the
          // sync as failed rather than silently reporting success while
          // rows are missing on the target. Failures include per-table
          // expected/imported counts so the UI can show the delta.
          const summaryStr = dbResult.failures
            .map((f) => `${f.key} (${f.imported}/${f.expected}): ${f.error}`)
            .join("; ");
          return res.status(500).json({
            error: `Import incomplete — ${dbResult.failed.length} table(s) failed: ${summaryStr}`,
            format: detectedFormat,
            summary,
          });
        }

        res.json({ message: "Brain imported successfully", format: detectedFormat, summary });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      } finally {
        try { await unlink(uploadedPath); } catch (err) { log.debug("upload cleanup failed", err); }
        try { await rm(extractDir, { recursive: true, force: true }); } catch (err) { log.debug("extract dir cleanup failed", err); }
      }
    });
  });

  // ── Work: Tasks & Projects ──────────────────────────────────────
  const { fileTaskStorage } = await import("../file-storage/tasks");
  const { fileProjectStorage } = await import("../file-storage/projects");
  const { insertTaskSchema, insertProjectSchema } = await import("@shared/models/work");

}
