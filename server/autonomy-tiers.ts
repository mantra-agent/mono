
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

/**
 * Complete classification of every tool+action by side-effect tier.
 * Tool-level default is the fallback; action-level overrides take precedence.
 */
const SIDE_EFFECT_TIERS: Record<string, { default: SideEffectTier; actions?: Record<string, SideEffectTier> }> = {
  scratch: { default: 1, actions: { read: 0, list: 0, search: 0 } },
  files: { default: 1, actions: { read: 0, list: 0 } },
  shell: { default: 1 },
  web: { default: 0 },
  memory: { default: 1, actions: { read: 0, read_entry: 0, search: 0, get: 0, get_many: 0 } },
  code: { default: 0 },
  docx: { default: 1, actions: { read: 0 } },
  library: { default: 1, actions: { list_library_pages: 0, get_library_page: 0, search_library_pages: 0, search: 0, browse_tree: 0, tree: 0, list_notes: 0, get_note: 0 } },
  people: { default: 1, actions: { list: 0, get: 0, get_vault_memberships: 0, search: 0, agenda: 0, get_interactions: 0, scan_imports: 0, scan_ignored: 0, list_import_candidates: 0, get_import_candidate: 0, find_import_matches: 0, get_import_batch: 0 } },
  gmail: { default: 0, actions: { draft: 1 } },
  twitter: { default: 0, actions: { post: 2, reply: 2, delete: 2 } },
  meetings: { default: 0, actions: { add: 2, update: 2, delete: 2 } },
  converse: { default: 2 },
  content: { default: 1, actions: { list: 0, suggest_times: 0 } },
  finance: { default: 0 },
  health: { default: 1, actions: { summary: 0, metrics: 0, activity_status: 0, list_activities: 0, activity_logs: 0, get_gratitude: 0, list_gratitudes: 0 } },
  weather: { default: 0 },
  // News signal curation writes user-owned signal rows and the owner's own Home surface (internal, tier 1).
  // Read actions are tier 0. `scan` fetches from external feeds (X/RSS/web/github), so it stays tier 2 and
  // remains hard-gated for autonomous/timer/hook origins; the news-curation skill does not need it.
  news: { default: 1, actions: { summary: 0, list_signals: 0, get_signal: 0, list_sources: 0, list_scan_runs: 0, interest_graph: 0, scan: 2 } },
  goals: { default: 1, actions: { list: 0, get: 0, search: 0 } },

  rules: { default: 1, actions: { list: 0, get: 0 } },
  priorities: { default: 1 },
  intentions: { default: 0 },
  tasks: { default: 1 },
  work: { default: 1, actions: { status: 0, list_projects: 0, get_project: 0, list_tasks: 0, read_file: 0 } },
  decisions: { default: 1, actions: { list: 0, get: 0 } },
  strategy: { default: 1, actions: {
    list_strategies: 0, get_strategy: 0, get_move_tree: 0, get_move: 0, get_move_path: 0,
    list_actors: 0, get_actor: 0, list_child_moves: 0, list_assumptions: 0,
    list_end_conditions: 0, list_notes: 0, list_context: 0, list_artifacts: 0,
    get_artifact: 0, list_move_definitions: 0, get_move_definition: 0, list_states: 0, get_state: 0,
  }},
  stories: { default: 1, actions: { list: 0, get: 0 } },
  capabilities: { default: 1, actions: { list: 0, get_validations: 0 } },
  skills: { default: 1, actions: { list: 0, get: 0, search: 0, scores: 0, run: 2 } },
  timers: { default: 1, actions: { list: 0, get: 0, runs: 0 } },
  hooks: { default: 1, actions: { list: 0, get: 0 } },
  session: { default: 0, actions: { send_message: 1 } },
  settings: { default: 1, actions: { get: 0 } },
  system: { default: 0, actions: { create_issue: 1 } },
  railway: { default: 2, actions: {
    status: 0, deployments: 0, logs: 0, build_logs: 0, list_variables: 0,
  }},
  sentry: { default: 2, actions: {
    status: 0, issues: 0, issue: 0, events: 0, latest_event: 0,
  }},
  platforms: { default: 2, actions: {
    list_connections: 0, get_connection: 0, test_connection: 0,
    list_environments: 0, get_environment: 0, get_environment_status: 0,
    get_build_lifecycle: 0, get_build_status: 0, list_environment_workflows: 0,
    get_context_artifacts: 0, get_cloudflare_pages_project: 0,
    poll_cloudflare_pages_deployment: 0,
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
  message_parent: { default: 1 },
  message_sibling: { default: 1 },
  message_child: { default: 1 },
  pronunciation: { default: 1, actions: { list: 0 } },
};

/**
 * Public alias of the classification map for callers that want to inspect or
 * extend it. Treat this as read-only; mutations will not be picked up by
 * downstream callers that may have memoized lookups.
 */
export const TOOL_ACTION_TIERS = SIDE_EFFECT_TIERS;

/**
 * Get the numeric side-effect tier for a tool+action combination.
 * Returns 0 (read-only), 1 (internal-write), or 2 (external-effect).
 * Unknown tools default to 2 (safest).
 */
export function getSideEffectTier(toolName: string, action?: string): SideEffectTier {
  const entry = SIDE_EFFECT_TIERS[toolName];
  if (!entry) return 2; // unknown tools are hard-gated

  if (action && entry.actions?.[action] !== undefined) {
    return entry.actions[action];
  }

  return entry.default;
}
