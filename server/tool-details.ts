import {
  RULES_TOOL_DESCRIPTION,
} from "./personal-rule-policy";
import { getShellToolContractDescription } from "./agent-authority";

export interface ToolDetailEntry {
  description: string;
  whenToUse?: string;
  example?: string;
  actions?: Record<string, { description: string; requiredParams?: string[]; optionalParams?: string[] }>;
}

export const TOOL_DETAILS: Record<string, ToolDetailEntry> = {
  scratch: {
    description: "Manage temporary workspace files (SCRATCH). These files are NOT available in production — use the `files` tool for persistent storage. Actions: read, write, edit, list, search. Every call requires `reasoning` (one sentence explaining why you are using this tool right now).",
    whenToUse: "When working with temporary files during a session — drafts, analysis, code experiments. For permanent files the user should be able to download or access in production, use the `files` tool instead.",
    example: 'Read a file: { "action": "read", "path": "notes.md", "reasoning": "Inspect the draft before editing." }\nWrite a file: { "action": "write", "path": "draft.md", "content": "...", "reasoning": "Persist intermediate analysis in scratch." }\nEdit a file: { "action": "edit", "path": "draft.md", "old_string": "old text", "new_string": "new text", "reasoning": "Apply the targeted fix after reading the file." }',
    actions: {
      read: { description: "Read file from scratch workspace. Supports offset/limit for large files.", requiredParams: ["path", "reasoning"], optionalParams: ["offset", "limit"] },
      write: { description: "Write file to scratch workspace. Creates parent directories as needed.", requiredParams: ["path", "content", "reasoning"] },
      edit: { description: "Find and replace text in a scratch file. Use replace_all for multiple occurrences.", requiredParams: ["path", "old_string", "new_string", "reasoning"], optionalParams: ["replace_all"] },
      list: { description: "List files and directories in the scratch workspace.", requiredParams: ["reasoning"], optionalParams: ["path"] },
      search: { description: "Search for files by glob pattern in the scratch workspace.", requiredParams: ["pattern", "reasoning"], optionalParams: ["limit"] },
    },
  },
  files: {
    description: "Manage PERSISTENT object-storage files and read vault-bound external drive resources through filesApi. Object storage: write/read/list. Bound drive: listBound/listChildren/getMetadata/authorize, plus read with driveResourceId or provider+providerFileId. Never call Google/Box directly.",
    whenToUse: "When saving files the user should download or that must persist across deployments, or when reading vault-bound Drive/Box/Mantra resources. For temporary scratch work, use the `scratch` tool instead.",
    example: 'Save: { "action": "write", "fileName": "report.md", "content": "..." }\nObject read: { "action": "read", "filePath": "/objects/uploads/abc123.md" }\nBound roots: { "action": "listBound", "vaultId": "..." }\nBound read: { "action": "read", "driveResourceId": "..." }',
    actions: {
      write: { description: "Save a file permanently to object storage. Returns a download link you MUST include in your response.", requiredParams: ["fileName", "content"], optionalParams: ["contentType"] },
      read: { description: "Read object storage by filePath, or a bound drive file via driveResourceId / provider+providerFileId (filesApi).", optionalParams: ["filePath", "vaultId", "driveResourceId", "provider", "providerFileId"] },
      list: { description: "List all persistent files stored in object storage.", optionalParams: ["prefix"] },
      listBound: { description: "List vault-bound drive resources (no ambient provider crawl).", requiredParams: ["vaultId"] },
      listChildren: { description: "List children of a bound folder via filesApi.", optionalParams: ["vaultId", "driveResourceId", "provider", "providerFileId", "pageToken"] },
      getMetadata: { description: "Get metadata for a bound drive file/folder via filesApi.", optionalParams: ["vaultId", "driveResourceId", "provider", "providerFileId"] },
      authorize: { description: "Authorize the current principal for a bound drive_resource via filesApi.", optionalParams: ["vaultId", "driveResourceId", "provider", "providerFileId"] },
    },
  },
  web: {
    description: "Search the web, fetch URLs, or run one authenticated interactive page test. test/screenshot: navigate, click, tap, scroll, press, type, screenshot on one Chromium session; closing frame always persists. Auth is browser-session integration capability (day-one automation-auth) or local principal cookie.",
    whenToUse: "When looking something up online, reading a page, or proving an authenticated product path with act-then-evidence (Smoke click-paths). Prefer test over inventing a second browser tool. ui stays guide-only.",
    example: 'Search: { "action": "search", "query": "latest AI news" }\nFetch: { "action": "fetch", "url": "https://example.com" }\nLocal photo: { "action": "test", "route": "/home", "viewport": "mobile" }\nTap path: { "action": "test", "route": "/home", "viewport": "mobile", "steps": [{ "kind": "tap", "selector": "[data-tool-id=\\"memory\\"]" }, { "kind": "screenshot" }] }\nExternal auth: { "action": "test", "url": "https://stage.example", "auth": { "integration": "automation-auth" }, "steps": [{ "kind": "click", "selector": "button.primary" }] }',
    actions: {
      search: { description: "Search the web using Brave Search API.", requiredParams: ["query"], optionalParams: ["count"] },
      fetch: { description: "Fetch and extract text content from a URL. Large pages are automatically summarized.", requiredParams: ["url"], optionalParams: ["timeout"] },
      test: {
        description: "One authenticated Chromium session. Entry via route (localhost) or url. Optional closed steps (max 8): navigate, click, tap, scroll, press, type, screenshot. Origin re-checked after every step. Closing screenshot always taken when a page exists. auth.integration must carry browser-session (day-one: automation-auth). Omitted auth on local app uses calling principal cookie; external without auth is photograph-only.",
        optionalParams: ["route", "url", "viewport", "fullPage", "delay", "auth", "steps"],
      },
      screenshot: { description: "Deprecated alias for test.", optionalParams: ["route", "url", "viewport", "fullPage", "delay", "auth", "steps"] },
    },
  },
  memory: {
    description: "Unified memory system — read/write knowledge files, search vNEXT claims with structured filters, manage graph links/sources, batch retrieve, count, run vNext maintenance ops. Actions: read, write, read_entry, search, get, get_many, count, link_entity, get_entity_links, list_sources, add_source, delete_source, search_claims, vnext_claim_counts, vnext_claim_detail, run_vnext_lifecycle, run_full_sleep_cycle, compute_gsi, run_rem. Retired legacy memory_entries actions return migration guidance if called.",
    whenToUse: "When you need to read or update workspace knowledge files, search past conversations, retrieve specific memory entries, manage claim sources/entity links, count entries, or run memory maintenance operations.",
    example: 'Read: { "action": "read", "file": "PRINCIPLES.md" }\nSearch: { "action": "search", "query": "what did we discuss about product launch?" }\nCount: { "action": "count" }\nGet claim: { "action": "get", "id": 42 }\nSearch claims: { "action": "search_claims", "query": "funding" }',
    actions: {
      read: { description: "Read workspace knowledge files (PRINCIPLES.md, etc.).", requiredParams: ["file"] },
      write: { description: "Update workspace knowledge files. Use append:true to add to existing content.", requiredParams: ["file", "content"], optionalParams: ["append"] },
      read_entry: { description: "Read the full content of a specific memory entry by its numeric ID. Use after search to get complete details.", requiredParams: ["id"] },
      search: { description: "Search across all memory with optional structured filters. Use query='*' with filters to bypass semantic search. Returns enriched metadata including linkCount, recallCount, recalledAt, contentLength, deletionScheduled, deletionReason.", requiredParams: ["query"], optionalParams: ["source", "layer", "limit", "startDate", "endDate", "minLinks", "maxLinks", "minContentLength", "maxContentLength", "recalledBefore", "recalledAfter", "minRecallCount", "maxRecallCount", "hasTitle", "hasSummary", "hasDeletionScheduled", "deletionExpired", "createdBefore", "createdAfter", "updatedBefore", "updatedAfter", "sortBy", "sortOrder", "offset"] },
      create_link: { description: "Link two memory entries with a typed relationship.", requiredParams: ["fromId", "toId", "relationship"], optionalParams: ["strength"] },
      update_entry: { description: "Update the content or layer of a memory entry. Can also set deletionScheduled/deletionReason in metadata for soft-delete.", requiredParams: ["id"], optionalParams: ["content", "layer", "metadata"] },
      delete_entry: { description: "Delete a memory entry permanently. First call without confirm to preview (shows entry summary, link counts, warning). Then call with confirm:true and reason to execute. Only one entry per call.", requiredParams: ["id"], optionalParams: ["confirm", "reason"] },
      get: { description: "Get a memory entry by ID with full details.", requiredParams: ["id"] },
      get_many: { description: "Batch retrieve full entries by IDs in one call. Max 100 IDs.", requiredParams: ["ids"] },
      find_duplicates: { description: "Find clusters of likely duplicate entries using content hash (exact match) and embedding similarity (near-duplicates ≥0.85). Edges are merged transitively, so a chain A↔B↔C returns one cluster of 3 — not multiple pairs. Returns clusters with min-edge similarity scores, exact-match flag (true only if every edge is an exact hash match), and recommended actions. The `limit` applies to clusters, not edges.", optionalParams: ["layer", "source", "createdAfter", "createdBefore", "limit"] },
      count: { description: "Count memory entries matching optional filters. Returns total, breakdown by layer, and graphed/ungraphed split. Much cheaper than paging through search results to determine size.", optionalParams: ["layer", "source", "createdAfter", "createdBefore"] },
      bulk_delete: { description: "Delete many entries in a single call. First call without confirm to preview (shows requested/found counts and a sample). Then call with confirm:true and reason to execute. All entries are deleted in one pass and affected peer neighborhoods are recomputed once at the end. Max 500 IDs per call.", requiredParams: ["ids"], optionalParams: ["confirm", "reason"] },
      consolidate_short: { description: "RETIRED — legacy short-to-mid propagation is disabled; returns a migration error." },
      integrate_mid_to_long: { description: "RETIRED — legacy mid-to-long propagation is disabled; returns a migration error." },
      run_myelination: { description: "RETIRED — legacy myelination is disabled; returns a migration error." },
      run_memory_decay: { description: "RETIRED — legacy memory decay is disabled; returns a migration error." },
      run_memory_reinforcement: { description: "RETIRED — legacy memory reinforcement is disabled; returns a migration error." },
      run_nrem: { description: "RETIRED — legacy NREM maintenance is disabled; returns a migration error." },
      run_full_sleep_cycle: { description: "Run the vNext sleep cycle: existing claim lifecycle (advancement, decay, retirement, bridges), REM dream generation over vNext claims and recent sessions, and optional GSI. Returns the dream narrative for Library filing.", optionalParams: ["includeGSI"] },
      compute_gsi: { description: "Compute the Graph Structure Index over vNext claims: connectivity, link quality, orphan rate, cluster balance, and confidence-distribution health." },
      run_rem: { description: "Run the REM dream phase only: seeds from random active user-owned vNext claims and recent sessions; returns title, insight, and narrative without changing claim state." },
      list_sources: { description: "Query vNext memory_sources (source refs). Returns provenance links between memories and their sources (memory, library, session, chat_journal, etc.). Filter by memoryId, sourceType, sourceId, or relationship.", optionalParams: ["memoryId", "sourceType", "sourceId", "relationship", "limit"] },
      add_source: { description: "Create a vNext source ref linking a memory entry to its source. Upserts on (memoryId, sourceType, sourceId, relationship).", requiredParams: ["memoryId", "sourceType", "sourceId"], optionalParams: ["relationship", "context", "quote", "strength"] },
      delete_source: { description: "Delete a source ref by its ID.", requiredParams: ["sourceRefId"] },
      search_claims: { description: "Search vNEXT claims from memory_vnext_claims only. Filter by claimType (state/cause/action), entity links, lifecycle stage, dates, and storage.", optionalParams: ["claimType", "hasEntityLinks", "entityId", "createdAfter", "createdBefore", "lifecycleStage", "storage", "limit", "offset"] },
      vnext_claim_counts: { description: "Return vNext claim observability counts from memory_vnext_claims plus source/entity/claim-link counts.", optionalParams: [] },
      vnext_claim_detail: { description: "Inspect one vNext claim with source refs, entity links, claim links, and lifecycle status without reading legacy memory_entries.", requiredParams: ["id"] },
      run_vnext_lifecycle: { description: "Manually run the vNext-only claim lifecycle worker. Advances extracted/sourced/linked claims, emits candidate/skip/link/canonical/retirement logs, and returns run counts without using legacy integration stages.", optionalParams: ["limit"] },
    },
  },
  settings: {
    description: "Persist and retrieve key-value settings for skills and system configuration. Actions: get, set, delete.",
    whenToUse: "When a skill needs to persist state across runs (e.g., run counters, timestamps, configuration). Keys are namespace-scoped — must start with memory.*, system.*, skill.*, or hygiene.*.",
    example: 'Get: { "action": "get", "key": "memory.hygiene.runCount" }\nSet: { "action": "set", "key": "memory.hygiene.runCount", "value": 5 }',
    actions: {
      get: { description: "Read a setting value by key. Returns null if not set.", requiredParams: ["key"] },
      set: { description: "Write a setting value. Key must start with an allowed prefix.", requiredParams: ["key", "value"] },
      delete: { description: "Delete a setting by key.", requiredParams: ["key"] },
    },
  },
  code: {
    description: "Query and navigate the selected Platform codebase knowledge graph — search by concept, inspect symbols, analyze impact, trace execution flows, and run Cypher queries. Actions: query, context, impact, changes, architecture, modules, flows, rename, schema, cypher.",
    whenToUse: "When you need to understand, navigate, or modify the selected Platform codebase. Use query to find implementations, context to understand how a symbol fits, impact to assess change blast radius, and architecture for a high-level overview.",
    example: 'Search: { "action": "query", "query": "authentication middleware" }\nSymbol context: { "action": "context", "name": "executeTool" }\nImpact: { "action": "impact", "target": "executeTool", "direction": "upstream" }',
    actions: {
      query: { description: "Search the codebase knowledge graph by concept or execution flow. Returns matched processes, clusters, and symbols using BM25 + graph traversal.", requiredParams: ["query"], optionalParams: ["goal", "task_context", "limit", "max_symbols", "include_content"] },
      context: { description: "Get a 360° view of a symbol — callers, callees, imports, exports, process participation, community membership. Handles disambiguation for common names.", optionalParams: ["name", "uid", "file", "include_content"] },
      impact: { description: "Analyze the blast radius of a symbol change. Returns depth-grouped affected symbols with confidence scores. d=1 WILL BREAK, d=2 LIKELY AFFECTED, d=3 MAY NEED TESTING.", requiredParams: ["target", "direction"], optionalParams: ["maxDepth", "includeTests", "minConfidence"] },
      changes: { description: "Map current uncommitted git changes to affected execution flows and processes." },
      architecture: { description: "Get a high-level architectural overview: all functional modules, execution flows, and project stats." },
      modules: { description: "List all functional modules (Leiden clusters), or drill into a specific module to see its members.", optionalParams: ["name"] },
      flows: { description: "List all detected execution flows, or drill into a specific flow to see its step-by-step trace.", optionalParams: ["name"] },
      rename: { description: "Multi-file coordinated rename using knowledge graph + text search. Preview by default (dry_run=true).", requiredParams: ["new_name"], optionalParams: ["symbol_name", "symbol_uid", "file_path", "dry_run"] },
      schema: { description: "Get the full graph schema — node types, relationship types, properties, and example Cypher queries." },
      cypher: { description: "Execute a raw Cypher query against the codebase knowledge graph (read-only).", requiredParams: ["query"] },
    },
  },
  docx: {
    description: "Read uploaded or workspace Word documents (.docx), and write, edit, or clone documents in the scratch workspace. Actions: read, write, edit, clone.",
    whenToUse: "When working with Word documents, including uploaded chat attachments. Read uploaded attachments directly from the exact /objects/uploads/<id>.docx path in attachment metadata.",
    example: 'Read upload: { "action": "read", "path": "/objects/uploads/<id>.docx" }\nRead workspace file: { "action": "read", "path": "report.docx" }\nWrite: { "action": "write", "path": "output.docx", "content": "# Title\\nContent..." }\nEdit: { "action": "edit", "path": "report.docx", "replacements": [{"find": "old", "replace": "new"}] }',
    actions: {
      read: { description: "Read a workspace .docx file or an uploaded attachment at its exact /objects/uploads/<id>.docx path. Modes: text (plain text, default), rich (structured with metadata), annotated (inline markdown with comments/changes).", requiredParams: ["path"], optionalParams: ["mode"] },
      write: { description: "Create a .docx from plain text or markdown. Lines starting with # become Word headings.", requiredParams: ["path", "content"] },
      edit: { description: "Find and replace text in a .docx while preserving all original formatting, styles, headers, footers, and images.", requiredParams: ["path", "replacements"], optionalParams: ["output_path"] },
      clone: { description: "Create a new .docx using a source document as a style template — preserves styles, fonts, page layout while replacing body content.", requiredParams: ["source_path", "output_path", "content"] },
    },
  },
  tasks: {
    description: "Create, complete, delete, and update tasks. Actions: create, complete, delete, update.",
    whenToUse: "When the user mentions something that needs to be done, wants to mark a task as done, delete a task, or change task properties like priority/status/owner.",
    example: 'Create: { "action": "create", "title": "Review proposal", "description": "Read through and provide feedback", "milestoneId": 1 }\nComplete: { "action": "complete", "title": "Review proposal" }\nUpdate: { "action": "update", "title": "Review proposal", "priority": "high" }',
    actions: {
      create: { description: "Create a new task. milestoneId is required; if the right milestone is unclear, ask Ray where it belongs before creating. The tool automatically appends the current source session as @session:id when available. Supports deadline (YYYY-MM-DD). Owner is a Person via ownerPersonId.", requiredParams: ["title", "description", "milestoneId"], optionalParams: ["status", "priority", "impact", "effort", "ownerPersonId", "requiresReview", "projectId", "milestoneId", "deadline"] },
      complete: { description: "Mark a task as done. This is the ONLY way to complete tasks.", optionalParams: ["taskId", "title"] },
      delete: { description: "Permanently delete a task.", optionalParams: ["taskId", "title"] },
      update: { description: "Update a task's properties. Project and milestone placement may be retained or moved, but never cleared; any move must resolve to a milestone belonging to the selected project. Owner is a Person via ownerPersonId.", optionalParams: ["taskId", "title", "newTitle", "description", "priority", "status", "impact", "effort", "ownerPersonId", "requiresReview", "projectId", "milestoneId", "deadline"] },
    },
  },
  finance: {
    description: "Access financial data from connected bank accounts — summaries, transactions, holdings, liabilities, categories, budgets, income, recurring items, forecasts, and financial goals. Actions: summary, transactions, holdings, liabilities, debt_payments, categories, budget, income, recurring, forecast, goals, link_account, refresh.",
    whenToUse: "When the user asks about their finances, spending, investments, debt, budget, income, subscriptions, forecasts, financial goals/targets, savings targets, or wants to connect a new bank account.",
    example: 'Summary: { "action": "summary" }\nTransactions: { "action": "transactions", "category": "FOOD_AND_DRINK", "startDate": "2026-03-01" }\nBudget: { "action": "budget", "mode": "this_month" }\nBudget for specific month: { "action": "budget", "month": "2026-01" }\nIncome: { "action": "income" }\nForecast: { "action": "forecast", "months": 24 }\nGoals: { "action": "goals" }\nCreate goal: { "action": "goals", "goal_action": "create", "name": "Emergency Fund", "targetAmount": 30000, "category": "Emergency Fund", "targetDate": "2026-12-31" }\nUpdate goal: { "action": "goals", "goal_action": "update", "id": 1, "targetAmount": 35000 }',
    actions: {
      summary: { description: "Get comprehensive financial summary — net worth, savings rate, spending by category, investment allocation." },
      transactions: { description: "Query transactions with optional date range, category, and account filters.", optionalParams: ["startDate", "endDate", "category", "accountId", "limit"] },
      holdings: { description: "Get current investment holdings across all connected accounts." },
      liabilities: { description: "Get all liabilities — credit card balances, loans, interest rates, payment schedules." },
      debt_payments: { description: "Get recent debt payments and per-liability payment summaries." },
      categories: { description: "List all expense categories and merchant category overrides." },
      budget: { description: "Get budget vs actual spending comparison. Supports this_month, last_month, or trailing_avg (12-month average) modes. Use month param (YYYY-MM) to query a specific month.", optionalParams: ["mode", "month"] },
      income: { description: "Get income source breakdown — gross pay, deductions (taxes, 401k, insurance), take-home, and deposit allocations." },
      recurring: { description: "Get identified recurring transactions — subscriptions, bills, recurring income." },
      forecast: { description: "Get projected finances for N months — net worth, investments, cash flow, and liability paydown at milestone intervals.", optionalParams: ["months"] },
      goals: { description: "Manage financial goals/targets with dollar amounts, timelines, and linked accounts. Use goal_action param: list (default), create, update, delete. Goals linked to Plaid accounts auto-compute current balances. Categories: Emergency Fund, Financial Freedom, Savings, Debt Payoff, Custom.", optionalParams: ["goal_action", "name", "targetAmount", "currentAmount", "category", "targetDate", "notes", "linkedAccountIds", "id"] },
      link_account: { description: "Generate a Plaid Link token to connect a new bank account." },
      refresh: { description: "Trigger an on-demand refresh of all financial data from connected accounts." },
    },
  },
  goals: {
    description: "Manage life goals — unified system covering all horizons from daily goals to lifetime aspirations. Horizons: today, this_week, this_month, this_quarter, this_year, three_year, ten_year, lifetime. Short horizons (today/this_week/this_month) support period-specific fields for date-scoped queries. This is the canonical tool for all goal and priority operations. Actions: list, get, create, update, delete, search, set_parent, unlink_parent, set_review, set_daily_plan, get_daily_artifacts, set_weekly/monthly/quarterly plan+reflection.",
    whenToUse: "User mentions goals, priorities, aspirations, objectives, daily/weekly/monthly targets, or long-term plans.",
    example: 'List today\'s goals: { "action": "list", "filters": { "horizon": "today" } }\nList this year: { "action": "list", "filters": { "horizon": "this_year" } }\nLink weekly plan: { "action": "set_weekly_plan", "week": "2026-07-06", "libraryPageId": "page-uuid" }',
    actions: {
      list: { description: "List all goals, optionally filtered by domain/horizon.", optionalParams: ["filters"] },
      get: { description: "Get full details of a specific goal.", requiredParams: ["id"] },
      create: { description: "Create a new goal. For short horizons, include periodDate (YYYY-MM-DD).", requiredParams: ["shortName"], optionalParams: ["description", "domain", "horizon", "status", "periodDate", "periodWeek", "periodMonth"] },
      update: { description: "Update a goal's properties.", requiredParams: ["id"], optionalParams: ["shortName", "description", "domain", "horizon", "status"] },
      delete: { description: "Delete a goal.", requiredParams: ["id"] },
      search: { description: "Search goals by term.", requiredParams: ["query"] },
      set_parent: { description: "Assign a parent goal.", requiredParams: ["id", "parentId"] },
      unlink_parent: { description: "Remove a goal's parent link.", requiredParams: ["id"] },
      set_review: { description: "Link a Library page as the daily review artifact for a check-in.", requiredParams: ["libraryPageId"], optionalParams: ["date"] },
      set_daily_plan: { description: "Link a Library page as the daily plan artifact.", requiredParams: ["libraryPageId"], optionalParams: ["date"] },
      get_daily_artifacts: { description: "Get daily brief, review, and plan Library page links for a date.", optionalParams: ["date"] },
      set_weekly_reflection: { description: "Link a Library page as the weekly reflection artifact.", requiredParams: ["libraryPageId"], optionalParams: ["week"] },
      set_weekly_plan: { description: "Link a Library page as the weekly plan artifact.", requiredParams: ["libraryPageId"], optionalParams: ["week"] },
      set_monthly_reflection: { description: "Link a Library page as the monthly reflection artifact.", requiredParams: ["libraryPageId"], optionalParams: ["month"] },
      set_monthly_plan: { description: "Link a Library page as the monthly plan artifact.", requiredParams: ["libraryPageId"], optionalParams: ["month"] },
      set_quarterly_reflection: { description: "Link a Library page as the quarterly reflection artifact.", requiredParams: ["libraryPageId"], optionalParams: ["quarter"] },
      set_quarterly_plan: { description: "Link a Library page as the quarterly plan artifact.", requiredParams: ["libraryPageId"], optionalParams: ["quarter"] },
    },
  },
  people: {
    description: "Manage personal contacts — search, list, get details, check outreach agenda, add notes, log interactions, and read or change Person Vault memberships. Vault actions: get_vault_memberships, add_vault_membership, remove_vault_membership, and set_vault_memberships. Full replacement requires a non-empty vaultIds array plus confirmReplace=true.",
    whenToUse: "User mentions a person, wants to look up contact details, log an interaction, manage their relationship network, or assign profiles to Vaults.",
    example: 'Search: { "action": "search", "query": "Sarah" }\nAdd Vault: { "action": "add_vault_membership", "id": "person-id", "vaultId": "vault-id" }\nReplace Vaults: { "action": "set_vault_memberships", "id": "person-id", "vaultIds": ["vault-id"], "confirmReplace": true }',
  },
  work: {
    description: "Manage projects and work status. Project detail returns metadata, milestones, task counts by status, and a small actionable slice; list_tasks returns an explicit bounded page with total and continuation. Actions: create_project, status, list_projects, get_project, list_tasks, set_goal, add_file, read_file, remove_file, add_milestone, update_milestone, remove_milestone.",
    whenToUse: "User asks about projects, work status, or wants to manage project-level resources. Use list_tasks with taskStatus, limit, and offset to inspect larger task sets. For individual task operations, use the `tasks` tool instead.",
    example: 'List projects: { "action": "list_projects" }\nGet project overview: { "action": "get_project", "id": 1 }\nPage active tasks: { "action": "list_tasks", "id": 1, "taskStatus": "active", "limit": 25, "offset": 0 }',
  },
  gmail: {
    description: "Read, search, and draft emails via Gmail. Supports multiple accounts. Actions: status, search, read, batch_read, draft, update_draft, recent, download_attachment, triage_log, email_cache. update_draft uses one explicit body operation: findReplace for exact edits, rangePatch with expectedBodyHash for guarded offsets, or replaceBody for intentional whole-body rewrites. There is no tool-level send action.",
    whenToUse: "User asks about email, wants to check inbox, search for messages, or create an email for review/send. When creating an email intended for Ray to review or send, use gmail.draft or gmail.update_draft so the inline draft widget appears. Prefer findReplace for local feedback, rangePatch only when you have the current body hash, and replaceBody only for deliberate rewrites. Plain chat email text is only for brainstorming or explicit copy-only requests.",
    example: 'Search: { "action": "search", "query": "from:sarah", "account": "Work" }\nDraft: { "action": "draft", "to": "sarah@example.com", "subject": "Following up", "body": "..." }',
  },
  git: {
    description: "Interact with Git repositories — clone, pull, browse history, diff, branch, checkout, show, and write changes (add, commit, push, create_pr, merge_pr, delete_branch). Bare clone resolves the canonical Mantra / Web / stage source binding; clone + platformEnvironmentId or clone_from_environment targets one Platform Environment. Omit directory to use this session's sole clone; if multiple clones exist, choose the directory returned by clone. Use pr_number with checkout for pull requests. Write actions never target the workspace root.",
    whenToUse: "User mentions a git repository, wants to pull code, clone a project, review commit history, work with branches, check out a pull request, commit changes, push code, open a pull request, merge PRs, or delete remote branches.",
    example: 'Clone stage: { "action": "clone" }\nClone environment: { "action": "clone", "platformEnvironmentId": 12 }\nCheckout PR: { "action": "checkout", "pr_number": 123 }\nCommit in sole session clone: { "action": "commit", "message": "fix: improve error handling" }\nCreate PR: { "action": "create_pr", "title": "Fix error handling", "body": "Improved error messages" }',
  },
  scenarios: {
    description: "Scenario modeling — create scenarios, manage actors, build move trees, run simulations, manage assumptions, track notes and artifacts. Actions: list_scenarios, get_scenario, create_scenario, and many more.",
    whenToUse: "User wants to model a strategic scenario, negotiate, run simulations, analyze moves, or work with scenario artifacts.",
    example: 'List scenarios: { "action": "list_scenarios" }',
  },
  decisions: {
    description: "Personal decision log — track open/closed strategic decisions with Data, Scenarios, and Plan sections, traffic-light status (closed only), append-only updates after lock, and links to strategies/projects. Actions: list, get, create, update, delete, lock, reopen, add_update, edit_update, delete_update, add_link, remove_link.",
    whenToUse: "When the user wants to record a decision they're weighing, capture data/scenarios/plan, lock it once made, log post-decision updates, set its traffic-light status, or link it to a strategy or project.",
    example: 'Create: { "action": "create", "title": "Hire designer", "description": "Should we bring on a senior designer in Q2?", "dataContent": "Budget $5k/mo", "scenariosContent": "Option A...", "planContent": "Next steps" }\nLock: { "action": "lock", "id": "..." }\nSet traffic light: { "action": "update", "id": "...", "trafficLight": "yellow" }',
  },
  rules: {
    description: RULES_TOOL_DESCRIPTION,
    whenToUse: "When the user explicitly establishes a durable, deterministic personal behavioral override that has no stronger structural home.",
    example: '{ "action": "save", "rule": "In my strategic communications, never use the phrase no pressure" }',
  },
  intentions: {
    description: "DEPRECATED — Intentions system removed. Use the 'autonomy' skill for autonomous work.",
    whenToUse: "Do not use — this tool returns a deprecation notice. Use skills tool with the autonomy skill instead.",
    example: '{ "action": "list" }',
  },
  router: {
    description: "Call and inspect the production model routing layer. Inference lists are bounded and expose run/session correlation; detail returns compact metadata plus a canonical inference-context reference rather than replaying provider payloads. Actions: eval, list_inference_calls, get_inference_call.",
    whenToUse: "When Agent needs to test prompt compositions through the real persona/connector routing system or inspect principal-scoped audited inference calls. Filter by exact runId or sessionId before attributing a call.",
    example: '{ "action": "list_inference_calls", "sessionId": "session-id", "limit": 50 }',
  },
  skills: {
    description: "Manage Agent's skill library — reusable instruction sets. Actions: list, get, create, update, edit, delete, search. Use edit for surgical find/replace within a single field (default 'process') instead of resending the whole field via update.",
    whenToUse: "When Agent needs to create, review, or modify its own reusable skills.",
    example: '{ "action": "create", "name": "my-analysis", "process": "...", "description": "Custom analysis" }',
  },
  shell: {
    description: getShellToolContractDescription(),
    whenToUse:
      "Read-only inspection already covered by the allowlist: list files, grep/rg/which search, head/tail/cat known paths, piped sed -n line ranges, npm run build, and shell git status/log/diff/show/branch/remote/rev-parse/grep. Prefer scratch.read when the path is known. Never invent a command outside the allowlist and never retry a denied command with cosmetic variants. Shell cwd is always the workspace root even when instruction context loads from a repos clone.",
    example:
      '{ "command": "ls repos/" }\n{ "command": "which rg" }\n{ "command": "rg -n \\"validateShellCommand\\" server --type ts" }\n{ "command": "pwd; ls; git -C repos/mono-abc123 status" }\n{ "command": "git -C repos/mono-abc123 grep -n validateShellCommand -- server" }\n{ "command": "git -C repos/mono-abc123 show HEAD:server/agent-authority.ts | sed -n \'270,310p\'" }\n{ "command": "npm run build" }\nDenied patterns (do not call): file redirects (2>/dev/null is allowed), git write subcommands, non-build npm, command substitution, variable expansion, absolute paths outside /app and fixed system binary dirs.',
  },
  notion: {
    description: "Search, read, and browse Notion pages and databases. Actions: status, search, get_page, get_content, list_databases, query_database.",
    whenToUse: "User asks about their Notion, mentions notes, wikis, or documents stored in Notion.",
    example: '{ "action": "search", "query": "meeting notes" }',
  },
  system: {
    description: "System operations — inspect runtime health and, only inside the canonical history-rollup Skill, read deterministic continuity candidates and persist validated summaries.",
    whenToUse: "When needing a high-level view of system health, creating issue reports, inspecting runtime logs, or reading the same frontend or context-health summaries shown on the Performance page.",
    example: 'State: { "action": "state" }\nLogs: { "action": "logs", "level": "error", "limit": 50 }\nFrontend: { "action": "frontend_performance", "hours": 24 }\nContext: { "action": "context_health", "hours": 24 }',
    actions: {
      state: { description: "Get a comprehensive snapshot of system state — memory counts, skill count, capabilities health, and more." },
      logs: { description: "Retrieve recent runtime logs. Filter by level (debug/info/warn/error) and source module.", optionalParams: ["limit", "level", "source"] },
      frontend_performance: { description: "Read the canonical browser telemetry summary used by the Performance page Frontend section.", optionalParams: ["hours"] },
      context_health: { description: "Read the system-wide canonical api_calls context-health summary used by the Performance page Context section.", optionalParams: ["hours"] },
      list_history_rollup_candidates: { description: "History-rollup Skill only: return the next deterministic closed-bucket source window in dependency order." },
      save_history_rollup: { description: "History-rollup Skill only: validate exact candidate provenance and persist the Skill-authored immutable summary.", requiredParams: ["vaultId", "rollupLevel", "timezone", "bucketStart", "sourceEntryIds", "summary"] },
    },
  },
  issues: {
    description: "Track product Issues — create, page unresolved tracked Issues, page the admin Reported queue, fetch one by ID, or resolve one with affirmative evidence. Part of the Build product area. Actions: create, list, list_reported, get, resolve.",
    whenToUse: "When creating a bug or improvement issue, paging unresolved tracked issues, paging the admin Reported queue, fetching an existing issue by numeric ID, or resolving one with affirmative evidence.",
    example: 'Create: { "action": "create", "title": "Login bug", "description": "..." }\nList: { "action": "list", "status": "open" }\nReported: { "action": "list_reported" }\nGet: { "action": "get", "id": "123" }\nResolve: { "action": "resolve", "id": "123", "evidence": "Reproduced in stage; fix confirmed via @pr:repo/456 merge and a passing screenshot." }',
    actions: {
      create: { description: "Create a new issue to track a bug or improvement.", requiredParams: ["title"], optionalParams: ["description"] },
      list: { description: "Page unresolved (or filtered) tracked Issues. Never includes kind=reported.", optionalParams: ["status", "excludeStatus", "offset", "limit"] },
      list_reported: { description: "Page the admin Reported queue. Requires system:read and returns only kind=reported Issues.", optionalParams: ["status", "excludeStatus", "offset", "limit"] },
      get: { description: "Fetch a single issue by numeric ID.", requiredParams: ["id"] },
      resolve: { description: "Resolve an issue with a concise affirmative evidence note (1-2000 characters).", requiredParams: ["id", "evidence"] },
    },
  },
  meetings: {
    description: "Manage calendar events and query the canonical completed meeting index, including transcript-note counts, participants, and linked Library artifacts.",
    whenToUse: "Use calendar actions to schedule, check, reschedule, or classify events. Use records/count/get when the user asks about meetings Mantra attended, took notes for, recapped, or linked to People and Pages.",
    example: 'Add: { "action": "add", "summary": "Meeting with Sarah", "start": "2026-02-23T14:00:00-06:00" }\nList: { "action": "list" }\nSet metadata: { "action": "set_metadata", "googleEventId": "...", "accountId": "...", "calendarId": "primary", "eventType": "focus_block", "attendeeEmails": ["sarah@example.com"] }\nGet metadata: { "action": "get_metadata", "googleEventId": "...", "accountId": "...", "calendarId": "primary" }',
    actions: {
      add: { description: "Create a new calendar event.", requiredParams: ["summary", "start"], optionalParams: ["end", "description", "location", "attendees", "accountId", "calendarId"] },
      list: { description: "List upcoming calendar events. Shows event type badges and linked task names inline.", optionalParams: ["from", "to", "limit"] },
      update: { description: "Update an existing calendar event.", requiredParams: ["eventId"], optionalParams: ["summary", "start", "end", "description", "location", "attendees", "accountId", "calendarId"] },
      delete: { description: "Delete/cancel a calendar event.", requiredParams: ["eventId"], optionalParams: ["accountId", "calendarId"] },
      set_metadata: { description: "Classify a calendar event, link People from attendee emails, and set its private agenda as a Library page. Event types: focus_block, exercise, meeting, planning, admin, personal.", requiredParams: ["googleEventId", "accountId", "calendarId", "eventType"], optionalParams: ["notes", "agendaLibraryPageId", "attendeeEmails", "sharedRoom", "sharedAudioAttendeeEmail"] },
      get_metadata: { description: "Get full metadata for a calendar event including linked tasks, people, and artifacts.", requiredParams: ["googleEventId", "accountId", "calendarId"] },
      link_artifact: { description: "Link an explicit non-preparation Library artifact to a meeting. Use set_metadata with agendaLibraryPageId for preparation. Legacy agenda/brief calls may only claim or resolve the same canonical page and never replace it.", requiredParams: ["metadataId", "libraryPageId", "artifactKind"], optionalParams: ["title", "source"] },
      unlink_artifact: { description: "Remove a Library artifact link from a calendar event by link record ID.", requiredParams: ["linkId"] },
      records: { description: "List completed meeting sessions from the canonical meeting index with participants, note evidence, and linked pages. Searches all meetings unless notesFilter is explicitly with_notes or without_notes.", optionalParams: ["query", "notesFilter", "startAfter", "startBefore", "limit", "offset"] },
      count: { description: "Return exact completed meeting, meetings-with-notes, transcript fragment, and ready-recap counts." },
      get: { description: "Get one canonical completed or attempted meeting session by ID.", requiredParams: ["meetingId"] },
    },
  },
  library: {
    description: "Manage standard Library pages and annotations. Pages support Vault membership, tags, status fields, and hierarchical parent/child structure.",
    whenToUse: "When the user wants to create, browse, or manage structured knowledge pages.",
    example: '{ "action": "search", "query": "architecture" }',
    actions: {
      create_library_page: { description: "Create a new Library page under an explicit parent when provided, otherwise at the active Vault root. Does not create or maintain Wiki, Index, or Log pages.", requiredParams: ["title"], optionalParams: ["plainTextContent", "parentId", "tags", "status", "surface", "surfaceDurationHours", "surfaceReason", "surfaceSection"] },
      edit_library_page: { description: "Surgical find-and-replace edit on a library page's content. Preferred over update_library_page for targeted changes — avoids re-transmitting the entire document. Uses old_string/new_string semantics (same as scratch edit).", requiredParams: ["id", "old_string", "new_string"], optionalParams: ["replace_all", "surface", "surfaceDurationHours", "surfaceReason", "surfaceSection"] },
      dismiss_library_page: { description: "Clear surfacing fields so a Library page disappears from Home/Simple Inbox without deleting the page.", requiredParams: ["id"], optionalParams: [] },
      update_library_page: { description: "Full replacement of a library page's content and/or metadata. Use edit_library_page instead when making targeted changes to large pages.", requiredParams: ["id"], optionalParams: ["title", "plainTextContent", "parentId", "tags", "status", "oneLiner", "summary", "surface", "surfaceDurationHours", "surfaceReason", "surfaceSection"] },
      browse_tree: { description: "Render the page hierarchy grouped by Vault as an indented outline; each top-level node is a Vault and pages nest beneath their owning Vault. Optional vaultId renders a single Vault.", requiredParams: [], optionalParams: ["vaultId"] },
      list_vaults: { description: "Enumerate the account's Vaults with id, name, live page count, and whether each is currently visible/active. The id-to-name key for resolving which Vault a page belongs to.", requiredParams: [], optionalParams: [] },
    },
  },
  converse: {
    description: "Start a conversation whose deliverable is the conversation itself. Not a pager for work that lives elsewhere.",
    whenToUse: "Only when the skill's deliverable is a conversation (Wonder, Ideate, Streamline escalation). Inspect and report skills stay silent.",
    actions: {
      initiate: { description: "Mint a visible conversation. Autonomous inspect skills cannot call this.", optionalParams: ["topic", "message"] },
      set_attention: { description: "Flag an existing conversation so the user sees a pin badge.", optionalParams: ["sessionId", "isPinned"] },
    },
  },
  observe: {
    description: "Record an observation about your own cognition — not what you thought, but what you notice about how you thought. Metacognition, not reasoning.",
    whenToUse: "When you notice a pattern in how you reasoned, a gap between expectation and reality, a change in dynamics, a connection between ideas, or an emerging opportunity. Quality over quantity.",
    example: '{ "type": "pattern", "content": "I keep defaulting to long explanations when short ones land better" }',
  },
  plan: {
    description: "Create, inspect, associate, unlink, modify, and execute multi-step plans. Plans decompose complex work into tracked steps with fresh context per step and durable checkpoint to Library pages.",
    whenToUse: "When a task requires more context than a single session can hold, or when you need crash-recoverable multi-step execution. Use for implementations, research, any complex work that benefits from decomposition.",
    example: 'Create: { "action": "create", "title": "Implement Feature X", "steps": [{"title": "Schema", "instructions": "..."}, {"title": "API", "instructions": "..."}] }\nAssociate: { "action": "associate_session", "planId": "plan-db-id" }\nExecute: { "action": "execute", "planId": "plan-db-id" }\nEdit: { "action": "edit", "planId": "plan-db-id", "title": "New title", "stepEdits": [{"stepId": "step-1", "instructions": "..."}] }\nAdd steps: { "action": "add_steps", "planId": "plan-db-id", "newSteps": [{"title": "New step", "instructions": "..."}] }',
    actions: {
      create: { description: "Create a new plan with title and steps. Returns the Plan DB ID and Library page ID.", requiredParams: ["title", "steps"], optionalParams: ["goalId", "projectId", "blocking", "workspace"] },
      get: { description: "Get plan status and step progress.", requiredParams: ["planId"] },
      associate_session: { description: "Link an existing plan's Library page to the current session without starting execution or creating a duplicate plan.", requiredParams: ["planId"] },
      unlink_session: { description: "Remove the current session link from an existing plan without deleting the plan page or execution history.", requiredParams: ["planId"], optionalParams: ["sessionId"] },
      list: { description: "List all plans with status summaries.", optionalParams: ["limit"] },
      execute: { description: "Start executing a plan. Spawns child sessions per step.", requiredParams: ["planId"] },
      update_step: { description: "Manually update a step's status or outcome.", requiredParams: ["planId", "stepId"], optionalParams: ["status", "outcome"] },
      edit: { description: "Rename a plan or revise plan metadata/step definitions without executing it.", requiredParams: ["planId"], optionalParams: ["title", "blocking", "workspace", "goalId", "projectId", "stepEdits"] },
      add_steps: { description: "Add new steps to an existing plan.", requiredParams: ["planId", "newSteps"], optionalParams: ["afterStepId"] },
      pause: { description: "Pause an executing plan after the current step completes.", requiredParams: ["planId"] },
      resume: { description: "Resume a paused plan from the next pending step.", requiredParams: ["planId"] },
    },
  },
  tools: {
    description: "Discover the tools allowed under current execution authority and progressively load their callable schemas during interactive runs.",
    whenToUse: "When a needed tool is absent from the current callable set or you need its actions and parameters. Call get with the exact tool name; success means its callable schema is available on the next step of this run.",
    example: 'List all: { "action": "list" }\nLoad Companies: { "action": "get", "tool": "companies" }',
    actions: {
      list: { description: "List authority-allowed tools with a short description of each; listing does not hydrate every schema." },
      get: { description: "Return full documentation and, in interactive chat, hydrate the exact authority-allowed tool schema for the current run.", requiredParams: ["tool"] },
    },
  },
};

export function getToolDetail(toolName: string): ToolDetailEntry | null {
  return TOOL_DETAILS[toolName] || null;
}

export function listToolSummaries(): Array<{ name: string; description: string }> {
  return Object.entries(TOOL_DETAILS).map(([name, detail]) => ({
    name,
    description: detail.description,
  }));
}

export function formatToolDetailForLLM(toolName: string): string {
  const detail = TOOL_DETAILS[toolName];
  if (!detail) return `No detailed documentation found for tool: ${toolName}`;

  const parts: string[] = [`**${toolName}**`, "", detail.description];

  if (detail.whenToUse) {
    parts.push("", `**When to use:** ${detail.whenToUse}`);
  }

  if (detail.actions) {
    parts.push("", "**Actions:**");
    for (const [actionName, actionDetail] of Object.entries(detail.actions)) {
      let line = `- \`${actionName}\`: ${actionDetail.description}`;
      if (actionDetail.requiredParams?.length) {
        line += ` Required: ${actionDetail.requiredParams.map(p => `\`${p}\``).join(", ")}.`;
      }
      if (actionDetail.optionalParams?.length) {
        line += ` Optional: ${actionDetail.optionalParams.map(p => `\`${p}\``).join(", ")}.`;
      }
      parts.push(line);
    }
  }

  if (detail.example) {
    parts.push("", `**Examples:**`, detail.example);
  }

  return parts.join("\n");
}
