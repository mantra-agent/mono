import { pool } from "./db";
import { classifyApiRequest, getApiPolicyStatus } from "./api-policy";
import { getPrincipalDiagnosticSnapshot } from "./principal-diagnostics";

interface ProtectedTableDiagnostic {
  table: string;
  exists: boolean;
  totalRows: number;
  unownedRows: number;
  missingScopeRows?: number;
  globalRows?: number;
  userRows?: number;
  sampleIds: string[];
  error?: string;
}

const OWNER_TABLES_WITH_SCOPE = [
  "sessions",
  "messages",
  "workspace_documents",
  "memory_entries",
  "memory_entity_links",
  "info_notes",
  "library_pages",
  "library_page_links",
  "library_annotations",
  "library_page_views",
  "emotional_states",
  "personas",
  "magic_demo_sessions",
  "media_items",
  "render_jobs",
  "skills",
  "theses",
  "content_queue",
  "thoughts",
  "system_hooks",
  "signal_sources",
  "signal_items",
  "scan_runs",
  "tasks",
  "projects",
  "persons",
  "person_merge_aliases",
  "principles",

] as const;

const OWNER_TABLES_NO_SCOPE = [
  "connected_accounts",
  "email_triage_log",
  "email_messages",
  "email_sync_cursors",
  "email_drafts",
  "calendar_event_metadata",
  "email_sync_log",
  "email_enrichments",
  "email_dismissals",
  "magic_demo_session_events",
  "magic_demo_vision_frames",
  "skill_runs",
  "skill_failure_dismissals",
  "plaid_accounts",
  "plaid_transactions",
  "plaid_holdings",
  "plaid_liabilities",
  "plaid_sync_cursors",
  "manual_assets",
  "manual_liabilities",
  "financial_goals",
  "recurring_expenses",
  "budget_entries",
  "budget_monthly_overrides",
  "income_sources",
  "income_deductions",
  "income_deposits",
  "debt_payments",
  "financed_assets",
  "manual_401k_accounts",
  "future_cash_events",
  "transaction_amortizations",
  "health_metrics",
  "wellness_activities",
  "wellness_logs",
  "gratitude_entries",
  "learning_entries",
  "export_jobs",
  "indexed_content",
] as const;

const ROUTE_FILES = [
  "server/routes.ts",
  "server/routes/index.ts",
  "server/routes/admin.ts",
  "server/routes/backup.ts",
  "server/routes/brain.ts",
  "server/routes/captures.ts",
  "server/routes/cognition.ts",
  "server/routes/content.ts",
  "server/routes/db-sync.ts",
  "server/routes/diag.ts",
  "server/routes/events.ts",
  "server/routes/exec.ts",
  "server/routes/finance.ts",
  "server/routes/gateway.ts",
  "server/routes/wellness.ts",
  "server/routes/hooks.ts",
  "server/routes/identity.ts",
  "server/routes/inference.ts",
  "server/routes/info.ts",
  "server/routes/integrations.ts",
  "server/routes/magic-demo.ts",
  "server/routes/maintenance.ts",
  "server/routes/mobile-telemetry.ts",
  "server/routes/oura.ts",
  "server/routes/plaid.ts",
  "server/routes/secrets.ts",
  "server/routes/session-display.ts",
  "server/routes/session-reminder.ts",
  "server/routes/setup.ts",
  "server/routes/simple.ts",
  "server/routes/system.ts",
  "server/routes/version.ts",
  "server/routes/voice-config.ts",
  "server/routes/voice-engine.ts",
  "server/routes/voice-session.ts",
  "server/routes/voice.ts",
  "server/routes/work.ts",
  "server/routes/workspace.ts",
  "server/calendar-routes.ts",
  "server/context-routes.ts",
  "server/decisions-routes.ts",
  "server/export-routes.ts",
  "server/goal-routes.ts",
  "server/landscape-routes.ts",
  "server/memory/memory-routes.ts",
  "server/memory/migration-routes.ts",
  "server/object_storage/routes.ts",
  "server/people-routes.ts",
  "server/skill-routes.ts",
  "server/strategy-routes.ts",
  "server/tag-routes.ts",
  "server/thesis-routes.ts",
  "server/thought-routes.ts",
  "server/timer-routes.ts",
  "server/media/media-routes.ts",
  "server/media/render-routes.ts",
  "server/integrations/railway/routes.ts",
] as const;

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function tableExists(table: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1) AS exists`,
    [table],
  );
  return !!result.rows[0]?.exists;
}

async function tableHasColumns(table: string, columns: string[]): Promise<{ ok: boolean; missing: string[] }> {
  const result = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = ANY($2::text[])`,
    [table, columns],
  );
  const present = new Set(result.rows.map((row) => row.column_name));
  const missing = columns.filter((column) => !present.has(column));
  return { ok: missing.length === 0, missing };
}

function sampleExpression(_table: string): string {
  return "ctid::text";
}

async function diagnoseOwnerTable(table: string, hasScope: boolean): Promise<ProtectedTableDiagnostic> {
  try {
    if (!(await tableExists(table))) return { table, exists: false, totalRows: 0, unownedRows: 0, sampleIds: [] };
    const requiredColumns = hasScope ? ["owner_user_id", "scope"] : ["owner_user_id"];
    const columnCheck = await tableHasColumns(table, requiredColumns);
    if (!columnCheck.ok) {
      return {
        table,
        exists: true,
        totalRows: 0,
        unownedRows: 0,
        missingScopeRows: hasScope && columnCheck.missing.includes("scope") ? 0 : undefined,
        sampleIds: [],
        error: `missing protected columns: ${columnCheck.missing.join(", ")}`,
      };
    }
    const q = quoteIdent(table);
    const sample = sampleExpression(table);
    const missingScopeSql = hasScope ? `COUNT(*) FILTER (WHERE scope IS NULL OR scope = '')::int AS "missingScopeRows",` : "";
    const scopeCountsSql = hasScope ? `COUNT(*) FILTER (WHERE scope = 'global')::int AS "globalRows", COUNT(*) FILTER (WHERE scope = 'user')::int AS "userRows",` : "";
    const unownedWhere = hasScope
      ? `(COALESCE(scope, 'user') NOT IN ('global', 'public', 'system') AND owner_user_id IS NULL)`
      : `(owner_user_id IS NULL)`;
    const result = await pool.query(`
      SELECT
        COUNT(*)::int AS "totalRows",
        COUNT(*) FILTER (WHERE ${unownedWhere})::int AS "unownedRows",
        ${missingScopeSql}
        ${scopeCountsSql}
        (COALESCE(array_agg(${sample}) FILTER (WHERE ${unownedWhere}), ARRAY[]::text[]))[1:10] AS "sampleIds"
      FROM ${q}
    `);
    const row = result.rows[0] ?? {};
    return {
      table,
      exists: true,
      totalRows: Number(row.totalRows ?? 0),
      unownedRows: Number(row.unownedRows ?? 0),
      missingScopeRows: hasScope ? Number(row.missingScopeRows ?? 0) : undefined,
      globalRows: hasScope ? Number(row.globalRows ?? 0) : undefined,
      userRows: hasScope ? Number(row.userRows ?? 0) : undefined,
      sampleIds: row.sampleIds ?? [],
    };
  } catch (error) {
    return {
      table,
      exists: await tableExists(table).catch(() => false),
      totalRows: 0,
      unownedRows: 0,
      sampleIds: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function diagnoseObjectAcls() {
  try {
    if (!(await tableExists("object_acls"))) {
      return { table: "object_acls", exists: false, totalRows: 0, missingOwnershipRows: 0, missingVisibilityRows: 0, sampleKeys: [] };
    }
    const result = await pool.query(`
      SELECT
        COUNT(*)::int AS "totalRows",
        COUNT(*) FILTER (
          WHERE COALESCE(policy->>'visibility', '') <> 'public'
            AND COALESCE(policy->>'scope', '') NOT IN ('system', 'public')
            AND COALESCE(policy->>'ownerUserId', policy->>'owner', '') = ''
            AND COALESCE(policy->>'accountId', '') = ''
        )::int AS "missingOwnershipRows",
        COUNT(*) FILTER (WHERE COALESCE(policy->>'visibility', '') = '')::int AS "missingVisibilityRows",
        (COALESCE(array_agg(object_key) FILTER (
          WHERE COALESCE(policy->>'visibility', '') <> 'public'
            AND COALESCE(policy->>'scope', '') NOT IN ('system', 'public')
            AND COALESCE(policy->>'ownerUserId', policy->>'owner', '') = ''
            AND COALESCE(policy->>'accountId', '') = ''
        ), ARRAY[]::text[]))[1:10] AS "sampleKeys"
      FROM object_acls
    `);
    return { table: "object_acls", exists: true, ...result.rows[0] };
  } catch (error) {
    return { table: "object_acls", exists: false, totalRows: 0, missingOwnershipRows: 0, missingVisibilityRows: 0, sampleKeys: [], error: error instanceof Error ? error.message : String(error) };
  }
}

async function routeInventory() {
  const { readFile } = await import("node:fs/promises");
  const routes: Array<{ method: string; path: string; file: string; classification: string; reason: string }> = [];
  const routeRegex = /(?:app|router)\.(get|post|put|patch|delete|use)\(\s*(["'`])([^"'`]+)\2/g;
  for (const file of ROUTE_FILES) {
    try {
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(routeRegex)) {
        const method = match[1].toUpperCase();
        const path = match[3];
        if (!path.startsWith("/api") && !path.startsWith("/objects")) continue;
        const evaluation = classifyApiRequest(method === "USE" ? "GET" : method, path);
        routes.push({ method, path, file, classification: evaluation.classification, reason: evaluation.reason });
      }
    } catch {
      // Optional route file may not exist in some deployment slices.
    }
  }
  const unclassified = routes.filter((route) => route.classification === "unclassified");
  return { totalRoutes: routes.length, unclassifiedRoutes: unclassified.length, unclassified, routes };
}

async function privilegedAccessSummary() {
  try {
    if (!(await tableExists("privileged_access_audit"))) return { exists: false, totalRows: 0, byAction: [], recent: [] };
    const [total, byAction, recent] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS count FROM privileged_access_audit`),
      pool.query(`SELECT action, COUNT(*)::int AS count, MAX(created_at) AS "lastAt" FROM privileged_access_audit GROUP BY action ORDER BY count DESC, action LIMIT 30`),
      pool.query(`SELECT id, actor_type AS "actorType", actor_user_id AS "actorUserId", actor_account_id AS "actorAccountId", action, reason, scopes, metadata, created_at AS "createdAt" FROM privileged_access_audit ORDER BY created_at DESC LIMIT 50`),
    ]);
    return { exists: true, totalRows: total.rows[0]?.count ?? 0, byAction: byAction.rows, recent: recent.rows };
  } catch (error) {
    return { exists: false, totalRows: 0, byAction: [], recent: [], error: error instanceof Error ? error.message : String(error) };
  }
}

export async function buildMultiUserDiagnosticsReport() {
  const protectedTables = [
    ...(await Promise.all(OWNER_TABLES_WITH_SCOPE.map((table) => diagnoseOwnerTable(table, true)))),
    ...(await Promise.all(OWNER_TABLES_NO_SCOPE.map((table) => diagnoseOwnerTable(table, false)))),
  ];
  const existingProtectedTables = protectedTables.filter((table) => table.exists);
  const problemTables = existingProtectedTables.filter((table) => table.unownedRows > 0 || (table.missingScopeRows ?? 0) > 0 || table.error);
  const objectAclDiagnostics = await diagnoseObjectAcls();
  const routes = await routeInventory();

  return {
    generatedAt: new Date().toISOString(),
    status: problemTables.length === 0 && Number(objectAclDiagnostics.missingOwnershipRows ?? 0) === 0 && routes.unclassifiedRoutes === 0 ? "pass" : "needs_review",
    authPolicy: getApiPolicyStatus(),
    protectedTables: {
      checked: protectedTables.length,
      existing: existingProtectedTables.length,
      problemTables,
      tables: protectedTables,
    },
    objectAcls: objectAclDiagnostics,
    routes,
    principalEvents: getPrincipalDiagnosticSnapshot(100),
    privilegedAccess: await privilegedAccessSummary(),
  };
}
