import { getToolStats } from "./file-storage";
import { createLogger } from "./log";
import { bridgeHandlers } from "./bridge-tools";
import { getSecretSync } from "./secrets-store";
import { db } from "./db";
import { memoryEntries } from "@shared/schema";
import { sql, and as andOp, eq as eqOp, gte as gteOp } from "drizzle-orm";
import { storage } from "./storage";
import { TTLCache } from "./utils/ttl-cache";
import type { SkillWithReferences } from "@shared/models/skills";

const log = createLogger("ToolRegistry");

const _recentSkillsCache = new TTLCache<Set<string>>("RecentSkillIds", 5 * 60 * 1000);
const _activeSkillsCache = new TTLCache<SkillWithReferences[]>("ActiveSkills", 60 * 1000);

import type { ToolDefinition as BaseToolDefinition } from "@shared/models/tools";

export interface ToolDefinition extends Omit<BaseToolDefinition, 'parameters'> {
  category: string;
  source: "agent" | "skill" | "bridge";
  parameters?: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  endpoint?: string;
  instructions?: string;
  usageCount: number;
  lastUsed: string | null;
  errors: number;
  avgDuration: number | null;
}

export interface ToolMeta {
  description: string;
  category: string;
  parameters?: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  whenToUse?: string;
  example?: string;
}

export const TOOLS: Record<string, ToolMeta> = {
  scratch: {
    description: "Manage temporary workspace files (NOT available in production). Use `files` for persistent storage.",
    category: "file",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["read", "write", "edit", "list", "search"], description: "Action to perform" },
        path: { type: "string", description: "File path relative to scratch workspace" },
        content: { type: "string", description: "File content (for write)" },
        old_string: { type: "string", description: "Text to find (for edit)" },
        new_string: { type: "string", description: "Replacement text (for edit)" },
        replace_all: { type: "boolean", description: "Replace all occurrences (for edit, default false)" },
        offset: { type: "number", description: "Line number to start from (for read, 1-indexed)" },
        limit: { type: "number", description: "Max lines (for read) or max results (for search)" },
        pattern: { type: "string", description: "Glob pattern (for search, e.g., '*.md')" },
      },
      required: ["action"],
    },
  },
  files: {
    description: "Manage PERSISTENT files in object storage (survives deployment). Returns download links for write.",
    category: "file",

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["write", "read", "list"], description: "Action to perform" },
        fileName: { type: "string", description: "File name to save (for write)" },
        content: { type: "string", description: "File content (for write)" },
        contentType: { type: "string", description: "MIME type (for write, auto-detected by default)" },
        filePath: { type: "string", description: "Object storage path (for read, e.g., '/objects/uploads/abc.md')" },
        prefix: { type: "string", description: "Path prefix filter (for list)" },
      },
      required: ["action"],
    },
  },
  shell: {
    description: "Execute a shell command in the workspace directory.",
    category: "system",

    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        timeout: { type: "number", description: "Timeout in ms (default 30000, max 120000)" },
      },
      required: ["command"],
    },
  },
  web: {
    description: "Search the web, fetch content from URLs, or run authenticated page verification tests with screenshots and structured evidence.",
    category: "web",

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["search", "fetch", "test", "screenshot"], description: "Action to perform. 'test' is the primary action for authenticated page verification + screenshot + structured evidence. 'screenshot' is a deprecated alias for 'test'." },
        query: { type: "string", description: "Search query (for search)" },
        count: { type: "number", description: "Number of results (for search, default 10)" },
        url: { type: "string", description: "URL to fetch (for fetch)" },
        timeout: { type: "number", description: "Timeout in ms (for fetch, default 15000)" },
        route: { type: "string", description: "App route path like '/memory' — resolves to localhost:PORT (for test/screenshot)" },
        viewport: { type: "string", description: "Viewport preset: 'desktop' (1440x900), 'tablet' (768x1024), 'mobile' (375x812), or 'WxH' custom (for test/screenshot)" },
        fullPage: { type: "boolean", description: "Capture full scrollable page height, capped at 4000px (for test/screenshot)" },
        delay: { type: "number", description: "Extra wait ms after networkidle before capture, default 2000 (for test/screenshot)" },
      },
      required: ["action"],
    },
  },
  memory: {
    description: "Unified memory system — read/write knowledge files, search all layers, manage graph links, run maintenance ops, link/get entity associations, batch retrieve, find duplicates, count entries, bulk delete. Actions: read, write, read_entry, search, create_link, update_entry, delete_entry, get, get_many, find_duplicates, count, bulk_delete, consolidate_short, integrate_mid_to_long, run_myelination, run_memory_decay, run_memory_reinforcement, run_capability_audit, run_full_sleep_cycle, compute_gsi, run_nrem, run_rem, link_entity, get_entity_links, list_sources, add_source, delete_source, search_claims, vnext_claim_counts, vnext_claim_detail, run_vnext_lifecycle.",
    category: "memory",

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["read", "write", "read_entry", "search", "create_link", "update_entry", "delete_entry", "get", "get_many", "find_duplicates", "count", "bulk_delete", "consolidate_short", "integrate_mid_to_long", "run_myelination", "run_memory_decay", "run_memory_reinforcement", "run_capability_audit", "run_full_sleep_cycle", "compute_gsi", "run_nrem", "run_rem", "link_entity", "get_entity_links", "list_sources", "add_source", "delete_source", "search_claims", "vnext_claim_counts", "vnext_claim_detail", "run_vnext_lifecycle"], description: "Action to perform" },
        file: { type: "string", description: "File name (for read/write, e.g., PRINCIPLES.md)" },
        content: { type: "string", description: "Content to write (for write) or updated content (for update_entry)" },
        append: { type: "boolean", description: "Append instead of overwrite (for write, default false)" },
        id: { type: "number", description: "Memory entry ID (for read_entry, update_entry, delete_entry, get) or vNext claim ID (for vnext_claim_detail)" },
        ids: { type: "array", items: { type: "number" }, description: "Array of memory entry IDs (for get_many, max 100)" },
        confirm: { type: "boolean", description: "Confirm deletion (for delete_entry, default false — omit for preview)" },
        reason: { type: "string", description: "Reason for deletion (required when confirm:true for delete_entry)" },
        query: { type: "string", description: "Search query (for search). Use '*' with structured filters to retrieve entries without semantic matching." },
        source: { type: "string", description: "Filter by source type (for search, find_duplicates)" },
        layer: { type: "string", description: "Filter by memory layer (for search, update_entry, find_duplicates)" },
        integrationStage: { type: "string", enum: ["stage_0", "stage_1", "stage_2", "stage_3", "stage_4"], description: "Memory integration stage (for update_entry; stage_1 requires generated title, summary, and topics/tags; stage_4 means sleep-upkeep-maintained canonical memory)" },
        limit: { type: "number", description: "Max results (for search default 20, find_duplicates default 20)" },
        startDate: { type: "string", description: "Start date for date range filter (for search, format: YYYY-MM-DD). Inclusive." },
        endDate: { type: "string", description: "End date for date range filter (for search, format: YYYY-MM-DD). Exclusive." },
        timezone: { type: "string", description: "IANA timezone string for interpreting startDate/endDate (e.g. 'America/Chicago'). Defaults to the server's configured timezone." },
        tags: { type: "array", items: { type: "string" }, description: "Tags (for update_entry)" },
        oneLiner: { type: "string", description: "One-line summary (for update_entry)" },
        metadata: { type: "object", description: "Additional metadata (for update_entry)" },
        fromId: { type: "number", description: "Source memory ID (for create_link)" },
        toId: { type: "number", description: "Target memory ID (for create_link)" },
        relationship: { type: "string", description: "Relationship type (for create_link)" },
        strength: { type: "number", description: "Link strength 0–1 (for create_link, default 0.5)" },
        force: { type: "boolean", description: "Force operation even if under threshold (for integrate_mid_to_long)" },
        includeGSI: { type: "boolean", description: "Include GSI computation in sleep cycle (for run_full_sleep_cycle, default false)" },
        entityType: { type: "string", description: "Entity type to link (for link_entity, e.g. 'person', 'project', 'goal')" },
        entityId: { type: "string", description: "Entity ID to link (for link_entity/get_entity_links). Also used as entity filter for search_claims." },
        memoryId: { type: "number", description: "Memory entry ID (for list_sources, add_source)" },
        sourceType: { type: "string", description: "Source type filter or value (for list_sources, add_source — e.g. 'memory', 'library', 'session', 'chat_journal')" },
        sourceId: { type: "string", description: "Source ID (for list_sources filter, add_source — e.g. the ID of the source entry)" },
        sourceRefId: { type: "number", description: "Source ref ID to delete (for delete_source)" },
        context: { type: "string", description: "Context string (for add_source)" },
        quote: { type: "string", description: "Quote from source (for add_source)" },
        claimType: { type: "string", description: "Filter by claim type: state, cause, or action (for search_claims)" },
        storage: { type: "string", enum: ["vnext", "legacy"], description: "Restrict search_claims to vNext claims or legacy memory_entries compatibility rows" },
        lifecycleStage: { type: "string", enum: ["extracted", "sourced", "linked", "canonical", "retired"], description: "Filter vNext claims by lifecycle stage (for search_claims)" },
        hasEntityLinks: { type: "boolean", description: "Filter claims by whether they have entity links (for search_claims)" },
        minLinks: { type: "number", description: "Filter: minimum link count (for search)" },
        maxLinks: { type: "number", description: "Filter: maximum link count (for search)" },
        minContentLength: { type: "number", description: "Filter: minimum content length in chars (for search)" },
        maxContentLength: { type: "number", description: "Filter: maximum content length in chars (for search)" },
        recalledBefore: { type: "string", description: "Filter: entries recalled before this ISO timestamp (for search)" },
        recalledAfter: { type: "string", description: "Filter: entries recalled after this ISO timestamp (for search)" },
        minRecallCount: { type: "number", description: "Filter: minimum recall count (for search)" },
        maxRecallCount: { type: "number", description: "Filter: maximum recall count (for search)" },
        hasTitle: { type: "boolean", description: "Filter: true=has title, false=no title (for search)" },
        hasSummary: { type: "boolean", description: "Filter: true=has summary, false=no summary (for search)" },
        hasDeletionScheduled: { type: "boolean", description: "Filter: true=has deletionScheduled metadata (for search)" },
        deletionExpired: { type: "boolean", description: "Filter: true=deletionScheduled is in the past (for search)" },
        createdBefore: { type: "string", description: "Filter: created before this ISO timestamp (for search, find_duplicates)" },
        createdAfter: { type: "string", description: "Filter: created after this ISO timestamp (for search, find_duplicates)" },
        updatedBefore: { type: "string", description: "Filter: updated/processed before this ISO timestamp (for search)" },
        updatedAfter: { type: "string", description: "Filter: updated/processed after this ISO timestamp (for search)" },
        sortBy: { type: "string", enum: ["createdAt", "contentLength", "linkCount", "recallCount"], description: "Sort field (for search, default createdAt)" },
        sortOrder: { type: "string", enum: ["asc", "desc"], description: "Sort direction (for search, default desc)" },
        offset: { type: "number", description: "Pagination offset (for search, default 0)" },
      },
      required: ["action"],
    },
  },
  railway: {
    description: "Inspect and manage Railway-hosted instances. Use this whenever a 'production is broken' (or dev-broken) report comes in — pull real Railway status, deployments, runtime logs, and build logs before guessing. The `environment` parameter is REQUIRED on every call ('dev' or 'prod'). Actions: status (current deployment + URL), deployments (recent deployments with commit info), logs (runtime logs for latest or a given deploymentId), build_logs (build + deploy log stream for the latest in-flight or most recent deployment), list_variables (variable NAMES only, never values), redeploy (redeploy latest or a given deploymentId — non-destructive), restart (restart latest or a given deployment — non-destructive). Destructive/permanent actions (rollback, stop, secret value reveal, variable writes) are intentionally NOT exposed here and must be performed by a human via the Dev page. Currently reachable: dev, prod. Multi-account routing: pass `connectionId` (provider connection ID) or `platformEnvironmentId` (platform environment ID) to route through a specific provider connection and its hosting binding instead of the hardcoded dev/prod config. When using these, `environment` is not required.",
    category: "system",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "deployments", "logs", "build_logs", "list_variables", "redeploy", "restart"], description: "Action to perform" },
        environment: { type: "string", enum: ["dev", "prod"], description: "Which Railway environment to target. REQUIRED when connectionId/platformEnvironmentId are not provided." },
        connectionId: { type: "number", description: "Provider connection ID — routes through that connection's token and hosting binding instead of hardcoded dev/prod config." },
        platformEnvironmentId: { type: "number", description: "Platform environment ID (platform_product_environments.id) — looks up the hosting binding and routes through the bound connection automatically." },
        deploymentId: { type: "string", description: "Specific deployment ID (optional — defaults to latest deployment for logs/build_logs/restart/redeploy)" },
        limit: { type: "number", description: "Max results (for deployments default 10, for logs default 200, max 500)" },
      },
      required: ["action"],
    },
  },

  sentry: {
    description: "Query Sentry crash reports and error tracking for the mobile app. Uses stored SENTRY_AUTH_TOKEN, SENTRY_ORG, and SENTRY_PROJECT secrets. Actions: status (check connection), issues (list issues with optional query/sort/limit), issue (get issue details by issueId), events (list events for an issue with full stacktraces), latest_event (get the most recent event for an issue), resolve (resolve an issue), unresolve (reopen an issue), ignore (ignore an issue).",
    category: "system",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "issues", "issue", "events", "latest_event", "resolve", "unresolve", "ignore"], description: "Action to perform" },
        issueId: { type: "string", description: "Sentry issue ID (required for issue, events, latest_event, resolve, unresolve, ignore)" },
        query: { type: "string", description: "Sentry search query (for issues, default: is:unresolved)" },
        sort: { type: "string", description: "Sort order for issues: date, new, freq, user (default: date)" },
        limit: { type: "number", description: "Max results (for issues default 25 max 100, for events default 10 max 100)" },
        full: { type: "boolean", description: "Include full event body with stacktrace (for events, default true)" },
      },
      required: ["action"],
    },
  },
  meta: {
    description: "Queue and execute Meta/Ray-Ban DAT SDK calls through the mobile iOS bridge. Requires the mobile app debug overlay to be open so the phone can poll, execute native DAT calls locally, and post results back. Actions: queue, call, results, commands, status, preflight, initialize, listDevices, requestCamera, register, connect, capture.",
    category: "system",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["queue", "call", "results", "commands", "status", "preflight", "initialize", "listDevices", "requestCamera", "register", "connect", "capture"], description: "Action to perform. Direct DAT actions queue and wait by default; queue only queues; call uses datAction and waits." },
        datAction: { type: "string", enum: ["status", "preflight", "initialize", "listDevices", "requestCamera", "register", "connect", "capture"], description: "DAT action for action=queue or action=call." },
        params: { type: "object", description: "Runtime params for the DAT action, e.g. { deviceId: '...' } for connect." },
        note: { type: "string", description: "Optional note logged with the queued command." },
        wait: { type: "boolean", description: "Whether to wait for iOS result. Defaults true for direct DAT actions/call, false for queue." },
        timeoutMs: { type: "number", description: "How long to wait for the iOS app to poll and return a result, default 30000, max 120000." },
        limit: { type: "number", description: "For results/commands, max records to return." },
      },
      required: ["action"],
    },
  },
  expo: {
    description: "Inspect Expo/EAS projects and builds using the stored EXPO_ACCESS_TOKEN integration secret. Actions: status, projects, builds, build, build_logs, cancel. Use build_logs to fetch Xcode/build log artifacts and extract actual failure lines instead of relying on Expo summary text.",
    category: "system",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "projects", "builds", "build", "build_logs", "cancel"], description: "Action to perform" },
        projectId: { type: "string", description: "Expo app/project UUID for builds list. Defaults to mobile Expo config projectId when available." },
        buildId: { type: "string", description: "EAS build ID for build/build_logs/cancel. Defaults to latest build when omitted for build_logs; for cancel, omit buildId to cancel in-progress builds matching project/platform/profile." },
        platform: { type: "string", description: "Platform filter for cancel, e.g. ios or android." },
        profile: { type: "string", description: "Build profile filter for cancel, e.g. preview or production." },
        limit: { type: "number", description: "Max builds to return (default 10, max 50)" },
      },
      required: ["action"],
    },
  },
  meeting_bot: {
    description: "Send the Mantra Agent meeting bot into a live meeting via Recall.ai. Actions: join (bot joins a Zoom/Google Meet call and streams a live attributed transcript into a meeting session — pass a meeting 'url', or omit it to auto-resolve the current/next calendar event that has a meeting link), status (bot/meeting state for a meeting session), diagnostics (recent inbound Recall webhook delivery outcomes, including rejected signatures), leave (bot exits the call). The bot is listen-only and appears in the room as 'Mantra Agent'. Requires the Recall.ai integration to be configured in Settings → Integrations (never ask for the API key in chat).",
    category: "calendar",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["join", "status", "diagnostics", "leave"], description: "Action to perform" },
        url: { type: "string", description: "Zoom or Google Meet meeting URL (for join). Omit to resolve from the calendar." },
        title: { type: "string", description: "Optional meeting session title (for join). Defaults to the calendar event summary or 'Meeting'." },
        sessionId: { type: "string", description: "Meeting session ID (for status/leave)." },
        limit: { type: "number", description: "Maximum recent webhook deliveries for diagnostics (default 20, max 100)." },
      },
      required: ["action"],
    },
  },
  settings: {
    description: "Persist and retrieve key-value settings. Actions: get, set, delete. Keys must start with an allowed prefix (memory.*, system.*, skill.*, hygiene.*).",
    category: "system",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "set", "delete"], description: "Action to perform" },
        key: { type: "string", description: "Setting key (e.g., 'memory.hygiene.runCount')" },
        value: { description: "Value to store (for set — any JSON-serializable value)" },
      },
      required: ["action", "key"],
    },
  },
  code: {
    description: "Query and navigate the selected Platform codebase knowledge graph — search, inspect symbols, analyze impact, trace flows, rename, and run Cypher.",
    category: "code",

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["query", "context", "impact", "changes", "architecture", "modules", "flows", "rename", "schema", "cypher"], description: "Action to perform" },
        query: { type: "string", description: "Search query (for query) or Cypher query (for cypher)" },
        goal: { type: "string", description: "What you're trying to accomplish (for query)" },
        task_context: { type: "string", description: "What you are working on (for query)" },
        limit: { type: "number", description: "Max processes to return (for query, default 5)" },
        max_symbols: { type: "number", description: "Max symbols per process (for query, default 10)" },
        include_content: { type: "boolean", description: "Include source code in results (for query/context)" },
        name: { type: "string", description: "Symbol/module/flow name (for context/modules/flows)" },
        uid: { type: "string", description: "Symbol UID for direct lookup (for context)" },
        file: { type: "string", description: "File path to disambiguate (for context)" },
        target: { type: "string", description: "Symbol to analyze (for impact)" },
        direction: { type: "string", description: "'upstream' or 'downstream' (for impact)" },
        maxDepth: { type: "number", description: "Max traversal depth (for impact, default 3)" },
        includeTests: { type: "boolean", description: "Include test files (for impact)" },
        minConfidence: { type: "number", description: "Min confidence 0-1 (for impact, default 0.7)" },
        symbol_name: { type: "string", description: "Symbol to rename (for rename)" },
        symbol_uid: { type: "string", description: "Symbol UID (for rename)" },
        new_name: { type: "string", description: "New name (for rename)" },
        file_path: { type: "string", description: "File path (for rename)" },
        dry_run: { type: "boolean", description: "Preview only (for rename, default true)" },
      },
      required: ["action"],
    },
  },
  docx: {
    description: "Read, write, edit, and clone Word documents (.docx) in the scratch workspace.",
    category: "file",

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["read", "write", "edit", "clone"], description: "Action to perform" },
        path: { type: "string", description: "File path (for read/write/edit)" },
        mode: { type: "string", enum: ["text", "rich", "annotated"], description: "Read mode (for read, default 'text')" },
        content: { type: "string", description: "Content to write (for write/clone)" },
        output_path: { type: "string", description: "Output path (for edit/clone)" },
        replacements: { type: "array", description: "Find/replace pairs (for edit)", items: { type: "object", properties: { find: { type: "string" }, replace: { type: "string" } }, required: ["find", "replace"] } },
        source_path: { type: "string", description: "Template document path (for clone)" },
      },
      required: ["action"],
    },
  },
  goals: {
    description: "Manage life goals — unified system covering all horizons from daily goals (today) to lifetime aspirations. Horizons: today, this_week, this_month, this_quarter, this_year, three_year, ten_year, lifetime. Short horizons support periodDate for date-scoped queries. This is the canonical tool for all goal and priority operations. Actions: list, get, create, update, delete, search, set_parent, unlink_parent, set_review, set_daily_plan, get_daily_artifacts, set_weekly/monthly/quarterly plan+reflection. Use canonical @goal:id syntax in messages to link to goals. Legacy [goal:id] syntax is accepted during migration.",
    category: "work",

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "get", "create", "update", "delete", "search", "set_parent", "unlink_parent", "set_review", "set_daily_plan", "get_daily_artifacts", "set_weekly_reflection", "set_weekly_plan", "set_monthly_plan", "set_monthly_reflection", "set_quarterly_plan", "set_quarterly_reflection"], description: "The action to perform" },
        id: { type: "string", description: "Goal ID (required for get, update, delete, set_parent, unlink_parent)" },
        shortName: { type: "string", description: "Short goal name (required for create)" },
        description: { type: "string", description: "Full description (for create/update)" },
        domain: { type: "string", enum: ["career", "health", "relationships", "finance", "growth", "creative"], description: "Life domain" },
        horizon: { type: "string", enum: ["today", "this_week", "this_month", "this_quarter", "this_year", "three_year", "ten_year", "lifetime", "now", "3_year", "10_year", "decade"], description: "Time horizon" },
        status: { type: "string", enum: ["active", "on_track", "at_risk", "achieved", "blocked", "dormant"], description: "Goal status (for create/update, default: active)" },
        query: { type: "string", description: "Search term (for search action)" },
        parentId: { type: "string", description: "Goal ID to set as parent (for set_parent action)" },
        filters: { type: "object", description: "Optional filters for list: { domain, horizon, search }" },
        targetDate: { type: "string", description: "Target date YYYY-MM-DD (for create/update)" },
        periodDate: { type: "string", description: "Period date YYYY-MM-DD for short-horizon scoping (for create/update)" },
        periodWeek: { type: "string", description: "Period week YYYY-Www for weekly goals (for create/update)" },
        periodMonth: { type: "string", description: "Period month YYYY-MM for monthly goals (for create/update)" },
        source: { type: "string", description: "Source of the goal (for create/update)" },
        libraryPageId: { type: "string", description: "Library page ID to link as review/plan/reflection (for set_review, set_daily_plan, set_weekly/monthly/quarterly actions)" },
        date: { type: "string", description: "Date in YYYY-MM-DD format (for set_review, set_daily_plan, get_daily_artifacts; defaults to today)" },
        week: { type: "string", description: "Any date within the target week in YYYY-MM-DD format (for set_weekly_plan/set_weekly_reflection; defaults to current week)" },
        month: { type: "string", description: "Target month in YYYY-MM format (for set_monthly_plan/set_monthly_reflection; defaults to current month)" },
        quarter: { type: "string", description: "Target quarter in YYYY-QN format (for set_quarterly_plan/set_quarterly_reflection; defaults to current quarter)" },
      },
      required: ["action"],
    },
  },
  people: {
    description: "Manage personal contacts — query, search, get details, check outreach agenda, add notes, log interactions, update or delete interactions. Actions: list, query, get_many, get, search, agenda, add_note, update_note, delete_note, log_interaction, get_interactions, update_interaction, delete_interaction, create, scan_imports, scan_ignored, list/get/find import candidates, add/merge/skip/undo decisions, and preview/apply/get batches. Use canonical @person:id syntax in messages to link to people. Legacy [person:id] syntax is accepted during migration.",
    category: "communication",

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "query", "get_many", "get", "search", "agenda", "add_note", "update_note", "delete_note", "log_interaction", "get_interactions", "update_interaction", "delete_interaction", "create", "scan_imports", "scan_ignored", "list_import_candidates", "get_import_candidate", "find_import_matches", "add_import_candidate", "merge_import_candidate", "skip_import_candidate", "undo_import_decision", "preview_import_batch", "apply_import_batch", "get_import_batch"], description: "The action to perform" },
        id: { type: "string", description: "Person ID or name (resolved automatically)" },
        query: { type: "string", description: "Person name or search term" },
        ids: { type: "array", items: { type: "string" }, description: "Person IDs for get_many (max 100)" },
        field: { type: "string", enum: ["id", "name", "email", "company", "role", "relation", "professionalRelations", "cabinetLevel", "tags", "introducedBy", "familiarity", "trust", "met", "lastInteractionDate", "createdAt", "updatedAt"], description: "Field to filter for query action" },
        operator: { type: "string", enum: ["equals", "empty", "not_empty", "contains", "fuzzy", "in"], description: "Filter operator for query action" },
        value: { description: "Filter value for query action. Use string or string array for in." },
        fields: { type: "array", items: { type: "string" }, description: "Fields to return for query/get_many/list JSON projection" },
        limit: { type: "number", description: "Max people to return for list/search/query (default 100 for query, max 500)" },
        offset: { type: "number", description: "Pagination offset for list/search/query" },
        format: { type: "string", enum: ["text", "json"], description: "Use json for structured list output" },
        content: { type: "string", description: "Note text (for add_note/update_note)" },
        noteId: { type: "string", description: "Note ID (for update_note/delete_note)" },
        interactionId: { type: "string", description: "Interaction ID (for update_interaction/delete_interaction)" },
        title: { type: "string", description: "Note title (for update_note)" },
        summary: { type: "string", description: "Interaction summary (for log_interaction/update_interaction)" },
        type: { type: "string", enum: ["call", "text", "email", "in_person", "video", "social", "note"], description: "Interaction type (for log_interaction/update_interaction)" },
        date: { type: "string", description: "Date YYYY-MM-DD (for log_interaction)" },
        responseOwed: { type: "boolean", description: "Whether a response is still owed for this interaction — set false to clear the obligation (for log_interaction/update_interaction)" },
        responseDueBy: { type: "string", description: "Date YYYY-MM-DD the owed response is due by (for log_interaction/update_interaction)" },
        name: { type: "string", description: "Full name (for create)" },
        email: { type: "string", description: "Email (for create)" },
        cabinetLevel: { type: "string", enum: ["agent", "user", "family", "cabinet", "community", "network"], description: "Relationship tier (for create)" },
        company: { type: "string", description: "Company (for create)" },
        role: { type: "string", description: "Role/title (for create)" },
        relation: { type: "string", description: "How you know them (for create)" },
        tags: { type: "array", items: { type: "string", description: "A tag label" }, description: "Tags (for create)" },
        notes: { type: "string", description: "Initial notes (for create)" },
        introducedBy: { type: "string", description: "Who introduced them (for create)" },
        familiarity: { type: "string", enum: ["none", "surface", "deep"], description: "Familiarity level (for create)" },
        trust: { type: "string", enum: ["ally", "positive", "none", "negative", "enemy"], description: "Trust level (for create)" },
        candidateId: { type: "string", description: "Import candidate ID for candidate actions" },
        personId: { type: "string", description: "Target Person ID for merge_import_candidate" },
        decisionId: { type: "string", description: "Decision audit ID for undo_import_decision" },
        idempotencyKey: { type: "string", description: "Required replay-safe key for import mutations and batch apply" },
        decisions: { type: "array", items: { type: "object" }, description: "Batch decisions: [{ action: add|merge|skip, input: { candidateId, ... } }]" },
        batchId: { type: "string", description: "Import batch ID" },
        batchToken: { type: "string", description: "Immutable token returned by preview_import_batch" },
      },
      required: ["action"],
    },
  },
  library: {
    description: "Manage Library wiki pages and Notes scratchpad. Actions: list_library_pages, get_library_page, resolve_parent, create_library_page, update_library_page, edit_library_page, dismiss_library_page, delete_library_page, search_library_pages, search, browse_tree, tree, link_pages, annotate. Any page can have child pages, optional tags, and an optional status. Use 'browse_tree' or 'tree' to see the full page hierarchy as an indented outline. Use canonical @page:slug syntax in messages to link to library pages. Legacy [page:slug] syntax is accepted during migration. Prefer edit_library_page over update_library_page for targeted changes to existing page content — it avoids re-transmitting the entire document.",
    category: "knowledge",

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list_library_pages", "get_library_page", "resolve_parent", "create_library_page", "update_library_page", "edit_library_page", "dismiss_library_page", "delete_library_page", "search_library_pages", "search", "browse_tree", "tree", "link_pages", "annotate"], description: "The action to perform" },
        id: { type: "string", description: "Page ID/slug" },
        title: { type: "string", description: "Title (for create/update)" },
        plainTextContent: { type: "string", description: "Markdown content for pages (automatically converted to rich TipTap JSON and stored as the single source of truth)" },
        parentId: { type: "string", description: "Parent page ID (for update pages; create_library_page resolves parent from purpose)" },
        purpose: { type: "string", description: "Artifact purpose or filing key for resolve_parent/create_library_page, e.g. specs, meeting-notes, daily-review" },
        pageContext: { type: "string", description: "Originating app route or page context for parent resolution, e.g. /home, /exec" },
        contentSummary: { type: "string", description: "Short summary used by the Library index to resolve the correct parent" },
        tags: { type: "array", items: { type: "string" }, description: "Tags for categorization (for create/update)" },
        status: { type: "string", description: "Page status (for create/update, e.g. draft, in-review, approved, implemented)" },
        surface: { type: "boolean", description: "Surface this page in Home/Simple Inbox when true with surfaceDurationHours; clear surfacing when false (for create/update/edit/dismiss)" },
        surfaceDurationHours: { type: "number", description: "How many hours from now the page should stay surfaced; server computes surfaceUntil (for create/update/edit)" },
        surfaceReason: { type: "string", description: "Optional reason/context for surfacing the page" },
        surfaceSection: { type: "string", description: "Optional surface section, defaults to inbox" },
        oneLiner: { type: "string", description: "One-line summary of the page (for update_library_page)" },
        summary: { type: "string", description: "Multi-sentence summary of the page (for update_library_page)" },
        query: { type: "string", description: "Search query (for search actions)" },
        content: { type: "string", description: "Annotation text (for annotate)" },
        annotationType: { type: "string", enum: ["observation", "connection", "confidence"], description: "Annotation type (for annotate)" },

        fromPageId: { type: "string", description: "Source page ID (for link_pages)" },
        toPageId: { type: "string", description: "Target page ID (for link_pages)" },
        linkType: { type: "string", description: "Link type (for link_pages)" },
        old_string: { type: "string", description: "Text to find in page content (for edit_library_page)" },
        new_string: { type: "string", description: "Replacement text (for edit_library_page)" },
        replace_all: { type: "boolean", description: "Replace all occurrences (for edit_library_page, default false)" },
      },
      required: ["action"],
    },
  },
  work: {
    description: "Manage projects and work status — create projects, list/get with tasks, manage files, milestones, goal links. Use `tasks` for individual task operations.",
    category: "work",

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create_project", "update_project", "set_status", "delete_project", "status", "list_projects", "get_project", "list_tasks", "set_goal", "add_file", "read_file", "remove_file", "add_milestone", "update_milestone", "remove_milestone"], description: "The action to perform" },
        id: { type: "number", description: "Project ID" },
        title: { type: "string", description: "Project title (for create_project)" },
        description: { type: "string", description: "Project description (for create_project)" },
        priority: { type: "string", description: "Priority: high, mid, low" },
        owner: { type: "string", description: "Owner: me, agent (xyz is accepted as an alias for agent)" },
        tags: { type: "array", items: { type: "string" }, description: "Tags" },
        people: { type: "array", items: { type: "string" }, description: "People (for create_project)" },
        status: { type: "string", enum: ["idea", "planning", "active", "on_hold", "completed"], description: "Project status (for set_status) or status filter (for list_projects)" },
        goalId: { type: ["string", "null"], description: "Goal ID (for set_goal/create_project)" },
        fileId: { type: "string", description: "File ID (for read_file/remove_file)" },
        fileName: { type: "string", description: "File name (for add_file)" },
        fileMimeType: { type: "string", description: "MIME type (for add_file)" },
        fileObjectKey: { type: "string", description: "Object storage key (for add_file)" },
        fileSize: { type: "number", description: "File size (for add_file)" },
        workspacePath: { type: "string", description: "Workspace file path to upload (for add_file)" },
        milestoneId: { type: "number", description: "Milestone ID" },
        name: { type: "string", description: "Milestone name" },
        startDate: { type: "string", description: "Start date YYYY-MM-DD" },
        dueDate: { type: "string", description: "Due date YYYY-MM-DD" },
        milestoneStatus: { type: "string", description: "Milestone status: planned, active, completed" },
        order: { type: "number", description: "Display order" },
        clearFields: { type: "array", items: { type: "string" }, description: "Fields to explicitly clear (set to null). Allowed: description. (for update_project)" },
        confirmDestructiveUpdate: { type: "boolean", description: "Required confirmation when clearing destructive fields like description (for update_project)" },
        destructiveUpdateReason: { type: "string", description: "Reason for destructive clear — required with confirmDestructiveUpdate (for update_project)" },
      },
      required: ["action"],
    },
  },
  tasks: {
    description: "Create, complete, delete, and update tasks. Actions: create, complete, delete, update.",
    category: "work",

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "complete", "delete", "update"], description: "Action to perform" },
        title: { type: "string", description: "Task title (for create/complete/delete/update — used for name lookup)" },
        description: { type: "string", description: "Task description (for create/update)" },
        taskId: { type: "number", description: "Task ID (for complete/delete/update)" },
        newTitle: { type: "string", description: "Rename task (for update)" },
        status: { type: "string", description: "Status: on_hold, ready, active, done" },
        priority: { type: "string", description: "Priority: high, mid, low" },
        impact: { type: "string", description: "Impact: high, mid, low" },
        effort: { type: "string", description: "Effort: high, mid, low" },
        owner: { type: "string", description: "Owner: me, agent (xyz is accepted as an alias for agent)" },
        requiresReview: { type: "boolean", description: "Requires review" },
        projectId: { type: "number", description: "Project ID to link" },
        milestoneId: { type: "number", description: "Milestone ID to link" },
        deadline: { type: "string", description: "Deadline date (ISO string)" },
        clearFields: { type: "array", items: { type: "string" }, description: "Fields to explicitly clear (set to null). Allowed: description, deadline, projectId, milestoneId. (for update)" },
        confirmDestructiveUpdate: { type: "boolean", description: "Required confirmation when clearing destructive fields like description (for update)" },
        destructiveUpdateReason: { type: "string", description: "Reason for destructive clear — required with confirmDestructiveUpdate (for update)" },
      },
      required: ["action"],
    },
  },
  system: {
    description: "System operations — get system state snapshot, fetch a specific issue, create issues, retrieve runtime logs, check budget, view events, active runs, clear terminal zombie runs, connected accounts, and tool stats. Actions: state, get_issue, create_issue, logs, log_files, budget, events, active_runs, clear_active_run, accounts, tool_stats. A full log archive is available in the logs/ directory. Use log_files to list all available log files (with size and date). Use logs with the file parameter to read any historical log file by filename.",
    category: "system",

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["state", "get_issue", "create_issue", "logs", "log_files", "budget", "events", "active_runs", "clear_active_run", "accounts", "tool_stats"], description: "Action to perform. Use log_files to list available log files; use logs to read a specific log file." },
        id: { type: "string", description: "Issue ID (for get_issue)" },
        title: { type: "string", description: "Issue title (for create_issue)" },
        description: { type: "string", description: "Issue description (for create_issue)" },
        priority: { type: "string", description: "Priority level — high, mid, or low (for create_issue)" },
        labels: { type: "string", description: "Comma-separated labels (for create_issue)" },
        limit: { type: "number", description: "Max entries to return (for logs/events, default 100)" },
        level: { type: "string", description: "Filter by log level: debug, info, warn, error (for logs)" },
        source: { type: "string", description: "Filter by source module name (for logs)" },
        file: { type: "string", description: "Log filename to read (for logs). Use log_files action to list available files. If omitted, reads the current session log." },
        category: { type: "string", description: "Filter events by category (for events)" },
        event: { type: "string", description: "Filter events by event name substring (for events)" },
        runId: { type: "string", description: "Filter events by run ID (for events) or run ID to clear (for clear_active_run)" },
        reason: { type: "string", description: "Reason for clearing an active run (for clear_active_run)" },
        provider: { type: "string", description: "Filter accounts by provider (for accounts)" },
      },
      required: ["action"],
    },
  },
  hooks: {
    description: "Manage event hooks — create, list, get, update, delete, and test reactive hooks that fire actions when system events match patterns. Actions: list, get, create, update, delete, test.",
    category: "system",

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "get", "create", "update", "delete", "test"], description: "Action to perform" },
        id: { type: "number", description: "Hook ID (for get, update, delete, test)" },
        name: { type: "string", description: "Hook name (for get by name, or create/update)" },
        description: { type: "string", description: "Hook description (for create/update)" },
        eventPattern: { type: "string", description: "Glob-style event pattern, e.g., 'chat.*' or 'chat.autonomous.completed' (for create/update)" },
        condition: { type: "object", description: "Optional payload field conditions (AND logic), e.g., {\"skillName\": \"triage\"} (for create/update)" },
        actionType: { type: "string", enum: ["run_skill", "initiate_conversation", "tool_call"], description: "Action type (for create/update)" },
        actionConfig: { type: "object", description: "Action configuration with optional {{payload.field}} templates (for create/update)" },
        cooldownSeconds: { type: "number", description: "Minimum seconds between firings (for create/update, default 0)" },
        enabled: { type: "boolean", description: "Whether hook is active (for create/update, default true)" },
        maxFirings: { type: "number", description: "Max times this hook can fire before auto-disabling (for create/update, default null = unlimited). Set to 1 for one-shot hooks." },
        eventId: { type: "string", description: "Event ID to test against (for test)" },
        testEvent: { type: "string", description: "Synthetic event name for testing (for test)" },
        testPayload: { type: "object", description: "Synthetic payload for testing (for test)" },
      },
      required: ["action"],
    },
  },
  notion: {
    description: "Search, read, and browse Notion pages and databases. Actions: status, search, get_page, get_content, list_databases, query_database.",
    category: "knowledge",

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "search", "get_page", "get_content", "list_databases", "query_database"], description: "Action to perform" },
        query: { type: "string", description: "Search term" },
        id: { type: "string", description: "Page or Database ID" },
        account: { type: "string", description: "Notion account label (optional)" },
        limit: { type: "number", description: "Max results (default 10-20)" },
      },
      required: ["action"],
    },
  },
  twitter: {
    description: "Post tweets, reply to tweets, look up individual tweets, delete tweets, and search or look up X news/articles via X (Twitter). Actions: status, post, reply, lookup, delete, news_search, news_lookup.",
    category: "communication",

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "Action to perform: status, post, reply, lookup, delete, news_search, news_lookup" },
        text: { type: "string", description: "Tweet text content (for post/reply)" },
        tweet_id: { type: "string", description: "Tweet ID or URL (for reply/lookup/delete)" },
        query: { type: "string", description: "Search query (for news_search)" },
        max_results: { type: "string", description: "Maximum number of results to return (for news_search, optional)" },
        article_id: { type: "string", description: "X News/Grok Story ID for news_lookup. Browser URLs for Grok Stories are not durable; pass the raw ID when available." },
      },
      required: ["action"],
    },
  },
  gmail: {
    description: "Read, search, and draft emails via Gmail. Supports multiple accounts. Actions: status, search, read, batch_read, draft, update_draft, recent, download_attachment, triage_log, email_cache. When creating an email intended for Ray to review or send, use draft or update_draft so the persisted draft renders as an inline widget; plain chat email text is only for brainstorming or explicit copy-only requests. The human sends via the widget's Send button. There is no tool-level send action.",
    category: "communication",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "Action to perform" },
        query: { type: "string", description: "Search query (for search, batch_read)" },
        id: { type: "string", description: "Message ID (for read)" },
        draft_id: { type: "string", description: "Persisted email draft ID (required for update_draft)" },
        ids: { type: "array", items: { type: "string" }, description: "Array of message IDs (for batch_read)" },
        excludeMessageIds: { type: "array", items: { type: "string" }, description: "Message IDs to skip (for batch_read)" },
        to: { type: "string", description: "Recipient email (for draft)" },
        update_to: { type: "array", items: { type: "string" }, description: "Non-empty To recipients (for update_draft)" },
        update_cc: { type: "array", items: { type: "string" }, description: "Non-empty CC recipients (for update_draft)" },
        update_bcc: { type: "array", items: { type: "string" }, description: "Non-empty BCC recipients (for update_draft)" },
        subject: { type: "string", description: "Email subject" },
        body: { type: "string", description: "Email body (for draft creation only)" },
        findReplace: { type: "object", properties: { find: { type: "string", description: "Exact text to find" }, replace: { type: "string", description: "Replacement text; may be empty to delete the match" }, replaceAll: { type: "boolean", description: "Replace every exact match; defaults false and rejects ambiguous matches" } }, required: ["find", "replace"], description: "Exact body edit for update_draft. Mutually exclusive with rangePatch and replaceBody." },
        rangePatch: { type: "object", properties: { start: { type: "number", description: "Zero-based inclusive character offset" }, end: { type: "number", description: "Zero-based exclusive character offset" }, replacement: { type: "string", description: "Replacement text; may be empty to delete the range" }, expectedBodyHash: { type: "string", description: "SHA-256 hash of the current draft body; stale hashes are rejected" } }, required: ["start", "end", "replacement", "expectedBodyHash"], description: "Guarded body range edit for update_draft. Mutually exclusive with findReplace and replaceBody." },
        replaceBody: { type: "object", properties: { body: { type: "string", description: "Complete replacement body; may be empty only when intentionally clearing the body" } }, required: ["body"], description: "Explicit whole-body replacement for update_draft. Mutually exclusive with findReplace and rangePatch." },
        maxResults: { type: "number", description: "Max results (default 100 for batch_read)" },
        account: { type: "string", description: "Target account label or email" },
        attachmentId: { type: "string", description: "Attachment ID (for download_attachment)" },
        fileName: { type: "string", description: "Override filename (for download_attachment)" },
        triage_action: { type: "string", description: "Sub-action for triage_log: 'get_triaged_ids' (default, reads live email_messages triage state plus legacy log rows) or 'record'" },
        sinceHours: { type: "number", description: "Hours to look back for triaged IDs from live email_messages and legacy triage logs (default 168 / 7 days)" },
        entries: { type: "array", items: { type: "object", properties: { gmailMessageId: { type: "string" }, accountId: { type: "string" }, tier: { type: "string" }, senderEmail: { type: "string" }, subject: { type: "string" }, cachedMessageId: { type: "number" }, cacheId: { type: "number" }, reason: { type: "string" } }, required: ["tier"] }, description: "Triage entries to record (for triage_log record or mark_triaged)" },
        cache_action: { type: "string", description: "Sub-action for email_cache: 'get_untriaged' (fetch untriaged cached emails), 'mark_triaged' (mark cached emails as triaged), 'get_unenriched' (fetch triaged emails that haven't been enriched yet), 'store_enrichment' (store enrichment data for a thread), 'search' (search cached emails by query), 'resolve' or 'get_thread' (resolve @email_thread/@email_message refs to cached thread/messages), 'sync_status' (check sync health), 'pipeline_counts' (raw pipeline counts from DB), 'get_message' (raw email_messages row by message_id with enrichment status), 'diagnose' (compare pipeline counts vs unenriched query for divergence), 'run_downstream' (manually run triage + enrichment pipeline)" },
        limit: { type: "number", description: "Max results for email_cache get_untriaged (default 200, max 500) or search (default 20, max 100)" },
        thread_id: { type: "string", description: "Provider thread ID (for store_enrichment or email_cache get_thread/resolve)" },
        ref: { type: "string", description: "Canonical email reference, e.g. @email_thread:accountId:providerThreadId or @email_message:9769 (for email_cache resolve)" },
        account_id: { type: "string", description: "Account ID (for store_enrichment)" },
        message_id: { type: "number", description: "Cached message ID (for store_enrichment)" },
        summary: { type: "string", description: "Enrichment summary of the thread (for store_enrichment)" },
        decisions: { type: "array", items: { type: "string" }, description: "Key decisions identified in the thread (for store_enrichment)" },
        actions: { type: "array", items: { type: "string" }, description: "Action items identified in the thread (for store_enrichment)" },
        dismissed: { type: "boolean", description: "Whether to dismiss this thread (for store_enrichment)" },
        dismiss_reason: { type: "string", description: "Reason for dismissing the thread (for store_enrichment)" },
        days: { type: "number", description: "Number of days to look back for search (default 7, max 90)" },
      },
      required: ["action"],
    },
  },
  content: {
    description: "Manage the social content queue — queue draft posts for review, list queued content, or get optimal posting time suggestions. Actions: queue_draft, list, suggest_times.",
    category: "communication",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "Action to perform: queue_draft, list, suggest_times" },
        platform: { type: "string", description: "Platform (default: x)" },
        content: { type: "string", description: "Post text content (for queue_draft)" },
        threadParts: { type: "array", items: { type: "string" }, description: "Array of tweet parts for threads (for queue_draft)" },
        metadata: { type: "object", description: "Optional metadata (for queue_draft)" },
        status: { type: "string", description: "Filter by status (for list)" },
        count: { type: "number", description: "Number of time suggestions (for suggest_times, default 7)" },
        startDate: { type: "string", description: "Start date ISO 8601 (for suggest_times)" },
        endDate: { type: "string", description: "End date ISO 8601 (for suggest_times)" },
        limit: { type: "number", description: "Max results (for list, default 20)" },
      },
      required: ["action"],
    },
  },
  meetings: {
    description: "Manage calendar events — create, list, update, or delete meetings.",
    category: "calendar",

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "list", "update", "delete", "set_metadata", "get_metadata", "link_task", "unlink_task", "link_artifact", "unlink_artifact"], description: "The action to perform" },
        summary: { type: "string", description: "Meeting title (for add/update)" },
        start: { type: "string", description: "Start time ISO 8601 (required for add)" },
        end: { type: "string", description: "End time ISO 8601 (default: +1h)" },
        description: { type: "string", description: "Description (for add/update)" },
        location: { type: "string", description: "Location (for add/update)" },
        attendees: { type: "array", items: { type: "string", description: "Email" }, description: "Attendee emails (for add/update)" },
        eventId: { type: "string", description: "Event ID (required for update/delete/set_metadata/get_metadata)" },
        from: { type: "string", description: "Range start ISO 8601 (for list, default: now)" },
        to: { type: "string", description: "Range end ISO 8601 (for list, default: +7d)" },
        limit: { type: "number", description: "Max events (for list, default 20)" },
        accountId: { type: "string", description: "Google account ID" },
        calendarId: { type: "string", description: "Calendar ID (default: primary)" },
        visibility: { type: "string", enum: ["default", "public", "private", "confidential"], description: "Event visibility (for add/update). default = calendar default, public = visible to all, private = only attendees, confidential = shows as busy to others" },
        googleEventId: { type: "string", description: "Google Calendar event ID (for set_metadata/get_metadata/link_task)" },
        eventType: { type: "string", enum: ["focus_block", "exercise", "meeting", "planning", "admin", "personal"], description: "Event type classification (for set_metadata)" },
        notes: { type: "string", description: "Optional notes for the event metadata (for set_metadata)" },
        metadataId: { type: "number", description: "Metadata record ID (for link_task)" },
        taskId: { type: "number", description: "Task ID to link (for link_task)" },
        priorityTitle: { type: "string", description: "Priority title to link instead of a task (for link_task)" },
        linkId: { type: "number", description: "Task/artifact link record ID to remove (for unlink_task/unlink_artifact)" },
        libraryPageId: { type: "string", description: "Library page ID or slug to link as a meeting artifact (for link_artifact)" },
        artifactKind: { type: "string", description: "Artifact kind such as brief, agenda, research, follow_up, or recap (for link_artifact)" },
        attendeeEmails: { type: "array", items: { type: "string" }, description: "Attendee emails for auto-linking people (for set_metadata)" },
      },
      required: ["action"],
    },
  },
  git: {
    description: "Interact with Git repositories — clone, pull, browse history, diff, branch, checkout, show, and write changes (add, commit, push, create_pr). Write actions only work on cloned repos in repos/.",
    category: "work",

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["clone", "pull", "status", "log", "diff", "branch", "checkout", "show", "add", "commit", "push", "create_pr", "merge_pr", "delete_branch"], description: "Action to perform" },
        url: { type: "string", description: "Repo URL (for clone)" },
        platformEnvironmentId: { type: "number", description: "Optional Platform Environment ID for platform-first clone auth. If omitted, clone infers a matching Platforms source binding by owner/repo before falling back to legacy Git auth." },
        connectionId: { type: "number", description: "Optional provider connection ID for platform-first clone auth. Used to disambiguate matching Platforms source bindings." },
        directory: { type: "string", description: "Use \".\", \"self\", or omit to target the workspace root repo (read-only: status, log, diff, show, branch list). For cloned repos and all write actions, specify the directory name inside repos/." },
        branch: { type: "string", description: "Branch name" },
        ref: { type: "string", description: "Git ref (for show/checkout)" },
        ref1: { type: "string", description: "First ref (for diff)" },
        ref2: { type: "string", description: "Second ref (for diff)" },
        file: { type: "string", description: "File path (for diff/checkout)" },
        count: { type: "number", description: "Log entries (default 20)" },
        grep: { type: "string", description: "Filter log by message" },
        branchAction: { type: "string", enum: ["list", "create", "switch"], description: "Branch sub-action" },
        name: { type: "string", description: "Branch name (for create/switch)" },
        files: { type: "array", items: { type: "string" }, description: "File paths to stage (for add). Use [\".\"] for all changes." },
        message: { type: "string", description: "Commit message (for commit)" },
        title: { type: "string", description: "PR title (for create_pr)" },
        body: { type: "string", description: "PR description in markdown (for create_pr)" },
        base: { type: "string", description: "Base branch for PR (for create_pr, default: main)" },
        draft: { type: "boolean", description: "Create as draft PR (for create_pr, default: false)" },
        force: { type: "boolean", description: "Force push (for push, default: false)" },
        pr_number: { type: "number", description: "PR number (for merge_pr)" },
        merge_method: { type: "string", enum: ["merge", "squash", "rebase"], description: "Merge method (for merge_pr, default: squash)" },
        commit_title: { type: "string", description: "Custom merge commit title (for merge_pr)" },
        commit_message: { type: "string", description: "Custom merge commit message (for merge_pr)" },
      },
      required: ["action"],
    },
  },
  strategy: {
    description: "Strategic modeling — create strategies, manage actors, build move trees, run simulations, manage assumptions, track artifacts. Always call list_strategies first.",
    category: "strategy",

    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "list_strategies", "get_strategy", "create_strategy", "update_strategy", "delete_strategy",
            "list_actors", "get_actor", "add_actor", "update_actor", "remove_actor",
            "get_move_tree", "get_move", "get_move_path", "create_move", "update_move", "delete_move",
            "reparent_move", "list_child_moves", "set_actor_states",
            "link_assumption_to_move", "unlink_assumption_from_move",
            "list_notes", "add_note", "update_note", "delete_note",
            "list_context", "add_context", "update_context", "delete_context",
            "add_end_condition", "list_end_conditions", "update_end_condition", "delete_end_condition",
            "add_assumption", "list_assumptions", "update_assumption", "delete_assumption", "cascade_assumption",
            "list_artifacts", "get_artifact", "create_artifact", "delete_artifact",
            "list_move_definitions", "get_move_definition", "create_move_definition", "update_move_definition", "delete_move_definition",
            "evaluate_move",
            "list_states", "get_state", "create_state", "update_state", "delete_state",
            "set_end_condition_effect",
          ],
          description: "Action to perform — see tool description for required params per action",
        },
        goalId: { type: "string", description: "Strategy ID — REQUIRED for most actions. Call list_strategies first to get available goalIds." },
        id: { type: "string", description: "Entity ID (actor, move, assumption, end condition, note, artifact, or simulation run)" },
        moveId: { type: "string", description: "Move instance ID or refId (short hash like 'emo1Jg')" },
        assumptionId: { type: "string", description: "Assumption ID (for link/unlink_assumption_to_move)" },
        parentMoveInstanceId: { type: "string", description: "Parent move instance ID (null for root)" },
        parentId: { type: "string", description: "Parent move instance ID (required for list_child_moves)" },
        newParentId: { type: "string", description: "New parent move instance ID for reparent_move (null or omit to move to root)" },
        actorId: { type: "string", description: "Actor ID" },
        moveDefinitionId: { type: "string", description: "Move definition ID (REQUIRED for create_move — use list_move_definitions to find one, or create_move_definition first)" },
        title: { type: "string", description: "Title for strategy, move, or assumption" },
        description: { type: "string", description: "Description text" },
        status: { type: "string", description: "Status: unexplored, explored, or terminal" },
        name: { type: "string", description: "Actor name" },
        notes: { type: "string", description: "Actor notes" },
        personId: { type: "string", description: "Person ID to link actor to" },
        influence: { type: "number", description: "Actor influence 0-1 (1.0 = fully controllable, 0 = no influence). Affects move probability reasoning." },
        probability: { type: "number", description: "Probability 0-1" },
        impact: { type: "string", description: "Impact assessment for a move" },
        source: { type: "string", description: "Move source: manual or simulated" },
        analysis: { type: "string", description: "Analysis text for a move (shown in Analysis section)" },
        actorStates: { type: "array", items: { type: "object", properties: { actorId: { type: "string" }, state: { type: "string" } } }, description: "Array of {actorId, state} — actor states for a move (used by set_actor_states, create_move, update_move). IMPORTANT: Only include state entries for actors whose state ACTUALLY CHANGES as a result of this move. Do NOT include unchanged actors or placeholder states like 'Standing by' or 'No change'. Omit actors whose state remains the same." },
        fileName: { type: "string", description: "File name for create_artifact (e.g. 'analysis.md')" },
        type: { type: "string", enum: ["historical", "current_position"], description: "Note/context entry type" },
        content: { type: "string", description: "Note/context entry content" },
        isRequired: { type: "boolean", description: "Whether end condition is required" },
        isSatisfied: { type: "boolean", description: "Whether end condition is satisfied" },

        polarity: { type: "string", enum: ["positive", "negative"], description: "Polarity for link_assumption_to_move: 'positive' multiplies probability by assumption probability, 'negative' multiplies by (1 - probability). Defaults to 'positive'." },
        baseProbability: { type: "number", description: "Base probability 0-1 for a move (before assumption polarity adjustments). Effective probability is recomputed automatically." },
        endConditionEffects: { type: "array", items: { type: "object", properties: { endConditionId: { type: "string" }, effect: { type: "string", enum: ["satisfies", "blocks", "none"] } }, required: ["endConditionId", "effect"] }, description: "Per-move end-condition effects (the only supported way to set move↔end-condition relationships): 'satisfies' contributes to that EC; 'blocks' disqualifies any path containing this move from satisfying that required EC; 'none' clears any prior effect." },
        stateId: { type: "string", description: "State (Milestone) ID — for update_state / delete_state" },
        parentStateId: { type: "string", description: "When set on a move, this move starts from the named state (instead of being a child of a parent move). Use list_states to find IDs." },
        terminatingStateId: { type: "string", description: "When set on a move, this move terminates at the named state — paths converge here. Use list_states to find IDs." },
        endConditionId: { type: "string", description: "End-condition ID — for set_end_condition_effect" },
        effect: { type: "string", enum: ["satisfies", "blocks", "none"], description: "End-condition effect for set_end_condition_effect" },
      },
      required: ["action"],
    },
  },
  decisions: {
    description: "Personal decision log — track strategic decisions with three sections (data, scenarios, plan), open/closed lifecycle, traffic-light status (closed only), append-only updates on closed decisions, and links to strategies/projects. Always call list first.",
    category: "strategy",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "get", "create", "update", "delete", "lock", "reopen", "add_update", "edit_update", "delete_update", "add_link", "remove_link"],
          description: "Action to perform",
        },
        id: { type: "string", description: "Decision ID" },
        updateId: { type: "string", description: "Decision update ID (for edit_update / delete_update)" },
        linkId: { type: "string", description: "Decision link ID (for remove_link)" },
        title: { type: "string", description: "Decision title (create/update)" },
        description: { type: "string", description: "Short decision description (create/update)" },
        status: { type: "string", enum: ["open", "closed", "all"], description: "Filter for list" },
        trafficLight: { type: "string", enum: ["green", "yellow", "red"], description: "Traffic-light status (only valid on closed decisions; pass via update)" },
        dataContent: { type: "string", description: "Markdown content for the Data section" },
        scenariosContent: { type: "string", description: "Markdown content for the Scenarios section" },
        planContent: { type: "string", description: "Markdown content for the Plan section" },
        content: { type: "string", description: "Update entry text (for add_update / edit_update)" },
        targetType: { type: "string", enum: ["strategy", "project"], description: "Link target type" },
        targetId: { type: "string", description: "Link target ID (strategy goal id or project id)" },
      },
      required: ["action"],
    },
  },
  exec: {
    description: "Manage the Exec page — skills inventory, experience log, opportunities pipeline, verified metrics/education, and opportunity artifacts. Actions: list_skills, get_skill, create_skill, update_skill, delete_skill, list_experience, get_experience, create_experience, update_experience, delete_experience, list_opportunities, get_opportunity, create_opportunity, update_opportunity, delete_opportunity, list_passions, get_passion, create_passion, update_passion, delete_passion, list_metrics, create_metric, update_metric, delete_metric, list_education, create_education, update_education, delete_education, set_artifact, get_opportunity_artifacts, render_artifact_docx.",
    category: "knowledge",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list_skills", "get_skill", "create_skill", "update_skill", "delete_skill", "list_experience", "get_experience", "create_experience", "update_experience", "delete_experience", "list_opportunities", "get_opportunity", "create_opportunity", "update_opportunity", "delete_opportunity", "list_passions", "get_passion", "create_passion", "update_passion", "delete_passion", "list_metrics", "create_metric", "update_metric", "delete_metric", "list_education", "create_education", "update_education", "delete_education", "set_artifact", "get_opportunity_artifacts", "render_artifact_docx"], description: "Action to perform" },
        id: { type: "number", description: "Skill or experience ID (for get/update/delete)" },
        name: { type: "string", description: "Skill name (required for create_skill)" },
        category: { type: "string", enum: ["technical", "business", "creative", "interpersonal", "domain"], description: "Skill category" },
        skillType: { type: "string", enum: ["foundational", "applied", "tool", "domain"], description: "Skill type section: foundational (base capabilities), applied (produce deliverables), tool (specific technologies), domain (accumulated field knowledge)" },
        proficiency: { type: "string", enum: ["novice", "developing", "competent", "proficient", "expert"], description: "Proficiency level" },
        energyLevel: { type: "string", enum: ["draining", "neutral", "energizing", "flow"], description: "Energy level" },
        domain: { type: "string", description: "Experience domain (required for create_experience)" },
        narrative: { type: "string", description: "Experience narrative" },
        years: { type: "number", description: "Years of experience" },
        startDate: { type: "string", description: "Start date YYYY-MM format (for experience)" },
        endDate: { type: "string", description: "End date YYYY-MM format, null for present (for experience)" },
        keyOutcomes: { type: "array", items: { type: "string" }, description: "Key outcomes" },
        transferableAssets: { type: "array", items: { type: "string" }, description: "Transferable assets" },
        title: { type: "string", description: "Opportunity title (required for create_opportunity)" },
        description: { type: "string", description: "Opportunity description" },
        type: { type: "string", enum: ["job", "consulting", "business", "passive_income"], description: "Opportunity type (required for create_opportunity)" },
        status: { type: "string", enum: ["discovered", "qualified", "researched", "pursuing", "active", "passed", "lost"], description: "Opportunity status" },
        probability: { type: "number", description: "Probability 0-1 (for opportunities)" },
        isFullTime: { type: "boolean", description: "Whether opportunity is full time" },
        hoursPerWeek: { type: "number", description: "Hours per week commitment" },
        timeCommitmentPeriod: { type: "string", enum: ["week", "month"], description: "Time commitment period" },
        timeHorizonMonths: { type: "number", description: "Months until income starts" },
        evInputs: { type: "object", description: "Type-specific EV inputs (e.g. {annualComp: 150000} for job, {rate: 200, hoursPerWeek: 20, durationMonths: 6} for consulting)" },
        company: { type: "string", description: "Company name (for experience or job opportunities)" },
        location: { type: "string", description: "Location (e.g. 'Remote', city name)" },
        teamSizePeak: { type: "number", description: "Peak team size (for experience)" },
        directReports: { type: "number", description: "Number of direct reports (for experience)" },
        pnlOwned: { type: "string", description: "P&L ownership scope (for experience)" },
        budgetManaged: { type: "string", description: "Budget managed scope (for experience)" },
        fundingRaised: { type: "string", description: "Total funding raised (for experience)" },
        companyContext: { type: "string", description: "Company context/description (for experience)" },
        nextSteps: { type: "string", description: "Next steps for this opportunity" },
        priority: { type: "string", enum: ["high", "mid", "low"], description: "Opportunity priority" },
        contactPersonId: { type: "string", description: "People person ID for contact" },
        sourceType: { type: "string", enum: ["manual", "landscape", "referral"], description: "How opportunity was sourced" },
        sourceSignalId: { type: "string", description: "Landscape signal ID if sourced from signal" },
        requiredSkills: { type: "array", items: { type: "string" }, description: "Skills required for this opportunity" },
        statusFilter: { type: "string", description: "Filter opportunities by status (for list_opportunities)" },
        typeFilter: { type: "string", description: "Filter opportunities by type (for list_opportunities)" },
        tier: { type: "string", enum: ["mission", "value", "exploration"], description: "Passion tier (required for create_passion)" },
        content: { type: ["string", "object"], description: "Passion content text (create_passion) or structured artifact content (render_artifact_docx)" },
        sourceRef: { type: "string", description: "Source reference for passion (optional)" },
        position: { type: "number", description: "Display order position (for passions)" },
        jdText: { type: "string", description: "Job description text (to store on an opportunity)" },
        jobUrl: { type: "string", description: "URL of the job posting (for opportunities)" },
        championPersonId: { type: "string", description: "People person ID for the champion/key contact at this opportunity (for create/update_opportunity)" },
        followUpBy: { type: "string", description: "Follow-up deadline date YYYY-MM-DD (for create/update_opportunity)" },
        followUpNote: { type: "string", description: "Note about what the follow-up should cover (for create/update_opportunity)" },
        format: { type: "string", enum: ["headline", "cv"], description: "Resume format: headline (1 page) or cv (full). Default: headline" },
        libraryPageId: { type: "string", description: "Library page ID/slug to link as artifact (for set_artifact; pass null to clear)" },
        opportunityId: { type: "number", description: "Opportunity ID for set_artifact/get_opportunity_artifacts/render_artifact_docx" },
        experienceId: { type: "number", description: "Experience ID for metrics" },
        metric: { type: "string", description: "Metric name" },
        value: { type: "string", description: "Metric value" },
        institution: { type: "string", description: "Education institution" },
        degree: { type: "string", description: "Education degree" },
        field: { type: "string", description: "Education field" },
        year: { type: "string", description: "Education year" },
        notes: { type: "string", description: "Education notes" },
        kind: { type: "string", description: "Artifact kind: resume, cover_letter, or research (for set_artifact/render_artifact_docx)" },
        fileName: { type: "string", description: "Optional DOCX filename" },
      },
      required: ["action"],
    },
  },
  theses: {
    description: "Manage theses — hard-to-vary explanations backed by evidence and tested by predictions. Actions: list, get, create, update, delete, add_evidence, update_evidence, remove_evidence, add_prediction, resolve_prediction, remove_prediction.",
    category: "knowledge",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "get", "create", "update", "delete", "add_evidence", "update_evidence", "remove_evidence", "add_prediction", "resolve_prediction", "remove_prediction"], description: "Action to perform" },
        id: { type: "string", description: "Thesis ID (for get/update/delete/add_evidence/add_prediction)" },
        title: { type: "string", description: "Thesis title (for create/update)" },
        statement: { type: "string", description: "The hard-to-vary claim (for create/update)" },
        tags: { type: "array", items: { type: "string" }, description: "Freeform tags (for create/update)" },
        status: { type: "string", enum: ["draft", "active", "superseded", "invalidated", "all"], description: "Status (for create/update/list filter)" },
        conviction: { type: "string", enum: ["low", "high"], description: "Conviction level — binary stance (for create/update)" },
        successorId: { type: "string", description: "Successor thesis ID (for update when superseding)" },
        content: { type: "string", description: "Evidence summary text (for add_evidence/update_evidence)" },
        sourceUrl: { type: "string", description: "Evidence source URL (for add_evidence/update_evidence)" },
        position: { type: "number", description: "Evidence display order (for add_evidence/update_evidence)" },
        evidenceId: { type: "string", description: "Evidence ID (for update_evidence/remove_evidence)" },
        claim: { type: "string", description: "Prediction claim (for add_prediction)" },
        deadline: { type: "string", description: "Prediction deadline YYYY-MM-DD (for add_prediction)" },
        outcome: { type: "string", enum: ["pending", "correct", "incorrect", "expired"], description: "Prediction outcome (for resolve_prediction)" },
        predictionId: { type: "string", description: "Prediction ID (for resolve_prediction/remove_prediction)" },
        resolutionNotes: { type: "string", description: "Optional notes explaining prediction resolution (for resolve_prediction)" },
      },
      required: ["action"],
    },
  },
  news: {
    description: "Manage the News system — signal discovery, surfaced items, sources, topics, diagnostics, and scan runs. Actions: summary (health + counts + latest surfaced), scan, list_signals, get_signal, dismiss_signal, save_signal, surface_signal, add_source, list_sources, update_source, delete_source, list_scan_runs, interest_graph, batch_curate.",
    category: "knowledge",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["summary", "scan", "list_signals", "get_signal", "dismiss_signal", "save_signal", "surface_signal", "add_source", "add_topic", "list_sources", "update_source", "delete_source", "list_scan_runs", "interest_graph", "batch_curate"], description: "Action to perform" },
        decisions: { type: "array", description: "Array of curation decisions (for batch_curate). Each: { fingerprint, isRelevant, score, title, reason, matchedTopics, summary? }", items: { type: "object" } },
        id: { type: "string", description: "Signal or source ID (for get_signal, dismiss_signal, save_signal, surface_signal, update_source, delete_source)" },
        source_type: { type: "string", enum: ["channel_x", "channel_web", "x", "web", "x_account", "reddit", "rss", "subreddit", "rss_feed", "pinned_topic", "hackernews", "github_repo", "polymarket", "stocktwits", "arxiv", "youtube_channel"], description: "Optional source type. For list_signals accepts channel or stored item types. For add/list/update sources use channel_x, channel_web, x_account, subreddit, rss_feed, pinned_topic, hackernews, github_repo, polymarket, stocktwits, arxiv, youtube_channel." },
        value: { type: "string", description: "Source value — account, URL, subreddit, topic, etc. (for add_source/update_source)" },
        enabled: { type: "boolean", description: "Toggle source on/off (for update_source)" },
        status: { type: "string", enum: ["new", "surfaced", "dismissed", "saved", "archived"], description: "Filter by status (for list_signals)" },
        limit: { type: "number", description: "Max results (for list_signals, list_scan_runs, default 50)" },
        offset: { type: "number", description: "Pagination offset (for list_signals)" },
        min_relevance: { type: "number", description: "Minimum relevance score filter (for list_signals, 0-1)" },
        curation_status: { type: "string", enum: ["unread", "snippet_only", "read", "failed"], description: "Filter signals by article-read/curation status" },
        has_curation: { type: "boolean", description: "Filter signals by whether curatedTitle and curatedReason are both present" },
        matched_topic: { type: "string", description: "Filter signals whose matchedTopics include this exact topic" },
        query: { type: "string", description: "Search title, snippet, curated title, and curated reason" },
        created_after: { type: "string", description: "Filter scannedAt after this ISO timestamp" },
        created_before: { type: "string", description: "Filter scannedAt before this ISO timestamp" },
      },
      required: ["action"],
    },
  },
  pronunciation: {
    description: "Manage pronunciation dictionary entries — teach Agent how to correctly pronounce names, brands, and technical terms. Actions: list, add, update, remove. Entries are case-sensitive.",
    category: "voice",

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add", "update", "remove"], description: "The action to perform" },
        word: { type: "string", description: "The word as written (case-sensitive, required for add/update/remove)" },
        alias: { type: "string", description: "How the word should be pronounced (required for add/update)" },
      },
      required: ["action"],
    },
  },
  preferences: {
    description: "Manage learned user preferences — likes, dislikes, working styles, personal facts. Actions: list, get, save, create, update, delete, reinforce.",
    category: "knowledge",

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "get", "save", "create", "update", "delete", "reinforce"], description: "The action to perform" },
        id: { type: "string", description: "Preference ID (required for get, update, delete, reinforce)" },
        domain: { type: "string", description: "Preference domain/category (e.g., 'communication', 'work_style', 'food', 'tech'). Required for save." },
        preference: { type: "string", description: "The preference text (required for save)" },
        personName: { type: "string", description: "Person this preference belongs to (defaults to the user)" },
        evidence: { type: "array", items: { type: "string", description: "A supporting quote or observation" }, description: "Supporting evidence or quotes for this preference" },
        confidence: { type: "number", description: "Confidence level 0-1 (default 0.5)" },
        tags: { type: "array", items: { type: "string", description: "A category tag" }, description: "Tags for categorization" },
      },
      required: ["action"],
    },
  },
  rules: {
    description: "Manage behavioral rules and operational directives. Actions: list, get, save, create, update, delete, reinforce, violation.",
    category: "knowledge",

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "get", "save", "create", "update", "delete", "reinforce", "violation"], description: "The action to perform" },
        id: { type: "string", description: "Rule ID (required for get, update, delete, reinforce, violation)" },
        rule: { type: "string", description: "The rule text (required for save)" },
        source: { type: "string", enum: ["correction", "reflection", "manual"], description: "How this rule was derived (default: manual)" },
        scope: { type: "string", enum: ["always", "contextual"], description: "Whether the rule always applies or only in certain contexts (default: contextual)" },
        context: { type: "string", description: "When/where this rule applies (for contextual rules)" },
        confidence: { type: "number", description: "Confidence level 0-1 (default 0.5)" },
        principleRef: { type: "string", description: "Reference to a related principle" },
        tags: { type: "array", items: { type: "string", description: "A category tag" }, description: "Tags for categorization" },
      },
      required: ["action"],
    },
  },
  priorities: {
    description: "DEPRECATED — compatibility shim for check-in artifact metadata only. Use the goals tool directly for all goal and priority operations.",
    category: "work",

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["set_review", "set_daily_plan", "get_daily_artifacts", "set_weekly_reflection", "set_weekly_plan", "set_monthly_plan", "set_monthly_reflection", "set_quarterly_plan", "set_quarterly_reflection"], description: "Deprecated compatibility action. Priority CRUD has been removed; use goals for all priority operations. set_brief is intentionally no longer advertised; use library surfacing for Daily Brief visibility." },
        libraryPageId: { type: "string", description: "Library page ID to link as review/plan/reflection" },
        date: { type: "string", description: "Date in YYYY-MM-DD format (for daily artifacts)" },
        week: { type: "string", description: "Any date within the target week in YYYY-MM-DD format" },
        month: { type: "string", description: "Target month in YYYY-MM format" },
        quarter: { type: "string", description: "Target quarter in YYYY-QN format" },
      },
      required: ["action"],
    },
  },
  orient: {
    description: "Unified session orientation — set title, topics, and persona in a single call. On first-turn orientation (no title set yet), `persona` is REQUIRED and the call will be rejected without it. For mid-session re-orientation, all parameters are optional for partial updates.",
    category: "communication",

    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Session title, 1-3 words" },
        topics: { type: "array", items: { type: "string" }, description: "Topic keywords, up to 8" },
        persona: { type: ["string", "number"], description: "Persona name or numeric ID to activate" },
        contextFlags: {
          type: "object",
          description: "Context section flags — map of section ID to boolean. true = include, false = exclude. Bootstrap sections cannot be excluded. Flags merge with any existing flags on the session.",
          additionalProperties: { type: "boolean" },
        },
        reasoning: { type: "string", description: "Brief explanation of why these orientation choices were made" },
      },
      required: [],
    },
    whenToUse: "On the first turn of every session to set title, topics, and persona together — persona is REQUIRED on the first call (before any title is set) and will be rejected without it. Also for mid-session re-orientation when the conversation's purpose shifts (persona optional on updates). Use contextFlags to control which context sections are assembled.",
  },
  session: {
    description: "Manage session metadata and lifecycle. Actions: 'get' reads any session's metadata by ID, 'set_status' records lifecycle completion/failure via session.status, 'end' ends the current session, 'list' returns all conversations, 'search' finds conversations by query, 'get_messages' retrieves messages for a session, 'spawn_child' forks a linked child conversation seeded with a warm-start brief from this session (idempotent on parent + spawnReason), and 'send_message' delivers a cross-session message to any target session by ID.",
    category: "communication",

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "set_status", "end", "list", "search", "get_messages", "spawn_child", "send_message"], description: "Action to perform" },
        sessionId: { type: "string", description: "Target session ID (for get/get_messages/send_message; defaults to current session for get/get_messages)" },
        runStatus: { type: "string", enum: ["resolved", "saved", "failed"], description: "Lifecycle state to set for set_status. resolved is accepted as a legacy alias for saved; session.status is the source of truth." },
        summary: { type: "string", description: "Brief summary of the session (for end)" },
        limit: { type: "number", description: "Max results to return (for list/search/get_messages)" },
        type: { type: "string", description: "Filter by session type (for list)" },
        status: { type: "string", description: "Filter by status (for list)" },
        query: { type: "string", description: "Search query (for search)" },
        topic: { type: "string", description: "Short topic/title for the new child session (for spawn_child)" },
        reason: { type: "string", description: "Free-text reason describing why the child is being spawned (for spawn_child); included in the warm-start brief" },
        spawnReason: { type: "string", description: "Idempotency key for spawn_child; reusing the same (parent, spawnReason) returns the existing child instead of creating a new one. Defaults to 'spawn_child:<topic>'." },
        content: { type: "string", description: "Message body to deliver for send_message." },
        toSessionId: { type: "string", description: "Alternative target session ID for send_message." },
      },
      required: ["action"],
    },
  },
  converse: {
    description: "Communication with the user. Actions: 'initiate' (default) starts a new session; 'set_attention' flags an existing session so the user sees a pin badge.",
    category: "communication",

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["initiate", "set_attention"], description: "Action to perform (default: initiate)" },
        topic: { type: "string", description: "Short session topic / title (for initiate)" },
        message: { type: "string", description: "Opening message to the user (for initiate)" },

        sessionId: { type: "string", description: "The session ID to flag (for set_attention). If omitted, defaults to the current session." },
        isPinned: { type: "boolean", description: "Whether to set or clear the pin flag (for set_attention, default true)" },
      },
      required: [],
    },
  },
  router: {
    description: "Call and inspect the model routing layer. Actions: eval, list_inference_calls, get_inference_call.",
    category: "knowledge",

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["eval", "list_inference_calls", "get_inference_call"], description: "eval: run an arbitrary prompt through the production model router without writing app state. list_inference_calls/get_inference_call inspect audited model calls." },
        id: { type: "string", description: "Inference call ID (for get_inference_call)" },
        profile: { type: "string", description: "For eval: requested routing profile alias such as memory, chat, reasoning, cheap, work. router.eval returns this as requestedProfile and also returns the resolved/audit tier. For list: filter by recorded profile/tier." },
        activityId: { type: "string", description: "Optional explicit activity ID for router.eval. Overrides profile alias while still using production routing." },
        systemPrompt: { type: "string", description: "System prompt for eval." },
        userPrompt: { type: "string", description: "User prompt/source text for eval." },
        jsonMode: { type: "boolean", description: "Request JSON-mode output and parse the response when possible." },
        temperature: { type: "number", description: "Eval temperature, clamped 0-1. Default 0.2." },
        maxTokens: { type: "number", description: "Eval output token cap, clamped 1-4000. Default 1200." },
        metadata: { type: "object", description: "Optional audit metadata such as purpose, sampleId, promptVersion." },
        limit: { type: "number", description: "Max number of inference calls to return (default 50, max 200)." },
        model: { type: "string", description: "Filter inference calls by model name." },
        status: { type: "string", enum: ["complete", "past"], description: "Filter inference calls: complete = this boot session, past = before this boot." },
      },
      required: ["action"],
    },
  },
  plan: {
    description: "Create, inspect, associate, modify, and execute multi-step plans. Plans decompose complex work into tracked steps, each executed in a spawned child session with fresh context. Progress is checkpointed to a Library page after every step. Actions: create (build a new plan), get (inspect plan status), associate_session (link an existing plan to the current session without execution), list (browse all plans), execute (start running a plan), update_step (manually update a step's status/outcome), edit (rename or revise plan metadata/step definitions), add_steps (insert new steps mid-execution), pause (halt execution after current step), resume (restart from next pending step).",
    category: "execution",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "get", "associate_session", "list", "execute", "update_step", "edit", "add_steps", "pause", "resume"], description: "Action to perform" },
        title: { type: "string", description: "Plan title (for create/edit)" },
        steps: { type: "array", items: { type: "object", properties: { title: { type: "string" }, instructions: { type: "string" } }, required: ["title", "instructions"] }, description: "Ordered steps with title and instructions (for create)" },
        planId: { type: "string", description: "Plan ID — prefer the Plan DB ID; Library page ID or slug also resolve when unambiguous (for get, associate_session, execute, update_step, edit, add_steps, pause, resume)" },
        goalId: { type: "string", description: "Optional goal to link (for create/edit)" },
        projectId: { type: "number", description: "Optional project to link (for create/edit)" },
        blocking: { type: "boolean", description: "Block originating session during execution (create/edit; default on create: auto — true for ≤5 steps, false for >5)" },
        workspace: { type: "string", description: "Git repo URL for shared workspace across steps (for create/edit)" },
        stepId: { type: "string", description: "Step ID within the plan (for update_step)" },
        status: { type: "string", enum: ["pending", "completed", "failed", "skipped", "blocked", "needs_review"], description: "Step status (for update_step). Use blocked for external dependency/error blocks and needs_review when Ray must test, approve, or respond." },
        stepEdits: { type: "array", items: { type: "object", properties: { stepId: { type: "string" }, title: { type: "string" }, instructions: { type: "string" }, status: { type: "string", enum: ["pending", "completed", "failed", "skipped", "blocked", "needs_review"] } }, required: ["stepId"] }, description: "Step definition edits for plan(action: edit). Each edit may change title, instructions, and/or status." },
        outcome: { type: "string", description: "Step outcome summary (for update_step)" },
        newSteps: { type: "array", items: { type: "object", properties: { title: { type: "string" }, instructions: { type: "string" } }, required: ["title", "instructions"] }, description: "New steps to add (for add_steps)" },
        afterStepId: { type: "string", description: "Insert new steps after this step ID, null to append (for add_steps)" },
        limit: { type: "number", description: "Max results (for list, default 20)" },
      },
      required: ["action"],
    },
  },

  workflows: {
    description: "Manage reusable workflow templates and workflow runs. Actions: list_templates, get_template, list_runs, get_run, create_run, start_run, pause_run, resume_run, cancel_run, start_stage_attempt, complete_stage_attempt, attach_artifact, capture_publish_stage_evidence, capture_acceptance_evidence, capture_calibration_evidence, approve_gate, reject_gate.",
    category: "execution",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list_templates", "get_template", "list_runs", "get_run", "create_run", "start_run", "pause_run", "resume_run", "cancel_run", "start_stage_attempt", "complete_stage_attempt", "attach_artifact", "capture_publish_stage_evidence", "capture_acceptance_evidence", "capture_calibration_evidence", "approve_gate", "reject_gate"], description: "Action to perform" },
        id: { type: "string", description: "Workflow run/template/gate ID alias" },
        templateId: { type: "string", description: "Workflow template ID, e.g. build-v1" },
        runId: { type: "string", description: "Workflow run ID" },
        workflowRunId: { type: "string", description: "Workflow run ID (alias for attach_artifact and evidence actions)" },
        title: { type: "string", description: "Workflow run title (for create_run) or artifact title (for attach_artifact)" },
        objective: { type: "string", description: "Workflow objective (for create_run)" },
        status: { type: "string", description: "Status filter or run status" },
        stageKey: { type: "string", description: "Stage key for start_stage_attempt" },
        attemptId: { type: "number", description: "Stage attempt ID for complete_stage_attempt" },
        stageAttemptId: { type: "number", description: "Stage attempt ID for artifact/evidence attachment" },
        result: { type: "string", enum: ["passed", "failed", "blocked", "skipped", "needs_review"], description: "Attempt result" },
        outputSummary: { type: "string", description: "Attempt output summary" },
        evidence: { type: "object", description: "Compact evidence packet" },
        gateId: { type: "number", description: "Gate ID" },
        decisionReason: { type: "string", description: "Reason for approving/rejecting a gate" },
        kind: { type: "string", description: "Artifact kind" },
        refType: { type: "string", description: "Artifact reference type" },
        refId: { type: "string", description: "Artifact reference ID" },
        url: { type: "string", description: "Artifact URL" },
        summary: { type: "string", description: "Artifact summary" },
        routePath: { type: "string", description: "Target app route path for acceptance evidence, e.g. /workflows" },
        optionalSmokeAttempted: { type: "boolean", description: "Whether a non-destructive feature smoke path was attempted during acceptance evidence capture" },
        decision: { type: "string", description: "Calibration decision, e.g. continue, update_docs, gate, fail_back" },
        documentationUpdated: { type: "boolean", description: "Whether documentation/protocol updates were completed during calibration" },
        specDelta: { type: "string", description: "Calibration note describing spec/protocol/product-loop delta" },
        failureContext: { type: "object", description: "Failure context or compact failure packet" },
        linkedPlanId: { type: "string", description: "Linked plan ID" },
        linkedProjectId: { type: "number", description: "Linked project ID" },
        linkedPlatformId: { type: "number", description: "Linked platform ID" },
        linkedProductId: { type: "number", description: "Linked product ID" },
        linkedEnvironmentId: { type: "number", description: "Linked platform environment ID" },
        limit: { type: "number", description: "Max records to return" },
      },
      required: ["action"],
    },
  },
  skills: {
    description: "Manage Agent's skill library — reusable instruction sets. Actions: list, get, create, update, delete, search, run, runs, scores. The 'get' action returns full skill details including the structured weighted checklist used by the scorer. The 'run' action spawns an autonomous skill execution. The 'runs' action returns recent execution history (status, duration, score, timestamps, and failureReason/endReason for failed runs) from skill_runs — same data shown in the dashboard's Run History panel. The 'scores' action returns scored runs from skill_runs (the source of truth).",
    category: "knowledge",

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "get", "create", "update", "delete", "search", "run", "runs", "scores"], description: "list: show all skills. get: read full skill details by name including structured checklist. create: add a new skill. update: modify an existing skill by id. delete: remove a user-created skill by id. search: find skills by query string. run: spawn an autonomous skill execution by skill ID. runs: get recent skill_runs (status, duration, pass rate, timestamps) for a skill by name — matches the dashboard Run History panel. scores: get scoring history from skill_runs." },
        id: { type: "string", description: "Skill UUID (for update, delete)" },
        name: { type: "string", description: "Skill name (for get, create, search)" },
        query: { type: "string", description: "Search query (for search action)" },
        category: { type: "string", description: "Skill category (for list filter, or create/update)" },
        description: { type: "string", description: "Skill description (for create/update)" },
        process: { type: "string", description: "Skill process/instructions (for create/update)" },
        outputSpec: { type: "string", description: "Output specification (for create/update)" },

        checklist: { type: "array", items: { type: "object", properties: { check: { type: "string" }, weight: { type: "number" } }, required: ["check"] }, description: "Structured quality checklist for scoring (for create/update). Array of {check: string, weight?: number}." },
        activity: { type: "string", description: "Activity type (for create/update)" },
        version: { type: "string", description: "Version string (for create/update)" },
        preContext: { type: "string", description: "Optional pre-context string to pass to the skill run (for run)" },
        wait: { type: "boolean", description: "If true (default), wait for the skill run to complete before returning. If false, fire-and-forget. (for run)" },
        limit: { type: "number", description: "Number of records to return (for runs and scores actions, default 20, max 50)" },
      },
      required: ["action"],
    },
  },
  agent_profile: {
    description: "Read or update the agent's own profile — name, metadata, and relationship state. Actions: get (read current profile), update (change agentName or store metadata about self). The agent can rename itself using this tool.",
    category: "cognition",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "update"], description: "Action to perform" },
        agentName: { type: "string", description: "New name for the agent (for update, 1-80 chars)" },
        metadata: { type: "object", description: "Metadata to merge into agent profile (for update)" },
      },
      required: ["action"],
    },
  },
  cognition: {
    description: "Manage Agent's cognitive state — emotional states and personas. Actions: set_emotion (record new state), get_emotion (current), emotion_history (recent), get_persona (current active), list_personas, create_persona, update_persona. Use the `orient` tool to activate/switch personas.",
    category: "cognition",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["set_emotion", "get_emotion", "emotion_history", "get_persona", "list_personas", "create_persona", "update_persona"], description: "Action to perform" },
        state_name: { type: "string", description: "Emotional state name (for set_emotion, e.g., 'focused', 'curious', 'frustrated')" },
        valence: { type: "number", description: "Emotional valence -1 (negative) to 1 (positive) (for set_emotion)" },
        arousal: { type: "number", description: "Emotional arousal 0 (calm) to 1 (activated) (for set_emotion)" },
        triggers: { type: "array", items: { type: "string" }, description: "What triggered this state (for set_emotion)" },
        context: { type: "string", description: "Context for the emotional state (for set_emotion)" },
        narrative: { type: "string", description: "A few sentences about what's alive emotionally — grounds the state in felt experience (for set_emotion)" },
        limit: { type: "number", description: "Max history entries (for emotion_history, default 10)" },
        id: { type: "number", description: "Persona ID (for update_persona)" },
        name: { type: "string", description: "Persona name (for create_persona)" },
        description: { type: "string", description: "Persona description (for create_persona, update_persona)" },
        prompt_overlay: { type: "string", description: "Behavioral prompt overlay (for create_persona, update_persona)" },
        expression_tags: { type: "array", items: { type: "string" }, description: "Recommended expression tags (for create_persona, update_persona)" },
        cognitive_overrides: { type: "object", description: "Cognitive parameter overrides (for create_persona, update_persona)" },
      },
      required: ["action"],
    },
    whenToUse: "When you want to set or query your emotional state or manage persona configurations. Use set_emotion when your cognitive state shifts. Use the `orient` tool to switch personas.",
  },
  observe: {
    description: "Record an observation about your own cognition. Not what you thought, but what you notice about how you thought. What pattern fired? What gap appeared? What changed? What connection formed? What's now possible? 1-3 short sentences MAX. If it doesn't pass 'would this change how I act next time?', don't record it.",
    category: "cognition",

    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["pattern", "gap", "change", "connection", "opportunity"], description: "Observation type: pattern (what repeats), gap (expected X found Y), change (was one way now different), connection (how things link), opportunity (what's now possible)" },
        content: { type: "string", description: "The observation to record. Should be specific, evidence-based, and non-redundant with recent observations." },
      },
      required: ["type", "content"],
    },
    whenToUse: "When you notice something about how you reasoned, decided, or acted — a pattern, a gap between expectation and reality, a shift, a connection between ideas, or an emerging opportunity. Metacognition, not reasoning.",
  },
  beliefs: {
    description: "Manage Agent's belief system — claims with confidence scores. Actions: list, get, save, create, update, invalidate.",
    category: "knowledge",

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "get", "save", "create", "update", "invalidate"], description: "The action to perform" },
        id: { type: "string", description: "Belief ID (required for get, update, invalidate)" },
        claim: { type: "string", description: "The belief claim (required for save/create)" },
        domain: { type: "string", description: "Belief domain (required for save/create, optional filter for list)" },
        confidence: { type: "number", description: "Confidence score 0–1 (default 0.5)" },
        status: { type: "string", enum: ["active", "uncertain", "invalidated"], description: "Belief status" },
        evidence: { type: "array", items: { type: "object", properties: { type: { type: "string" }, id: { type: "string" }, summary: { type: "string" } } }, description: "Evidence supporting the belief" },
        principleRef: { type: "string", description: "Reference to a related principle" },
        tags: { type: "array", items: { type: "string" }, description: "Tags for categorization" },
      },
      required: ["action"],
    },
  },
  finance: {
    description: "Query financial data from connected bank accounts. Actions: summary, transactions, holdings, liabilities, debt_payments, categories, budget, income, recurring, forecast, accounts, assets, goals, import_transactions, link_account, refresh, amortize, list_amortizations, remove_amortization.",
    category: "finance",

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["summary", "transactions", "holdings", "liabilities", "debt_payments", "categories", "budget", "income", "recurring", "forecast", "accounts", "assets", "goals", "import_transactions", "link_account", "refresh", "amortize", "list_amortizations", "remove_amortization"], description: "Action to perform" },
        transactionId: { type: "string", description: "Plaid transaction ID (for amortize)" },
        originalAmount: { type: "number", description: "Original lump amount in dollars (for amortize)" },
        spreadMonths: { type: "number", description: "Number of months to spread expense across, 1-120 (for amortize)" },
        startMonth: { type: "string", description: "Start month YYYY-MM (for amortize)" },
        isActive: { type: "boolean", description: "Whether amortization is active (for amortize update; pass an id to update an existing one)" },
        startDate: { type: "string", description: "Start date YYYY-MM-DD (for transactions)" },
        endDate: { type: "string", description: "End date YYYY-MM-DD (for transactions)" },
        category: { type: "string", description: "Plaid category filter (for transactions)" },
        accountId: { type: "string", description: "Account ID filter (for transactions)" },
        limit: { type: "number", description: "Max results (for transactions, default 50)" },
        months: { type: "number", description: "Number of months to forecast (for forecast, default 12)" },
        mode: { type: "string", enum: ["this_month", "last_month", "trailing_avg"], description: "Comparison mode (for budget, default this_month)" },
        month: { type: "string", description: "Specific month YYYY-MM (for budget, overrides mode when provided)" },
        goal_action: { type: "string", enum: ["list", "create", "update", "delete"], description: "Sub-action for goals (default list)" },
        name: { type: "string", description: "Goal name (for goals create/update)" },
        targetAmount: { type: "number", description: "Target dollar amount (for goals create/update)" },
        currentAmount: { type: "number", description: "Current dollar amount (for goals create/update, manual)" },
        targetDate: { type: "string", description: "Target date YYYY-MM-DD (for goals create/update)" },
        notes: { type: "string", description: "Notes (for goals create/update)" },
        linkedAccountIds: { type: "array", items: { type: "string" }, description: "Plaid account IDs to link (for goals create/update)" },
        id: { type: "number", description: "Goal ID (for goals update/delete)" },
      },
      required: ["action"],
    },
  },
  images: {
    description: "Generate, edit, or analyze images. Actions: generate (text-to-image), edit (combine/modify images), analyze (describe/extract from an image).",
    category: "media",

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["generate", "edit", "analyze"], description: "Action to perform" },
        prompt: { type: "string", description: "Text prompt — what to generate/edit, or what to look for when analyzing" },
        size: { type: "string", description: "Image size as WIDTHxHEIGHT (for generate, default 1024x1024). Both dimensions must be divisible by 16, aspect ratio between 1:3 and 3:1. Examples: 1024x1024, 1920x1080, 1080x1920" },
        quality: { type: "string", enum: ["low", "medium", "high", "auto"], description: "Image quality (for generate, default auto). Low is fastest/cheapest, high is most detailed." },
        background: { type: "string", enum: ["opaque", "auto"], description: "Background type (for generate, default auto). Note: transparent backgrounds not yet supported." },
        outputFormat: { type: "string", enum: ["png", "jpeg", "webp"], description: "Output image format (for generate, default png)" },
        depth: { type: "string", enum: ["quick", "deep"], description: "Analysis depth (for analyze). Quick uses a fast model, deep uses the most capable. Default uses the configured Media tier." },
        images: { type: "array", items: { type: "string" }, description: "Array of workspace file paths (for edit)" },
        path: { type: "string", description: "Workspace file path to an image (for analyze)" },
        url: { type: "string", description: "URL of an image to fetch and analyze (for analyze)" },
        base64: { type: "string", description: "Raw base64-encoded image data (for analyze)" },
        mediaType: { type: "string", description: "MIME type when using base64, e.g. image/png (for analyze, default image/png)" },
      },
      required: ["action"],
    },
  },
  timers: {
    description: "Manage scheduled timers and one-time reminders — list all or filter by name, get details by ID or name, view runs, create, update, delete, or manually trigger. Use type=reminder with frequency=once and fireAt for one-time reminders that auto-disable after firing. Actions: list, get, runs, create, update, delete, trigger.",
    category: "system",

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "get", "runs", "create", "update", "delete", "trigger"], description: "Action to perform" },
        id: { type: "string", description: "Timer ID (for get/runs/update/delete/trigger). For get, a timer name is also accepted as a fallback." },
        scheduleId: { type: "string", description: "Schedule ID within the timer (for trigger, defaults to first schedule)" },
        name: { type: "string", description: "Timer name (for create/update, or list filter)" },
        description: { type: "string", description: "Timer description (for create/update)" },
        type: { type: "string", enum: ["agent", "system", "me", "skill", "reminder"], description: "Timer type: agent, system, me, skill, reminder (for create). Use reminder for one-time scheduled prompts that auto-disable after firing." },
        prompt: { type: "string", description: "Timer prompt (for create/update)" },
        skillId: { type: "string", description: "Skill ID (for create/update, when type=skill)" },
        schedules: { type: "array", items: { type: "object", properties: { id: { type: "string", description: "Schedule ID" }, frequency: { type: "string", enum: ["every_x_minutes", "every_x_hours", "daily", "weekly", "monthly", "quarterly", "annually", "custom", "once"], description: "Schedule frequency. Use 'once' with fireAt for one-time reminders." }, interval: { type: "number", description: "Interval value (for every_x_minutes/every_x_hours)" }, timeOfDay: { type: "string", description: "Time of day HH:MM (for daily/weekly/monthly/quarterly/annually)" }, daysOfWeek: { type: "array", items: { type: "string", enum: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] }, description: "Days of the week (for weekly)" }, dayOfMonth: { type: "number", description: "Day of month 1-31 (for monthly)" }, monthOfYear: { type: "number", description: "Month of year 1-12 (for annually)" }, dayOfYear: { type: "number", description: "Day of year 1-366 (for annually)" }, quarter: { type: "number", description: "Quarter 1-4 (for quarterly)" }, cronExpression: { type: "string", description: "Cron expression (for custom)" }, fireAt: { type: "string", description: "ISO datetime string for one-time fire (use with frequency=once for reminders)" } }, required: ["id", "frequency"] }, description: "Schedule definitions (for create/update)" },
        enabled: { type: "boolean", description: "Whether timer is enabled (for create/update)" },
        timezone: { type: "string", description: "IANA timezone (for create/update, default America/New_York)" },
        limit: { type: "number", description: "Max timers to return for list (default 100) or max runs to return for runs (default 20)" },
      },
      required: ["action"],
    },
  },
  health: {
    description: "Query health metrics and fully manage the wellness calendar. Actions: summary (7-day summary by metric type), metrics (raw metric rows with optional type/date filters), list_activities (all active wellness activities), log_activity (record a completion by activityId or name with fuzzy match, optional date param YYYY-MM-DD for past-date logging), activity_status (all activities grouped by status: overdue/due_soon/on_track/never_done with urgency scores — includes tier and metricValue for metric-backed activities), create_activity (add a new wellness activity with name, intervalDays, category, and optional fields including linkedMetricType, greatThreshold, goodThreshold for metric-backed auto-completion), update_activity (modify an existing activity by activityId or name — set newName, benefit, risk, intervalDays, estimatedMinutes, estimatedCost, requirements, category, linkedMetricType, greatThreshold, goodThreshold, windowStart, windowEnd), delete_activity (archive an activity by activityId or name), activity_logs (view completion history with tier and metricValue, optionally filtered by activityId and days), delete_log (delete a specific log entry by logId), save_gratitude (upsert a gratitude entry — content required, date optional defaults to today, auto-logs Gratitude wellness activity), get_gratitude (get a single gratitude entry by date, defaults to today), list_gratitudes (list gratitude entries in reverse-chronological order, optional limit default 30), save_learning (upsert a learning entry — content required, date optional defaults to today, auto-logs Learning wellness activity), get_learning (get a single learning entry by date, defaults to today), list_learnings (list learning entries in reverse-chronological order, optional limit default 30).",
    category: "health",

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["summary", "metrics", "list_activities", "log_activity", "activity_status", "create_activity", "update_activity", "delete_activity", "activity_logs", "delete_log", "save_gratitude", "get_gratitude", "list_gratitudes", "save_learning", "get_learning", "list_learnings"], description: "Action to perform" },
        type: { type: "string", description: "Filter by metric type (for metrics)" },
        days: { type: "number", description: "Number of days to look back (for metrics, default 30) or max entries to return (for activity_logs, default 50)" },
        activityId: { type: "number", description: "Wellness activity ID (for log_activity, update_activity, delete_activity, activity_logs)" },
        name: { type: "string", description: "Wellness activity name for fuzzy match (for log_activity, update_activity, delete_activity) or exact name (for create_activity)" },
        notes: { type: "string", description: "Optional notes when logging an activity" },
        date: { type: "string", description: "Date in YYYY-MM-DD format (for log_activity past-date logging, save_gratitude, get_gratitude). Future dates not allowed for log_activity." },
        content: { type: "string", description: "Gratitude or learning entry text content (for save_gratitude/save_learning, max 5000 chars)" },
        limit: { type: "number", description: "Max entries to return (for list_gratitudes/list_learnings, default 30)" },
        logId: { type: "number", description: "Wellness log entry ID to delete (for delete_log)" },
        newName: { type: "string", description: "Rename an activity (for update_activity)" },
        intervalDays: { type: "number", description: "Recurrence interval in days (for create_activity, update_activity)" },
        category: { type: "string", enum: ["daily_practice", "weekly_ritual", "monthly_renewal", "quarterly_reset", "annual_checkup"], description: "Activity category — auto-derived from intervalDays if omitted (1d=daily, 2-7d=weekly, 8-30d=monthly, 31-90d=quarterly, 91+=annual). Override explicitly if needed." },
        benefit: { type: "string", description: "What this activity provides (for create_activity, update_activity)" },
        risk: { type: "string", description: "Risk of not doing this activity (for create_activity, update_activity)" },
        estimatedMinutes: { type: "number", description: "Estimated time in minutes (for create_activity, update_activity)" },
        estimatedCost: { type: "number", description: "Estimated cost in dollars (for create_activity, update_activity)" },
        requirements: { type: "string", description: "Prerequisites or equipment needed (for create_activity, update_activity)" },
        linkedMetricType: { type: "string", description: "Health metric type to link for auto-completion, e.g. 'mindful_minutes', 'steps' (for create_activity, update_activity)" },
        greatThreshold: { type: "number", description: "Daily metric value threshold for 'great' tier (for create_activity, update_activity)" },
        goodThreshold: { type: "number", description: "Daily metric value threshold for 'good' tier (for create_activity, update_activity)" },
        windowStart: { type: "number", description: "Window start boundary (for create_activity, update_activity). Meaning depends on category: hour 0-23 for daily, day 1-7 for weekly, day 1-28 for monthly, month-in-quarter 1-3 for quarterly, month 1-12 for annual" },
        windowEnd: { type: "number", description: "Window end boundary (for create_activity, update_activity). Same unit as windowStart. Supports wrap-around (e.g. daily 22-6 = 10pm to 6am)" },
      },
      required: ["action"],
    },
  },

  weather: {
    description: "Get weather data — current conditions, daily/hourly forecasts, historical weather, and NWS severe weather alerts. Default location: Chicago.",
    category: "weather",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["current", "forecast", "hourly", "alerts", "historical"], description: "Action to perform" },
        location: { type: "string", description: "City or place name to geocode (default: Chicago)" },
        latitude: { type: "number", description: "Latitude (use with longitude instead of location)" },
        longitude: { type: "number", description: "Longitude (use with latitude instead of location)" },
        days: { type: "number", description: "Number of forecast days (for forecast, default 7, max 16)" },
        hours: { type: "number", description: "Number of forecast hours (for hourly, default 24, max 168)" },
        startDate: { type: "string", description: "Start date YYYY-MM-DD (required for historical)" },
        endDate: { type: "string", description: "End date YYYY-MM-DD (for historical, defaults to startDate)" },
        timezone: { type: "string", description: "Timezone (default: America/Chicago)" },
      },
      required: ["action"],
    },
  },
  tools: {
    description: "Look up detailed tool documentation — list all tools or get full docs for a specific tool/action.",
    category: "system",

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "get"], description: "list = summary of all tools; get = detailed docs for one tool" },
        tool: { type: "string", description: "Tool name (for get)" },
      },
      required: ["action"],
    },
  },

  backup: {
    description: "Manage database backups — create snapshots, list history, inspect metadata, and delete old backups. Restore is intentionally not exposed to agents; humans must use the Dev page for restore operations. Actions: create, list, get, delete.",
    category: "system",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "list", "get", "delete"], description: "Action to perform" },
        id: { type: "string", description: "Backup ID (for get or delete)" },
        limit: { type: "number", description: "Max results (for list, default 20)" },
      },
      required: ["action"],
    },
  },

  message_sibling: {
    description: "Send a message to a sibling session (a session with the same parent as the caller). Sender and receiver both record the message in their history. Scope: direct siblings only — no grandparents, cousins, or unrelated sessions. Provide either 'toSessionId' or 'toSpawnReason'.",
    category: "system",
    parameters: {
      type: "object",
      properties: {
        toSessionId: { type: "string", description: "Target sibling session ID. Use this OR toSpawnReason." },
        toSpawnReason: { type: "string", description: "Match a sibling by spawn reason (title or sessionKey, e.g. 'advocate-a' matches sessionKey 'auto:advocate-a'). Use this OR toSessionId." },
        content: { type: "string", description: "Message body to deliver." },
      },
      required: ["content"],
    },
  },
  message_parent: {
    description: "Send a message to this session's direct parent. Both sessions record the message in their history. Only the immediate parent is reachable — grandparent and cross-tree messaging are rejected.",
    category: "system",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "Message body to deliver to the parent session." },
      },
      required: ["content"],
    },
  },
  message_child: {
    description: "Send a message to one of this session's direct children. Identify the child by 'toSessionId' or by 'toSpawnReason' (the same idempotency key used at spawn time). Only direct children are reachable — grandchildren and cross-tree messaging are rejected.",
    category: "system",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "Message body to deliver to the child session." },
        toSessionId: { type: "string", description: "Direct child session ID. Either this or 'toSpawnReason' is required." },
        toSpawnReason: { type: "string", description: "Spawn reason that uniquely identifies the target child. Either this or 'toSessionId' is required." },
      },
      required: ["content"],
    },
  },
  indexed_content: {
    description: "Retrieve archived content and structured indexes. Full originals are stored in object storage when content exceeds display limits — use this tool to list, inspect, or read specific sections of archived content by reference ID.",
    category: "system",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "get", "read_section"], description: "Action: list (recent indexed items), get (fetch index record), read_section (fetch raw text from a byte range)" },
        id: { type: "string", description: "Reference ID of the indexed content (for get, read_section)" },
        sourceType: { type: "string", description: "Filter by source type (for list, e.g., 'web_fetch', 'email', 'shell', 'file', 'compaction')" },
        limit: { type: "number", description: "Max results (for list, default 20)" },
        sectionIndex: { type: "number", description: "Section index to read (for read_section, 0-based)" },
        charOffset: { type: "number", description: "Character offset to start reading from (for read_section)" },
        charLength: { type: "number", description: "Number of characters to read (for read_section, default: entire remaining content)" },
      },
      required: ["action"],
    },
  },
  platforms: {
    description: "Manage platform infrastructure — provider connections, environments, bindings, build lifecycle configuration, workflow launch, and deployment status. Actions: list_connections, get_connection, test_connection, create_connection, list_environments, get_environment, get_environment_status, get_build_lifecycle, set_build_lifecycle, disable_build_lifecycle, delete_build_lifecycle, get_build_status, start_build_workflow, list_environment_workflows, create_platform, update_platform, create_product, update_product, create_environment, update_environment, delete_environment, save_source_binding, save_hosting_binding, save_context_artifact, get_context_artifacts, remove_context_artifact.",
    category: "system",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list_connections", "get_connection", "test_connection", "create_connection", "list_environments", "get_environment", "get_environment_status", "get_build_lifecycle", "set_build_lifecycle", "disable_build_lifecycle", "delete_build_lifecycle", "get_build_status", "start_build_workflow", "list_environment_workflows", "create_platform", "update_platform", "create_product", "update_product", "create_environment", "update_environment", "delete_environment", "save_source_binding", "save_hosting_binding", "save_context_artifact", "get_context_artifacts", "remove_context_artifact"], description: "Action to perform" },
        id: { type: "number", description: "Connection ID, Platform ID, Product ID, or Environment ID depending on action" },
        provider: { type: "string", description: "Provider name e.g. 'railway', 'github' (for create_connection)" },
        label: { type: "string", description: "Human-readable label (for create_connection)" },
        credential: { type: "string", description: "API token or credential value (for create_connection only — stored encrypted, never returned)" },
        name: { type: "string", description: "Platform/product/environment name (for create/update actions)" },
        description: { type: "string", description: "Description for platform/product create/update actions" },
        status: { type: "string", description: "Status for platform/product create/update actions: active, paused, archived" },
        connectionId: { type: "number", description: "Provider connection ID to bind (for save_source_binding, save_hosting_binding)" },
        owner: { type: "string", description: "Repo owner/org (for save_source_binding)" },
        repo: { type: "string", description: "Repo name (for save_source_binding)" },
        branch: { type: "string", description: "Branch name (for save_source_binding)" },
        autoDeploy: { type: "boolean", description: "Auto-deploy on push (for save_source_binding)" },
        codeIndexingEnabled: { type: "boolean", description: "Enable GitNexus code indexing for this environment source binding (for save_source_binding)" },
        projectId: { type: "string", description: "Railway project ID (for save_hosting_binding)" },
        providerEnvironmentId: { type: "string", description: "Railway environment ID (for save_hosting_binding)" },
        serviceId: { type: "string", description: "Railway service ID (for save_hosting_binding)" },
        projectName: { type: "string", description: "Railway project name (for save_hosting_binding)" },
        providerEnvironmentName: { type: "string", description: "Railway environment name (for save_hosting_binding)" },
        serviceName: { type: "string", description: "Railway service name (for save_hosting_binding)" },
        publicUrl: { type: "string", description: "Public URL (for save_hosting_binding)" },
        kind: { type: "string", description: "Context artifact kind/category label. Common kinds: coding_process, design_system, planning_process, product_definition. Multiple artifacts per kind are allowed. (for save_context_artifact, remove_context_artifact)" },
        libraryPageId: { type: "string", description: "Library page ID to link (for save_context_artifact)" },
        workflowTemplateId: { type: "string", description: "Workflow template ID for build lifecycle, e.g. build-v1" },
        providerKind: { type: "string", description: "Build provider kind: railway, eas, or manual" },
        deployPolicy: { type: "object", description: "Low-level deploy policy JSON for lifecycle config" },
        acceptanceTarget: { type: "object", description: "Acceptance target JSON, including url/routePath/healthCheckPath/screenshotRoutePath" },
        authMode: { type: "string", description: "Lifecycle auth mode: none, provider_connection, platform_binding, custom" },
        retryPolicy: { type: "object", description: "Retry policy JSON for build lifecycle and workflow runs" },
        gatePolicy: { type: "object", description: "Gate/autonomy policy JSON for build lifecycle and workflow runs" },
        evidenceConfig: { type: "object", description: "Evidence capture config JSON" },
        docsConfig: { type: "object", description: "Documentation config JSON" },
        enabled: { type: "boolean", description: "Whether the lifecycle config is enabled" },
        includeDisabled: { type: "boolean", description: "Include disabled lifecycle config when reading" },
        start: { type: "boolean", description: "For start_build_workflow, start the workflow immediately; defaults true" },
        objective: { type: "string", description: "Workflow objective override for start_build_workflow" },
        limit: { type: "number", description: "Max workflow runs to list" },
      },
      required: ["action"],
    },
  },
};

/**
 * Tool name aliases — canonical new names pointing to legacy tool definitions.
 * Bridge-tools also maps these aliases to the same handler functions.
 * Remove once all stored references (skills, memory, rules) have migrated.
 */
export const TOOL_ALIASES: Record<string, string> = {
  projects: "work",        // Domain 2: Work → Projects
  observations: "observe", // Domain 6: Observe → Observations
  create: "content",       // Domain 10: Content → Create
};

function normalizeCategory(cat: string): string {
  const lower = cat.toLowerCase().trim();
  const map: Record<string, string> = {
    "file operations": "file",
    "file": "file",
    "system": "system",
    "web & search": "web",
    "web": "web",
    "memory": "memory",
    "communication": "communication",
    "browser": "browser",
    "code": "code",
    "work": "work",
    "calendar": "calendar",
    "knowledge": "knowledge",
    "finance": "finance",
    "weather": "weather",
    "other": "system",
    "unknown": "system",
  };
  return map[lower] || lower;
}

let cachedRegistry: { tools: ToolDefinition[]; timestamp: number } | null = null;
const CACHE_TTL = 15000;

function describeRailwayReachableEnvironments(): string {
  const hasToken = !!getSecretSync("RAILWAY_API_TOKEN");
  const hasProject = !!getSecretSync("RAILWAY_PROJECT_ID");
  const reachable: string[] = [];
  const missing: string[] = [];
  if (hasToken && hasProject) {
    if (getSecretSync("RAILWAY_DEV_ENVIRONMENT_ID") && getSecretSync("RAILWAY_DEV_SERVICE_ID") && getSecretSync("RAILWAY_DEV_URL")) {
      reachable.push("dev");
    } else {
      missing.push("dev");
    }
    if (
      getSecretSync("RAILWAY_PROD_ENVIRONMENT_ID") &&
      (getSecretSync("RAILWAY_PROD_SERVICE_ID") || getSecretSync("RAILWAY_DEV_SERVICE_ID")) &&
      getSecretSync("RAILWAY_PROD_URL")
    ) {
      reachable.push("prod");
    } else {
      missing.push("prod");
    }
  } else {
    missing.push("dev", "prod");
  }
  const parts: string[] = [];
  parts.push(reachable.length > 0 ? `Currently reachable: ${reachable.join(", ")}.` : "Currently reachable: (none).");
  if (missing.length > 0) parts.push(`Not configured: ${missing.join(", ")}.`);
  return parts.join(" ");
}

function toolMetaToSchema(name: string, meta: ToolMeta): ToolSchema {
  const baseParams: Record<string, any> = meta.parameters || { type: "object" as const, properties: {} };
  const properties = { ...(baseParams.properties || {}), reasoning: { type: "string", description: "One sentence explaining why you are using this tool right now." } };
  const required = Array.from(new Set([...(Array.isArray(baseParams.required) ? baseParams.required : []), "reasoning"]));
  const parameters = { ...baseParams, properties, required };
  let description = meta.description;
  if (name === "railway") {
    description = `${meta.description} ${describeRailwayReachableEnvironments()}`;
  }
  return {
    name,
    description,
    category: normalizeCategory(meta.category),
    parameters,
  };
}

function toolMetaToDefinition(name: string, meta: ToolMeta): ToolDefinition {
  const isBridge = Object.prototype.hasOwnProperty.call(bridgeHandlers, name);
  const schema = toolMetaToSchema(name, meta);
  return {
    ...schema,

    source: isBridge ? "bridge" : "agent",
    usageCount: 0,
    lastUsed: null,
    errors: 0,
    avgDuration: null,
  };
}

async function buildRegistry(): Promise<ToolDefinition[]> {
  const perfStats = getToolStats();
  const perfMap = new Map(perfStats.map(s => [s.name, s]));

  const toolMap = new Map<string, ToolDefinition>();

  for (const [name, meta] of Object.entries(TOOLS)) {
    toolMap.set(name, toolMetaToDefinition(name, meta));
  }

  for (const [name, tool] of Array.from(toolMap.entries())) {
    const perf = perfMap.get(name);
    if (perf) {
      tool.errors = perf.errors;
      tool.avgDuration = perf.avgDuration;
      if (perf.calls > tool.usageCount) {
        tool.usageCount = perf.calls;
      }
    }
  }

  const tools = Array.from(toolMap.values());
  tools.sort((a, b) => b.usageCount - a.usageCount || a.name.localeCompare(b.name));
  return tools;
}

export async function getAllTools(): Promise<ToolDefinition[]> {
  return getToolRegistry();
}

export async function getToolRegistry(): Promise<ToolDefinition[]> {
  const now = Date.now();
  if (cachedRegistry && (now - cachedRegistry.timestamp) < CACHE_TTL) {
    return cachedRegistry.tools;
  }

  log.debug(`getToolRegistry: rebuilding (cache expired or empty)`);
  const tools = await buildRegistry();
  cachedRegistry = { tools, timestamp: now };
  const agentCount = tools.filter(t => t.source === "agent").length;
  const skillCount = tools.filter(t => t.source === "skill").length;
  const bridgeCount = tools.filter(t => t.source === "bridge").length;
  log.debug(`getToolRegistry: total=${tools.length} agent=${agentCount} skill=${skillCount} bridge=${bridgeCount}`);
  return tools;
}

export async function getSkillTools(): Promise<ToolDefinition[]> {
  return (await getToolRegistry()).filter(t => t.source === "skill");
}

export async function getBridgeToolNames(): Promise<Set<string>> {
  return new Set((await getToolRegistry()).filter(t => t.source === "bridge").map(t => t.name));
}

export function invalidateRegistryCache() {
  log.debug(`invalidateRegistryCache`);
  cachedRegistry = null;
}

export interface ToolSchema extends BaseToolDefinition {
  category: string;
}

let cachedSchemas: ToolSchema[] | null = null;

export function invalidateSchemaCache() {
  cachedSchemas = null;
}

export function getToolSchemas(): ToolSchema[] {
  if (cachedSchemas) return cachedSchemas;
  const schemas = Object.entries(TOOLS).map(([name, meta]) => toolMetaToSchema(name, meta));
  // Include alias schemas so validation resolves for canonical tool names
  for (const [alias, target] of Object.entries(TOOL_ALIASES)) {
    const meta = TOOLS[target];
    if (meta) schemas.push(toolMetaToSchema(alias, meta));
  }
  cachedSchemas = schemas;
  log.debug(`getToolSchemas: total=${cachedSchemas.length} (${Object.keys(TOOL_ALIASES).length} aliases)`);
  return cachedSchemas;
}

export async function generateToolsMd(): Promise<string> {
  const tools = await getToolRegistry();

  const agent = tools.filter(t => t.source === "agent");
  const bridge = tools.filter(t => t.source === "bridge");
  const skill = tools.filter(t => t.source === "skill");

  const lines: string[] = [
    "# TOOLS.md — Agent's Tool Inventory",
    "",
    "This file is auto-generated on boot from the unified tool registry (`server/tool-registry.ts`).",
    "",
    "## Agent Tools (built into executor)",
    "",
    "| Tool | Category | Description |",
    "|------|----------|-------------|",
  ];

  for (const t of agent) {
    lines.push(`| \`${t.name}\` | ${t.category} | ${t.description} |`);
  }

  if (bridge.length > 0) {
    lines.push("", "## Bridge Tools (dashboard skills)", "");
    lines.push("These execute locally via `server/bridge-tools.ts` and are available in all contexts (chat, voice, autonomous).", "");
    lines.push("| Tool | Category | Endpoint |");
    lines.push("|------|----------|----------|");
    for (const t of bridge) {
      lines.push(`| \`${t.name}\` | ${t.category} | \`POST /api/agent/tools/${t.name}\` |`);
    }
    lines.push("");
    lines.push("### Tool Details", "");
    for (const t of bridge) {
      lines.push(`**${t.name}** — ${t.description}`);
      if (t.parameters?.properties) {
        const params = Object.entries(t.parameters.properties).map(([k, v]: [string, any]) => `\`${k}\`${v.description ? ` — ${v.description}` : ""}`);
        lines.push(`- Parameters: ${params.join(", ")}`);
        if (t.parameters.required?.length) {
          lines.push(`- Required: ${t.parameters.required.map(r => `\`${r}\``).join(", ")}`);
        }
      }
      lines.push("");
    }
  }

  if (skill.length > 0) {
    lines.push("## Additional Skills", "");
    lines.push("These are agent-editable skills not covered by bridge tools above:", "");
    lines.push("| Tool | Category |");
    lines.push("|------|----------|");
    for (const t of skill) {
      lines.push(`| \`${t.name}\` | ${t.category} |`);
    }
    lines.push("");
  }

  lines.push(
    "## Voice-Only Tools",
    "",
    "These tools are registered with ElevenLabs for voice sessions:",
    "",
    "| Tool | Description |",
    "|------|-------------|",
    "| `rate_day` | Rate the day during EOD check-ins |",
    "",
    "## How It Works",
    "",
    "1. The **tool registry** (`server/tool-registry.ts`) auto-discovers tools from two sources:",
    "   - All tools (local handlers + bridge handlers) are unified in `server/bridge-tools.ts`",
    "   - Tools are dispatched via the DISPATCH_MAP in `server/bridge-tools.ts`",
    "   Skills (LLM instructions) are stored in the PostgreSQL `skills` table — managed via the `skills` bridge tool or the Skills UI.",
    "",
    "2. **Bridge tools** execute locally via `server/bridge-tools.ts` — they call dashboard APIs directly.",
    "",
    "3. **Voice sessions** pull voice-available tools from the registry on session start, merging with template-specific tools.",
    "",
    "4. **Usage tracking** is unified across all invocation paths (chat, voice, UI).",
    "",
    "5. **This file is regenerated on every boot** to stay in sync with the registry.",
    "",
  );

  return lines.join("\n");
}

export async function generateSkillMd(): Promise<string> {
  const dashboardPort = process.env.PORT || "5000";
  const baseUrl = `http://localhost:${dashboardPort}`;
  const tools = await getToolRegistry();
  const bridge = tools.filter(t => t.source === "bridge");

  const lines: string[] = [
    "# Tool Reference — How to Call Agent's Tools",
    "",
    "This file is auto-generated on boot. It shows how to invoke each bridge tool via the agent executor.",
    "",
    "## Calling Bridge Tools",
    "",
    "Bridge tools are available through the agent executor. You can also call them directly via `curl` against the Mantra Dashboard API.",
    "",
    "**Pattern:**",
    "```bash",
    `curl -s -X POST ${baseUrl}/api/agent/tools/TOOL_NAME \\`,
    "  -H 'Content-Type: application/json' \\",
    "  -d '{\"action\": \"...\"}'",
    "```",
    "",
    "Parse the JSON response — the `result` field contains the output. If `\"error\": true`, something went wrong.",
    "",
    "---",
    "",
  ];

  for (const t of bridge) {
    const endpoint = `${baseUrl}/api/agent/tools/${t.name}`;
    const exampleJson = t.parameters?.required?.length
      ? JSON.stringify(Object.fromEntries((t.parameters.required || []).map(r => [r, `YOUR_${r.toUpperCase()}`])))
      : "{}";

    lines.push(`### ${t.name}`);
    lines.push("");
    lines.push(t.description);
    lines.push("");
    lines.push("```bash");
    lines.push(`curl -s -X POST ${endpoint} -H 'Content-Type: application/json' -d '${exampleJson}'`);
    lines.push("```");
    lines.push("");
    if (t.parameters?.properties) {
      const params = Object.entries(t.parameters.properties)
        .map(([k, v]: [string, any]) => {
          const req = t.parameters?.required?.includes(k) ? " **(required)**" : "";
          return `- \`${k}\`${req}: ${v.description || ""}`;
        });
      lines.push(params.join("\n"));
      lines.push("");
    }
    lines.push("---");
    lines.push("");
  }

  lines.push("## Important Reminders");
  lines.push("");
  lines.push("- Use `exec` + `curl` — do NOT try to call bridge tools as native tool_use functions.");
  lines.push("- All endpoints are `POST` with `Content-Type: application/json`.");
  lines.push("- This file is regenerated on every boot to stay in sync with the tool registry.");
  lines.push("");

  return lines.join("\n");
}

function buildExampleJson(toolName: string, params: { type: string; properties: Record<string, unknown>; required?: string[] }): string {
  const examples: Record<string, Record<string, any>> = {
    goals: { action: "list" },
    people: { action: "list" },
    gmail: { action: "recent" },
    create_task: { title: "YOUR_TASK_TITLE" },
    complete_task: { title: "TASK_TITLE_TO_COMPLETE" },
    update_task: { title: "TASK_TITLE", priority: "high" },
    create_issue: { title: "YOUR_ISSUE_TITLE" },
  };

  if (examples[toolName]) return JSON.stringify(examples[toolName]);

  const obj: Record<string, any> = {};
  for (const key of (params.required || [])) {
    const prop = params.properties[key] as Record<string, any> | undefined;
    if (prop?.enum) obj[key] = prop.enum[0];
    else obj[key] = `YOUR_${key.toUpperCase()}`;
  }
  return JSON.stringify(obj);
}

function buildParamDocs(params: { type: string; properties: Record<string, unknown>; required?: string[] }): string {
  const required = new Set(params.required || []);
  const lines: string[] = [];
  for (const [key, val] of Object.entries(params.properties)) {
    const v = val as Record<string, any>;
    const reqLabel = required.has(key) ? " **(required)**" : "";
    const enumList = v.enum ? ` One of: ${v.enum.map((e: string) => `\`${e}\``).join(", ")}` : "";
    lines.push(`- \`${key}\` (${v.type || "string"})${reqLabel}: ${v.description || ""}${enumList}`);
  }
  return lines.join("\n");
}

export async function getSkillDefinitionsForContext(): Promise<string> {
  try {
    const recentSkillIds = await getRecentlyUsedSkillIds(7);

    const allSkills = await _activeSkillsCache.getOrFetch("active", () => storage.getSkills({ status: "active" }));
    const pinnedSkills = allSkills.filter(skill => skill.pinnedToContext);
    const recentSkills = allSkills.filter(skill => recentSkillIds.has(skill.name));

    const mergedMap = new Map<string, typeof allSkills[number]>();
    for (const skill of pinnedSkills) mergedMap.set(skill.id, skill);
    for (const skill of recentSkills) mergedMap.set(skill.id, skill);

    const merged = Array.from(mergedMap.values());

    if (merged.length === 0) return "No skills used in session recently.";

    const lines = merged.map(skill => {
      const tags: string[] = [];
      if (skill.pinnedToContext) tags.push("pinned");
      if (recentSkillIds.has(skill.name)) tags.push("recent");
      const suffix = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
      return `- **${skill.name}**: ${skill.description}${suffix}`;
    });

    return `Skills in context:\n\n${lines.join("\n")}`;
  } catch (err: any) {
    log.error("getSkillDefinitionsForContext failed:", err.message);
    return "Skills unavailable.";
  }
}

async function getRecentlyUsedSkillIds(days: number): Promise<Set<string>> {
  return _recentSkillsCache.getOrFetch(`days:${days}`, async () => {
    try {
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

      const rows = await db
        .select({
          metadata: memoryEntries.metadata,
        })
        .from(memoryEntries)
        .where(
          andOp(
            eqOp(memoryEntries.layer, "workspace"),
            eqOp(memoryEntries.source, "chat"),
            gteOp(memoryEntries.processedAt, new Date(cutoff)),
            sql`${memoryEntries.metadata}->>'sessionKey' LIKE 'auto:%'`,
            sql`${memoryEntries.metadata}->>'parentSessionId' IS NOT NULL`,
            sql`${memoryEntries.metadata}->>'parentSessionId' != ''`,
          )
        );

      const skillIds = new Set<string>();
      for (const row of rows) {
        const meta = row.metadata as Record<string, unknown> | null;
        const sessionKey = meta?.sessionKey as string | undefined;
        if (sessionKey?.startsWith("auto:")) {
          const skillId = sessionKey.slice(5);
          if (skillId) {
            skillIds.add(skillId);
          }
        }
      }

      log.log(`getRecentlyUsedSkillIds: ${skillIds.size} skills used in sessions in last ${days} days: [${[...skillIds].join(", ")}]`);
      return skillIds;
    } catch (err: any) {
      log.warn(`getRecentlyUsedSkillIds failed: ${err.message}`);
      return new Set();
    }
  });
}

