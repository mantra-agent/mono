import {
  RULES_TOOL_DESCRIPTION,
} from "./personal-rule-policy";

export interface ToolDetailEntry {
  description: string;
  whenToUse?: string;
  example?: string;
  actions?: Record<string, { description: string; requiredParams?: string[]; optionalParams?: string[] }>;
}

export const TOOL_DETAILS: Record<string, ToolDetailEntry> = {
  scratch: {
    description: "Manage temporary workspace files (SCRATCH). These files are NOT available in production — use the `files` tool for persistent storage. Actions: read, write, edit, list, search.",
    whenToUse: "When working with temporary files during a session — drafts, analysis, code experiments. For permanent files the user should be able to download or access in production, use the `files` tool instead.",
    example: 'Read a file: { "action": "read", "path": "notes.md" }\nWrite a file: { "action": "write", "path": "draft.md", "content": "..." }\nEdit a file: { "action": "edit", "path": "draft.md", "old_string": "old text", "new_string": "new text" }',
    actions: {
      read: { description: "Read file from scratch workspace. Supports offset/limit for large files.", requiredParams: ["path"], optionalParams: ["offset", "limit"] },
      write: { description: "Write file to scratch workspace. Creates parent directories as needed.", requiredParams: ["path", "content"] },
      edit: { description: "Find and replace text in a scratch file. Use replace_all for multiple occurrences.", requiredParams: ["path", "old_string", "new_string"], optionalParams: ["replace_all"] },
      list: { description: "List files and directories in the scratch workspace.", optionalParams: ["path"] },
      search: { description: "Search for files by glob pattern in the scratch workspace.", requiredParams: ["pattern"], optionalParams: ["limit"] },
    },
  },
  files: {
    description: "Manage PERSISTENT files in object storage (survive deployment, available in production). Returns download links. Actions: write, read, list.",
    whenToUse: "When saving files the user should be able to download or that need to persist across deployments. For temporary scratch work, use the `scratch` tool instead.",
    example: 'Save a file: { "action": "write", "fileName": "report.md", "content": "..." }\nRead a file: { "action": "read", "filePath": "/objects/uploads/abc123.md" }',
    actions: {
      write: { description: "Save a file permanently to object storage. Returns a download link you MUST include in your response.", requiredParams: ["fileName", "content"], optionalParams: ["contentType"] },
      read: { description: "Read a persistent file from object storage by its object path (the /objects/... path returned by write).", requiredParams: ["filePath"] },
      list: { description: "List all persistent files stored in object storage.", optionalParams: ["prefix"] },
    },
  },
  web: {
    description: "Search the web or fetch content from URLs. Actions: search, fetch.",
    whenToUse: "When the user asks to look something up online, needs current information, or wants to read a web page.",
    example: 'Search: { "action": "search", "query": "latest AI news" }\nFetch: { "action": "fetch", "url": "https://example.com" }',
    actions: {
      search: { description: "Search the web using Brave Search API.", requiredParams: ["query"], optionalParams: ["count"] },
      fetch: { description: "Fetch and extract text content from a URL. Large pages are automatically summarized.", requiredParams: ["url"], optionalParams: ["timeout"] },
    },
  },
  memory: {
    description: "Unified memory system — read/write knowledge files, search all layers with structured filters, manage graph links, delete entries (single or bulk), batch retrieve, count, find duplicate clusters, run maintenance ops. Actions: read, write, read_entry, search, create_link, update_entry, delete_entry, get, get_many, find_duplicates, count, bulk_delete, consolidate_short, integrate_mid_to_long, run_myelination, run_memory_decay, run_memory_reinforcement.",
    whenToUse: "When you need to read or update workspace knowledge files, search past conversations, retrieve specific memory entries, link memories, delete obsolete entries (one or many), batch-fetch entries, count entries, find duplicate clusters, or run memory maintenance operations.",
    example: 'Read: { "action": "read", "file": "PRINCIPLES.md" }\nSearch: { "action": "search", "query": "what did we discuss about product launch?" }\nCount: { "action": "count", "layer": "long" }\nFind duplicates: { "action": "find_duplicates", "layer": "long", "limit": 20 }\nDelete (preview): { "action": "delete_entry", "id": 42 }\nDelete (confirm): { "action": "delete_entry", "id": 42, "confirm": true, "reason": "duplicate entry" }\nBulk delete (preview): { "action": "bulk_delete", "ids": [1, 2, 3] }\nBulk delete (confirm): { "action": "bulk_delete", "ids": [1, 2, 3], "confirm": true, "reason": "duplicate cluster cleanup" }',
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
      consolidate_short: { description: "Consolidate short-term memory entries into mid-term." },
      integrate_mid_to_long: { description: "Integrate mid-term memories into long-term storage.", optionalParams: ["force"] },
      run_myelination: { description: "Run myelination process to strengthen frequently accessed memory pathways." },
      run_memory_decay: { description: "Apply decay to long-term memories and vNext claims according to their lifecycle policies." },
      run_memory_reinforcement: { description: "Reinforce memories that have been recently recalled." },
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
    description: "Read, write, edit, and clone Word documents (.docx) in the scratch workspace. Actions: read, write, edit, clone.",
    whenToUse: "When working with Word documents — reading content, creating new documents, editing existing ones, or using a document as a style template.",
    example: 'Read: { "action": "read", "path": "report.docx" }\nWrite: { "action": "write", "path": "output.docx", "content": "# Title\\nContent..." }\nEdit: { "action": "edit", "path": "report.docx", "replacements": [{"find": "old", "replace": "new"}] }',
    actions: {
      read: { description: "Read a .docx file. Modes: text (plain text, default), rich (structured with metadata), annotated (inline markdown with comments/changes).", requiredParams: ["path"], optionalParams: ["mode"] },
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
      create: { description: "Create a new task. milestoneId is required; if the right milestone is unclear, ask Ray where it belongs before creating. The tool automatically appends the current source session as @session:id when available. Supports deadline (YYYY-MM-DD).", requiredParams: ["title", "description", "milestoneId"], optionalParams: ["status", "priority", "impact", "effort", "owner", "requiresReview", "projectId", "milestoneId", "deadline"] },
      complete: { description: "Mark a task as done. This is the ONLY way to complete tasks.", optionalParams: ["taskId", "title"] },
      delete: { description: "Permanently delete a task.", optionalParams: ["taskId", "title"] },
      update: { description: "Update a task's properties — priority, status, owner, title, description, deadline, etc.", optionalParams: ["taskId", "title", "newTitle", "description", "priority", "status", "impact", "effort", "owner", "requiresReview", "projectId", "milestoneId", "deadline"] },
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
    description: "Manage personal contacts — search, list, get details, check outreach agenda, add notes, log interactions. Actions: list, get, search, agenda, add_note, update_note, delete_note, log_interaction, create, scan_imports, scan_ignored, granular import-candidate reads/decisions, and preview/apply batch processing.",
    whenToUse: "User mentions a person, wants to look up contact details, log an interaction, or manage their relationship network.",
    example: 'Search: { "action": "search", "query": "Sarah" }\nAdd note: { "action": "add_note", "id": "person-id", "content": "..." }',
  },
  work: {
    description: "Manage projects and work status — create projects, list/get projects with tasks, manage files, milestones, and goal links. Actions: create_project, status, list_projects, get_project, list_tasks, set_goal, add_file, read_file, remove_file, add_milestone, update_milestone, remove_milestone.",
    whenToUse: "User asks about projects, work status, or wants to manage project-level resources. For individual task operations, use the `tasks` tool instead.",
    example: 'List projects: { "action": "list_projects" }\nGet project details: { "action": "get_project", "id": 1 }',
  },
  gmail: {
    description: "Read, search, and draft emails via Gmail. Supports multiple accounts. Actions: status, search, read, batch_read, draft, update_draft, recent, download_attachment, triage_log, email_cache. update_draft uses one explicit body operation: findReplace for exact edits, rangePatch with expectedBodyHash for guarded offsets, or replaceBody for intentional whole-body rewrites. There is no tool-level send action.",
    whenToUse: "User asks about email, wants to check inbox, search for messages, or create an email for review/send. When creating an email intended for Ray to review or send, use gmail.draft or gmail.update_draft so the inline draft widget appears. Prefer findReplace for local feedback, rangePatch only when you have the current body hash, and replaceBody only for deliberate rewrites. Plain chat email text is only for brainstorming or explicit copy-only requests.",
    example: 'Search: { "action": "search", "query": "from:sarah", "account": "Work" }\nDraft: { "action": "draft", "to": "sarah@example.com", "subject": "Following up", "body": "..." }',
  },
  git: {
    description: "Interact with Git repositories — clone, pull, browse history, diff, branch, checkout, show, and write changes (add, commit, push, create_pr, merge_pr, delete_branch). Write actions (add, commit, push, create_pr) only work on cloned repos in repos/, not the workspace root.",
    whenToUse: "User mentions a git repository, wants to pull code, clone a project, review commit history, work with branches, commit changes, push code, open a pull request, merge PRs, or delete remote branches.",
    example: 'Clone: { "action": "clone", "url": "https://github.com/user/repo" }\nCommit: { "action": "commit", "directory": "repo", "message": "fix: improve error handling" }\nCreate PR: { "action": "create_pr", "directory": "repo", "title": "Fix error handling", "body": "Improved error messages" }',
  },
  strategy: {
    description: "Strategic modeling — create strategies, manage actors, build move trees, run simulations, manage assumptions, track notes and artifacts. Actions: list_strategies, get_strategy, create_strategy, and many more.",
    whenToUse: "User wants to model a strategic scenario, negotiate, run simulations, analyze moves, or work with strategy artifacts.",
    example: 'List strategies: { "action": "list_strategies" }',
  },
  decisions: {
    description: "Personal decision log — track open/closed strategic decisions with Data, Scenarios, and Plan sections, traffic-light status (closed only), append-only updates after lock, and links to strategies/projects. Actions: list, get, create, update, delete, lock, reopen, add_update, edit_update, delete_update, add_link, remove_link.",
    whenToUse: "When the user wants to record a decision they're weighing, capture data/scenarios/plan, lock it once made, log post-decision updates, set its traffic-light status, or link it to a strategy or project.",
    example: 'Create: { "action": "create", "title": "Hire designer", "description": "Should we bring on a senior designer in Q2?", "dataContent": "Budget $5k/mo", "scenariosContent": "Option A...", "planContent": "Next steps" }\nLock: { "action": "lock", "id": "..." }\nSet traffic light: { "action": "update", "id": "...", "trafficLight": "yellow" }',
  },
  rules: {
    description: RULES_TOOL_DESCRIPTION,
    whenToUse: "When the user explicitly establishes a durable, deterministic personal behavioral override that has no stronger structural home.",
    example: '{ "action": "save", "rule": "Do not use the phrase no pressure in my strategic communications", "scope": "contextual", "context": "strategic communications" }',
  },
  intentions: {
    description: "DEPRECATED — Intentions system removed. Use the 'autonomy' skill for autonomous work.",
    whenToUse: "Do not use — this tool returns a deprecation notice. Use skills tool with the autonomy skill instead.",
    example: '{ "action": "list" }',
  },
  router: {
    description: "Call and inspect the production model routing layer. Actions: eval, list_inference_calls, get_inference_call.",
    whenToUse: "When Agent needs to test prompt compositions through the real persona/connector routing system or inspect audited inference calls.",
    example: '{ "action": "eval", "profile": "balanced", "systemPrompt": "Return JSON", "userPrompt": "Sample text", "jsonMode": true }',
  },
  skills: {
    description: "Manage Agent's skill library — reusable instruction sets. Actions: list, get, create, update, delete, search.",
    whenToUse: "When Agent needs to create, review, or modify its own reusable skills.",
    example: '{ "action": "create", "name": "my-analysis", "process": "...", "description": "Custom analysis" }',
  },
  shell: {
    description: "Execute a shell command in the workspace directory. Use for system operations, running scripts, or inspecting the environment.",
    whenToUse: "When you need to run a command-line operation, check system state, or execute a script.",
    example: '{ "command": "ls -la" }',
  },
  notion: {
    description: "Search, read, and browse Notion pages and databases. Actions: status, search, get_page, get_content, list_databases, query_database.",
    whenToUse: "User asks about their Notion, mentions notes, wikis, or documents stored in Notion.",
    example: '{ "action": "search", "query": "meeting notes" }',
  },
  system: {
    description: "System operations — get system state snapshot, create issues, retrieve runtime logs, and inspect frontend performance. Actions: state, create_issue, logs, frontend_performance.",
    whenToUse: "When needing a high-level view of system health, creating issue reports, inspecting runtime logs, or reading the same frontend telemetry summary shown on the Performance page.",
    example: 'State: { "action": "state" }\nCreate issue: { "action": "create_issue", "title": "Login bug", "description": "..." }\nLogs: { "action": "logs", "level": "error", "limit": 50 }\nFrontend: { "action": "frontend_performance", "hours": 24 }',
    actions: {
      state: { description: "Get a comprehensive snapshot of system state — memory counts, skill count, capabilities health, and more." },
      create_issue: { description: "Create a new issue to track a bug or improvement.", requiredParams: ["title"], optionalParams: ["description", "priority", "labels"] },
      logs: { description: "Retrieve recent runtime logs. Filter by level (debug/info/warn/error) and source module.", optionalParams: ["limit", "level", "source"] },
      frontend_performance: { description: "Read the canonical browser telemetry summary used by the Performance page Frontend Experience section.", optionalParams: ["hours"] },
    },
  },
  meetings: {
    description: "Manage calendar events — create, list, update, delete meetings, classify events, and link tasks/people.",
    whenToUse: "User wants to schedule, check, reschedule, cancel meetings, classify calendar events, or link tasks/priorities to calendar blocks.",
    example: 'Add: { "action": "add", "summary": "Meeting with Sarah", "start": "2026-02-23T14:00:00-06:00" }\nList: { "action": "list" }\nSet metadata: { "action": "set_metadata", "googleEventId": "...", "accountId": "...", "calendarId": "primary", "eventType": "focus_block", "attendeeEmails": ["sarah@example.com"] }\nGet metadata: { "action": "get_metadata", "googleEventId": "...", "accountId": "...", "calendarId": "primary" }',
    actions: {
      add: { description: "Create a new calendar event.", requiredParams: ["summary", "start"], optionalParams: ["end", "description", "location", "attendees", "accountId", "calendarId"] },
      list: { description: "List upcoming calendar events. Shows event type badges and linked task names inline.", optionalParams: ["from", "to", "limit"] },
      update: { description: "Update an existing calendar event.", requiredParams: ["eventId"], optionalParams: ["summary", "start", "end", "description", "location", "attendees", "accountId", "calendarId"] },
      delete: { description: "Delete/cancel a calendar event.", requiredParams: ["eventId"], optionalParams: ["accountId", "calendarId"] },
      set_metadata: { description: "Classify a calendar event, link People from attendee emails, and set its private agenda as a Library page. Event types: focus_block, exercise, meeting, planning, admin, personal.", requiredParams: ["googleEventId", "accountId", "calendarId", "eventType"], optionalParams: ["notes", "agendaLibraryPageId", "attendeeEmails", "sharedAudioAttendeeEmail"] },
      get_metadata: { description: "Get full metadata for a calendar event including linked tasks, people, and artifacts.", requiredParams: ["googleEventId", "accountId", "calendarId"] },
      link_artifact: { description: "Link a Library page artifact such as a brief, agenda, research note, follow-up, or recap to a calendar event metadata record.", requiredParams: ["metadataId", "libraryPageId"], optionalParams: ["artifactKind", "title", "source"] },
      unlink_artifact: { description: "Remove a Library artifact link from a calendar event by link record ID.", requiredParams: ["linkId"] },
    },
  },
  priorities: {
    description: "DEPRECATED — compatibility shim for check-in artifact metadata only. Use goals for all goal and priority operations.",
    whenToUse: "Avoid for new work. Use the goals tool instead.",
    example: 'Use goals: { "action": "list", "filters": { "horizon": "today" } }',
  },
  library: {
    description: "Manage library pages and annotations for knowledge management. Actions: list_library_pages, get_library_page, resolve_parent, create_library_page, update_library_page, edit_library_page, dismiss_library_page, delete_library_page, search_library_pages, search, browse_tree, tree, link_pages, annotate. Pages support tags, status fields, and hierarchical parent/child structure.",
    whenToUse: "When the user wants to create, browse, or manage structured knowledge pages.",
    example: '{ "action": "search", "query": "architecture" }',
    actions: {
      resolve_parent: { description: "Resolve the canonical Library parent for an artifact from purpose, title, pageContext, contentSummary, and tags using the Library index.", requiredParams: ["purpose"], optionalParams: ["title", "pageContext", "contentSummary", "tags"] },
      create_library_page: { description: "Create a new library page. System/tool-created pages must provide purpose/pageContext/contentSummary so the Library index resolves the parent; root or explicit-parent tool writes are rejected.", requiredParams: ["title"], optionalParams: ["plainTextContent", "purpose", "pageContext", "contentSummary", "parentId", "tags", "status", "surface", "surfaceDurationHours", "surfaceReason", "surfaceSection"] },
      edit_library_page: { description: "Surgical find-and-replace edit on a library page's content. Preferred over update_library_page for targeted changes — avoids re-transmitting the entire document. Uses old_string/new_string semantics (same as scratch edit).", requiredParams: ["id", "old_string", "new_string"], optionalParams: ["replace_all", "surface", "surfaceDurationHours", "surfaceReason", "surfaceSection"] },
      dismiss_library_page: { description: "Clear surfacing fields so a Library page disappears from Home/Simple Inbox without deleting the page.", requiredParams: ["id"], optionalParams: [] },
      update_library_page: { description: "Full replacement of a library page's content and/or metadata. Use edit_library_page instead when making targeted changes to large pages.", requiredParams: ["id"], optionalParams: ["title", "plainTextContent", "parentId", "tags", "status", "oneLiner", "summary", "surface", "surfaceDurationHours", "surfaceReason", "surfaceSection"] },
    },
  },
  converse: {
    description: "Communication with the user. Start a new session or flag an existing one for user attention.",
    whenToUse: "When you need to proactively reach out to the user about something, or when you want to draw their attention to an existing session.",
    actions: {
      initiate: { description: "Start a new session with the user.", optionalParams: ["topic", "message"] },
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
    description: "Look up detailed tool documentation — list all tools or get full docs for a specific tool/action.",
    whenToUse: "When you need to recall what tools are available, what actions they support, or what parameters a specific tool requires.",
    example: 'List all: { "action": "list" }\nGet details: { "action": "get", "tool": "scratch" }',
    actions: {
      list: { description: "List all available tools with a short description of each." },
      get: { description: "Get full documentation for a specific tool including actions, parameters, when to use, and examples.", requiredParams: ["tool"] },
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
