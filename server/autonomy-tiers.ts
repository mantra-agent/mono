
// ============================================================
// Side-Effect Tier System (numeric 0/1/2)
// Used for gift-mode enforcement in autonomous sessions
// ============================================================

/**
 * Numeric side-effect classification:
 * 0 = Read-only (no state change)
 * 1 = Internal-write (changes Agent's own state, creates internal artifacts)
 * 2 = External-effect (touches outside world or creates user notifications)
 */
export type SideEffectTier = 0 | 1 | 2;

export type ToolSideEffectEntry = {
  default: SideEffectTier;
  actions?: Record<string, SideEffectTier>;
};

type ToolSideEffectLookup = (toolName: string) => ToolSideEffectEntry | undefined;

let toolSideEffectLookup: ToolSideEffectLookup | undefined;

/**
 * Bind the live TOOLS catalog after it initializes.
 * tool-registry already imports agent-authority; a top-level TOOLS import here
 * would cycle. The leftover name map stays until every alias is gone.
 */
export function bindToolSideEffectCatalog(lookup: ToolSideEffectLookup): void {
  toolSideEffectLookup = lookup;
}

/**
 * Leftover name map for unstamped aliases (twitter, meeting_bot,
 * create_calendar_block, observe, workflows, priorities, …).
 * Public TOOLS rows carry sideEffectDefault. Do not delete this map until
 * every leftover name is gone or stamped.
 */
const SIDE_EFFECT_TIERS: Record<string, ToolSideEffectEntry> = {
  ui: { default: 2 },
  scratch: { default: 1, actions: { read: 0, list: 0, search: 0 } },
  files: { default: 1, actions: { read: 0, list: 0 } },
  // PDF open/extract/list are verified principal-scoped reads. Default stays tier 2 so
  // future write/generate actions fail closed until explicitly classified.
  pdf: { default: 2, actions: { open: 0, extract: 0, list: 0 } },
  shell: { default: 1 },
  // Python runs arbitrary model-supplied code inside a constrained diagnostic boundary.
  // Keep it tier 2 so autonomous/timer/hook origins fail closed unless trusted engineering
  // delegation has been established and independently authorized.
  python: { default: 2 },
  // Dependency mutation changes repository source and may resolve registry metadata.
  // Keep it tier 2 so autonomous/timer/hook origins remain default-denied unless
  // they carry server-validated trusted engineering delegation.
  npm_dependencies: { default: 2 },
  web: { default: 0 },
  memory: { default: 1, actions: { read: 0, read_entry: 0, search: 0, get: 0, get_many: 0 } },
  code: { default: 0 },
  docx: { default: 1, actions: { read: 0 } },
  library: { default: 1, actions: { list_library_pages: 0, get_library_page: 0, search_library_pages: 0, search: 0, browse_tree: 0, tree: 0, list_vaults: 0, list_notes: 0, get_note: 0 } },
  people: { default: 1, actions: { list: 0, get: 0, get_vault_memberships: 0, search: 0, agenda: 0, get_interactions: 0, scan_imports: 0, scan_ignored: 0, list_import_candidates: 0, get_import_candidate: 0, find_import_matches: 0, get_import_batch: 0 } },
  gmail: { default: 0, actions: { draft: 1 } },
  twitter: { default: 0, actions: { post: 2, reply: 2, delete: 2 } }, // Hidden compatibility alias.
  content: { default: 1, actions: { list: 0, suggest_times: 0, x_status: 0, x_lookup: 0, x_news_search: 0, x_news_lookup: 0, x_post: 2, x_reply: 2, x_delete: 2 } },
  meetings: { default: 0, actions: { add: 1, update: 2, delete: 2, create_calendar_block: 2, join: 2, leave: 2 } },
  // Hidden migration aliases retain their independently gated external-effect tiers.
  create_calendar_block: { default: 2 },
  meeting_bot: { default: 0, actions: { join: 2, leave: 2 } },
  finance: { default: 0 },
  health: { default: 1, actions: { summary: 0, metrics: 0, activity_status: 0, list_activities: 0, activity_logs: 0, get_gratitude: 0, list_gratitudes: 0 } },
  weather: { default: 0 },
  // News scanning is a bounded internal pipeline: provider reads are constrained by
  // the News adapters and results land only in the owning user's signal store.
  news: { default: 1, actions: { summary: 0, list_signals: 0, get_signal: 0, list_sources: 0, list_scan_runs: 0, interest_graph: 0 } },
  business: { default: 1, actions: { list_hiring_slots: 0, get_hiring_plan: 0, create_hiring_slot: 2, update_hiring_slot: 2, cancel_hiring_slot: 2, list: 0, get: 0, list_kpis: 0, get_kpi: 0, list_metrics: 0, get_metric: 0, sample_range: 0, sample_usage: 0, list_samples: 0, list_businesses: 0, get_business: 0, list_business_vaults: 0, get_model: 0, get_budget: 0, delete_budget_department: 2, delete_budget_category: 2, delete_budget_line_item: 2, create_business: 2, update_business: 2, archive_business: 2, add_business_vault: 2, remove_business_vault: 2, set_business_vaults: 2 } },
  goals: { default: 1, actions: { list: 0, get: 0, search: 0 } },
  blocking_graph: { default: 1, actions: { list_blockers: 0, list_blocked_items: 0 } },
  // Plan execution is internal orchestration. Each child and eventual tool call
  // remains independently authorized under the originating principal.
  plan: { default: 1, actions: { get: 0, list: 0 } },

  rules: { default: 1, actions: { list: 0, get: 0 } },
  priorities: { default: 1 },
  intentions: { default: 0 },
  tasks: { default: 1 },
  work: { default: 1, actions: { status: 0, list_projects: 0, get_project: 0, list_tasks: 0, read_file: 0 } },
  jobs: { default: 1, actions: { list: 0, get: 0 } },
  // Company CRM and Exec pipeline are principal-scoped internal records.
  // Unknown tools default to tier 2 and vanish from autonomous schemas,
  // which previously aborted daytime scans on the first tools.get miss.
  companies: { default: 1, actions: { list: 0, get: 0 } },
  exec: {
    default: 1,
    actions: {
      list_skills: 0, get_skill: 0, list_experience: 0, get_experience: 0,
      list_opportunities: 0, get_opportunity: 0, list_opportunity_activities: 0,
      list_passions: 0, get_passion: 0, list_metrics: 0, list_education: 0,
      get_opportunity_artifacts: 0,
    },
  },
  decisions: { default: 1, actions: { list: 0, get: 0 } },
  scenarios: { default: 1, actions: {
    list_scenarios: 0, get_scenario: 0, get_move_tree: 0, get_move: 0, get_move_path: 0,
    list_actors: 0, get_actor: 0, list_child_moves: 0, list_assumptions: 0,
    list_end_conditions: 0, list_notes: 0, list_context: 0, list_artifacts: 0,
    get_artifact: 0, list_move_definitions: 0, get_move_definition: 0, list_states: 0, get_state: 0,
  }},
  stories: { default: 1, actions: { list: 0, get: 0 } },
  capabilities: { default: 1, actions: { list: 0, get_validations: 0 } },
  // Skill creation, mutation, and composition are internal intelligence-state
  // operations. A child run inherits the originating principal and every tool it
  // invokes is authorized independently at that tool's real capability boundary.
  skills: { default: 1, actions: { list: 0, get: 0, search: 0, scores: 0, run: 1 } },
  agendas: { default: 1, actions: { list: 0, get: 0, search: 0 } },
  timers: { default: 1, actions: { list: 0, get: 0, runs: 0 } },
  hooks: { default: 1, actions: { list: 0, get: 0 } },
  session: { default: 0, actions: {
    send_message: 1,
    set_agenda: 1,
    update_agenda_item: 1,
    complete_agenda_item: 1,
    skip_agenda_item: 1,
    defer_agenda_item: 1,
    initiate: 2,
    set_attention: 2,
    message_parent: 1,
    message_child: 1,
    message_sibling: 1,
  } },
  settings: { default: 1, actions: { get: 0 } },
  system: { default: 0, actions: { save_history_rollup: 1 } },
  issues: { default: 1, actions: { list: 0, list_reported: 0, get: 0, delete: 2 } },
  workflows: { default: 2, actions: {
    list_templates: 0, get_template: 0, list_runs: 0, get_run: 0,
  } },
  railway: { default: 2, actions: {
    status: 0, deployments: 0, logs: 0, build_logs: 0, list_variables: 0,
  }},
  sentry: { default: 2, actions: {
    status: 0, issues: 0, issue: 0, events: 0, latest_event: 0, uptime: 0,
    sync_availability: 2,
  }},
  platforms: { default: 2, actions: {
    list_connections: 0, get_connection: 0, test_connection: 0,
    list_environments: 0, get_environment: 0, get_environment_status: 0,
    list_products: 0,
    get_build_lifecycle: 0, get_build_status: 0, list_environment_workflows: 0,
    get_cloudflare_pages_project: 0,
    poll_cloudflare_pages_deployment: 0,
  }},
  routers: { default: 2, actions: {
    list: 0, get: 0, list_legacy: 0,
  }},
  observe: { default: 1 },
  orient: { default: 1 },
  cognition: { default: 1, actions: { get_emotion: 0, emotion_history: 0, get_persona: 0, list_personas: 0 } },
  router: { default: 0 },
  images: { default: 1, actions: { analyze: 0 } },
  indexed_content: { default: 0 },
  notion: { default: 0 },
  git: { default: 0, actions: { clone: 1, add: 1, commit: 1, push: 2, create_pr: 2 } },
  tools: { default: 0 },
  pronunciation: { default: 1, actions: { list: 0 } },
};

/**
 * Public alias of the classification map for callers that want to inspect or
 * extend it. Treat this as read-only; mutations will not be picked up by
 * downstream callers that may have memoized lookups.
 */
export const TOOL_ACTION_TIERS = SIDE_EFFECT_TIERS;

function resolveSideEffectEntry(toolName: string): ToolSideEffectEntry | undefined {
  const stamped = toolSideEffectLookup?.(toolName);
  if (stamped) return stamped;
  return SIDE_EFFECT_TIERS[toolName];
}

/**
 * Get the numeric side-effect tier for a tool+action combination.
 * Reads the TOOLS instance field first; leftover name map is fallback.
 * Unknown tools default to 2 (safest).
 */
export function getSideEffectTier(toolName: string, action?: string): SideEffectTier {
  const entry = resolveSideEffectEntry(toolName);
  if (!entry) return 2; // unknown tools are hard-gated

  if (action && entry.actions?.[action] !== undefined) {
    return entry.actions[action];
  }

  return entry.default;
}
