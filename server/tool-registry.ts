import { getToolStats } from "./file-storage";
import { createLogger } from "./log";
import { storage } from "./storage";
import { TTLCache } from "./utils/ttl-cache";
import type { SkillWithReferences } from "@shared/models/skills";
import { UI_INTERACTION_TARGETS } from "@shared/ui-interaction";
import {
  QUESTION_TOOL_DESCRIPTION,
  RULES_TOOL_DESCRIPTION,
} from "./personal-rule-policy";
import { getShellToolContractDescription } from "./agent-authority";
import { bindToolSideEffectCatalog, type SideEffectTier } from "./autonomy-tiers";
import { secretConnectorReadiness } from "./mods/composition/connector-readiness";
import type { RegisteredConnectorKey } from "./mods/registry/registered-keys";
import { workflowAttemptResults } from "@shared/schema";

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
  amberFailures: number;
  unclassifiedErrors: number;
  avgDuration: number | null;
}

export interface ToolMeta {
  description: string;
  category: string;
  parameters?: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  whenToUse?: string;
  example?: string;
  /**
   * Integration-backed tools whose usability depends on a configured connector.
   * When set and that connector is a secret-backed connector that is not
   * configured, the tool is withheld from the advertised schema set so the model
   * is never handed a capability it structurally cannot execute. Untagged tools,
   * and tools whose connector has no cheap synchronous readiness signal
   * (OAuth/provider-backed), always pass through.
   */
  connectorKey?: RegisteredConnectorKey;
  /**
   * Keep the tool advertised when its connector is unconfigured because at least
   * one action returns a bounded, non-error readiness result. Provider actions
   * remain independently fail closed in the handler.
   */
  advertiseWhenUnready?: boolean;
  /**
   * Gift-mode side-effect default. Per-action overrides live in sideEffectActions.
   * getSideEffectTier consults this field first; SIDE_EFFECT_TIERS is leftover
   * fallback for unstamped aliases. Unknown stays 2.
   */
  sideEffectDefault?: SideEffectTier;
  sideEffectActions?: Record<string, SideEffectTier>;
}

export const TOOLS: Record<string, ToolMeta> = {
  ui: {
    description: "Interact with the authenticated application UI in the browser tab containing the originating session. Provide exactly one subject: `target` for a stable semantic control, or `resource` plus `surface=home` for an in-place Simple/Home feed object. `execute` performs a registered control action. `guide` requires a non-empty `introduction`, narrates first, reveals and spotlights the real target, locks interaction outside it, and completes when the user activates it or cancels. Resource guides expand and highlight the matching canonical object without navigating away. In voice, every spotlight waits until narration finishes.",
    category: "browser",
    sideEffectDefault: 2,
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", enum: UI_INTERACTION_TARGETS, description: "Stable semantic UI control target. Mutually exclusive with resource." },
        resource: { type: "string", description: "Canonical @type:id reference for a Simple/Home feed object to expand and spotlight in place. Mutually exclusive with target; guide mode only." },
        surface: { type: "string", enum: ["home"], description: "Owning surface for a resource guide. Required with resource." },
        mode: { type: "string", enum: ["execute", "guide"], description: "Execute a control directly or narrate and guide the user through a real control/resource." },
        introduction: { type: "string", description: "Required for guide mode. One or two sentences, in your own voice, that name the target and explicitly ask the user to act (example: \"These are your meeting notes. Open this row to see what was captured.\"). Shown beside the spotlight; in voice, say it before the spotlight appears." },
      },
      required: ["mode"],
    },
  },
  scratch: {
    description: "Read and author workspace files, including code inside the current session-owned repos/ clone. Use write/edit for code changes; shell is intentionally read-only. Repository writes require trusted engineering provenance and build:write. Use `files` for persistent user-facing storage.",
    category: "file",
    sideEffectDefault: 1,
    sideEffectActions: { read: 0, list: 0, search: 0 },
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["read", "write", "edit", "patch", "list", "search"], description: "Action" },
        path: { type: "string", description: "File path relative to scratch workspace" },
        content: { type: "string", description: "File content (write)" },
        repositoryDirectory: { type: "string", description: "Exact repos/<clone> directory owned by this session (patch)" },
        patch: { type: "string", description: "Bounded Git unified diff applied atomically with context verification (patch)" },
        old_string: { type: "string", description: "Text to find (edit)" },
        new_string: { type: "string", description: "Replacement text (edit)" },
        replace_all: { type: "boolean", description: "Replace all occurrences (edit, default false)" },
        offset: { type: "number", description: "Line number to start from (read, 1-indexed)" },
        limit: { type: "number", description: "Max lines (read) or max results (search)" },
        pattern: { type: "string", description: "Glob pattern (search, e.g., '*.md')" },
      },
      required: ["action"],
    },
  },
  files: {
    description:
      "Manage PERSISTENT files in object storage (survives deployment) and read vault-bound external drive resources through filesApi. Object-storage actions: write/read/list. Bound-drive actions: listBound/listChildren/getMetadata/read/authorize. Never call Google/Box directly — bound reads go through filesApi only.",
    category: "file",
    sideEffectDefault: 1,
    sideEffectActions: { read: 0, list: 0 },

    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["write", "read", "list", "listBound", "listChildren", "getMetadata", "authorize"],
          description:
            "Action. Object storage: write/read/list. Bound drive via filesApi: listBound/listChildren/getMetadata/authorize. Bound-drive file bodies use action=read with driveResourceId or provider+providerFileId (not filePath).",
        },
        fileName: { type: "string", description: "File name to save (write)" },
        content: { type: "string", description: "File content (write)" },
        contentType: { type: "string", description: "MIME type (write, auto-detected by default)" },
        filePath: {
          type: "string",
          description: "Object storage path (object-storage read, e.g., '/objects/uploads/abc.md')",
        },
        prefix: { type: "string", description: "Path prefix filter (object-storage list)" },
        vaultId: {
          type: "string",
          description: "Vault ID (required for listBound; optional vault gate for other bound-drive actions)",
        },
        driveResourceId: {
          type: "string",
          description: "Bound drive_resource ID (preferred identity for listChildren/getMetadata/read/authorize)",
        },
        provider: {
          type: "string",
          enum: ["google", "box", "mantra"],
          description: "Provider when using provider+providerFileId instead of driveResourceId",
        },
        providerFileId: {
          type: "string",
          description: "Provider-native file/folder ID when not using driveResourceId",
        },
        pageToken: {
          type: "string",
          description: "Pagination token for listChildren",
        },
      },
      required: ["action"],
    },
  },
  pdf: {
    description:
      "Core PDF document service for Agent. open authorizes a source and returns a short-lived content handle plus metadata/viewer hint; extract runs server-side text extraction per page after the same authorize path; generate builds a structured PDF into private object storage with a document_artifacts row (source_kind=generated) and returns open metadata for /documents/:id; list returns principal-visible document_artifacts. Prefer pdf.* over files.read for document semantics. No path-on-disk escape — bound sources go through filesApi; ownership is re-checked on every call. Extract is a derivative, never ACL authority.",
    category: "file",
    sideEffectDefault: 2,
    sideEffectActions: { open: 0, extract: 0, list: 0 },
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["open", "extract", "generate", "list"],
          description:
            "open: authorize + handle/metadata. extract: plain text by page with caps. generate: structured PDF to private storage + document_artifacts. list: document_artifacts in visible vaults.",
        },
        documentId: {
          type: "string",
          description: "document_artifacts id (preferred for open/extract when already registered)",
        },
        driveResourceId: {
          type: "string",
          description: "Bound drive_resource ID for open/extract",
        },
        provider: {
          type: "string",
          enum: ["google", "box", "mantra"],
          description: "Provider when using provider+providerFileId instead of driveResourceId",
        },
        providerFileId: {
          type: "string",
          description: "Provider-native file ID when not using driveResourceId",
        },
        vaultId: {
          type: "string",
          description: "Vault ID (required with provider+providerFileId; optional for generate/list; defaults to active vault on generate)",
        },
        objectPath: {
          type: "string",
          description: "Internal object storage path for open/extract",
        },
        uploadId: {
          type: "string",
          description: "Just-uploaded object path/id for open/extract",
        },
        title: {
          type: "string",
          description: "Document title for generate (required)",
        },
        blocks: {
          type: "array",
          description: "Ordered content blocks for generate: { type: heading|paragraph|bullet, text }",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["heading", "paragraph", "bullet"] },
              text: { type: "string" },
            },
            required: ["type", "text"],
          },
        },
        startPage: {
          type: "number",
          description: "1-based start page for extract (default 1)",
        },
        maxPages: {
          type: "number",
          description: "Max pages to extract from startPage (default 40, hard cap 200)",
        },
        limit: {
          type: "number",
          description: "Max documents for list (default 50, max 100)",
        },
        offset: {
          type: "number",
          description: "Pagination offset for list",
        },
      },
      required: ["action"],
    },
  },
  shell: {
    // Description is derived from validateShellCommand policy — never hand-author a parallel contract.
    description: getShellToolContractDescription(),
    category: "system",
    sideEffectDefault: 1,

    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "Read-only shell command. Must start with an allowlisted binary; `|`, `&&`, and `;` may sequence allowlisted segments. No file redirects or variable expansion. See tool description for the full contract.",
        },
        timeout: { type: "number", description: "Timeout in ms (default 30000, max 120000)" },
      },
      required: ["command"],
    },
  },
  python: {
    description: "Run bounded Python diagnostics inside the current session-owned repository clone. This is a separate constrained execution boundary: build:write plus trusted engineering provenance are required; server secrets are absent; Landlock limits filesystem reads to the repository and Python standard library while seccomp denies network creation; subprocess, native-extension loading, and filesystem mutation are denied; wall time, CPU, memory, file size, descriptors, source size, and output are capped. Raw python remains blocked in shell.",
    category: "system",
    sideEffectDefault: 2,
    parameters: {
      type: "object",
      properties: {
        repositoryDirectory: { type: "string", description: "Exact directory name of the current session-owned clone inside repos/, for example mono-env-11-ms123456" },
        source: { type: "string", description: "Python source to execute (max 50,000 characters)" },
        timeoutMs: { type: "number", description: "Wall timeout in milliseconds (default 10000, hard cap 30000)" },
      },
      required: ["repositoryDirectory", "source"],
    },
  },
  npm_dependencies: {
    description: "Safely set one exact npm package version in a repository-root or nested package.json and regenerate that package's existing package-lock.json without mutating node_modules or running lifecycle scripts. Root packages must use the session clone's immutable workspace toolchain symlink. Restricted to the current session-owned repos/ clone and trusted engineering sessions with build:write. This is the only approved dependency-mutation path; general npm install remains blocked.",
    category: "system",
    sideEffectDefault: 2,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["set_package"], description: "Bounded dependency mutation action" },
        repositoryDirectory: { type: "string", description: "Exact directory name inside repos/ for this session-owned clone" },
        manifestPath: { type: "string", description: "package.json path relative to the repository root, for example package.json or mobile/package.json" },
        section: { type: "string", enum: ["dependencies", "devDependencies", "optionalDependencies", "overrides"], description: "Manifest dependency section to mutate" },
        packageName: { type: "string", description: "Exact npm package name" },
        version: { type: "string", description: "Exact semantic version; ranges, tags, URLs, aliases, and file/git specs are rejected" },
      },
      required: ["action", "repositoryDirectory", "manifestPath", "section", "packageName", "version"],
    },
  },
  web: {
    description: "Search the web, fetch content from URLs, or run an authenticated interactive page test (navigate, click, tap, scroll, press, type, screenshot) with structured evidence.",
    category: "web",
    sideEffectDefault: 0,

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["search", "fetch", "test", "screenshot"], description: "Action. 'test' is one authenticated Chromium session: navigate/click/tap/scroll/press/type/screenshot. 'screenshot' is a deprecated alias for 'test'." },
        query: { type: "string", description: "Search query (search)" },
        count: { type: "number", description: "Number of results (search, default 10)" },
        url: { type: "string", description: "URL to fetch (fetch) or external entry URL (test)" },
        timeout: { type: "number", description: "Timeout in ms (fetch, default 15000)" },
        route: { type: "string", description: "App route path like '/memory' — resolves to localhost:PORT (test/screenshot)" },
        viewport: { type: "string", description: "Viewport preset: 'desktop' (1440x900), 'tablet' (768x1024), 'mobile' (375x812), or 'WxH' custom (test/screenshot)" },
        fullPage: { type: "boolean", description: "Capture full scrollable page height, capped at 4000px (test/screenshot)" },
        delay: { type: "number", description: "Extra wait ms after networkidle before the closing frame, default 2000 (test/screenshot)" },
        auth: {
          type: "object",
          description: "Optional browser-session auth. Omitted + local app → calling principal cookie. Omitted + external → photograph-only stranger. Named integration must carry browser-session capability (day-one: automation-auth).",
          properties: {
            integration: { type: "string", description: "Connector key with browser-session capability, e.g. automation-auth" },
          },
        },
        steps: {
          type: "array",
          description: "Closed act sequence before the closing screenshot (max 8). Kinds: navigate, click, tap, scroll, press, type, screenshot. Empty/omitted = today's photograph-only path.",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["navigate", "click", "tap", "scroll", "press", "type", "screenshot"], description: "Act kind" },
              route: { type: "string", description: "Local app route for navigate (same-origin)" },
              url: { type: "string", description: "Absolute URL for navigate (must stay on entry origin)" },
              selector: { type: "string", description: "CSS selector for click/tap/scroll-into-view (max 200)" },
              deltaX: { type: "number", description: "Horizontal wheel delta for scroll (clamped ±4000)" },
              deltaY: { type: "number", description: "Vertical wheel delta for scroll (clamped ±4000)" },
              key: { type: "string", description: "Allowlisted key for press: Enter Escape Tab Space Backspace Delete Arrow* Home End" },
              text: { type: "string", description: "Text for type" },
            },
            required: ["kind"],
          },
        },
      },
      required: ["action"],
    },
  },
  memory: {
    description: "Unified memory system — read/write workspace knowledge files, search and inspect vNext claims, run vNext maintenance ops.",
    category: "memory",
    sideEffectDefault: 1,
    sideEffectActions: { read: 0, read_entry: 0, search: 0, get: 0, get_many: 0 },

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["read", "write", "read_entry", "search", "get", "get_many", "count", "link_entity", "get_entity_links", "list_sources", "add_source", "delete_source", "search_claims", "review_claim", "vnext_claim_counts", "vnext_claim_detail", "run_vnext_lifecycle", "run_full_sleep_cycle", "compute_gsi", "run_rem"], description: "Action" },
        judgment: { type: "string", enum: ["useful", "incorrect", "needs_clarification"], description: "Human review judgment for review_claim (omit with clearReview=true to clear)" },
        note: { type: "string", description: "Required review note when judgment is needs_clarification (review_claim)" },
        clearReview: { type: "boolean", description: "When true, clears the current claim review stamp (review_claim)" },
        file: { type: "string", description: "File name (read/write, e.g., PRINCIPLES.md)" },
        content: { type: "string", description: "Content to write (write)." },
        append: { type: "boolean", description: "Append instead of overwrite (write, default false)" },
        id: { type: "number", description: "vNext claim ID for read_entry, get, vnext_claim_detail, link_entity, get_entity_links, list_sources, or add_source." },
        ids: { type: "array", items: { type: "number" }, description: "Array of vNext claim IDs (get_many, max 100)" },
        query: { type: "string", description: "Search query (vNEXT claim search). Use '*' with structured filters to retrieve claims without semantic ranking." },
        source: { type: "string", description: "Filter by source type for vNext search" },
        limit: { type: "number", description: "Max results (search default 20)" },
        startDate: { type: "string", description: "Start date for date range filter (search, format: YYYY-MM-DD). Inclusive." },
        endDate: { type: "string", description: "End date for date range filter (search, format: YYYY-MM-DD). Exclusive." },
        timezone: { type: "string", description: "IANA timezone string for interpreting startDate/endDate (e.g. 'America/Chicago'). Defaults to the server's configured timezone." },
        relationship: { type: "string", description: "Relationship type for vNext source refs" },
        strength: { type: "number", description: "Strength 0–1 for vNext source refs" },
        includeGSI: { type: "boolean", description: "Include GSI computation in sleep cycle (run_full_sleep_cycle, default false)" },
        entityType: { type: "string", description: "Entity type to link (link_entity, e.g. 'person', 'company', 'project', 'goal')" },
        entityId: { type: "string", description: "Entity ID to link (link_entity/get_entity_links). Also used as entity filter for search_claims." },
        memoryId: { type: "number", description: "vNext claim ID for list_sources/add_source." },
        sourceType: { type: "string", description: "Source type filter or value (list_sources, add_source — e.g. 'memory', 'library', 'session', 'chat_journal')" },
        sourceId: { type: "string", description: "Source ID (list_sources filter, add_source — e.g. the ID of the source entry)" },
        sourceRefId: { type: "number", description: "Source ref ID to delete (delete_source)" },
        context: { type: "string", description: "Context string (add_source)" },
        quote: { type: "string", description: "Quote from source (add_source)" },
        clarity: { type: "number", description: "How explicitly the source expresses the claim, 0–1 (add_source)" },
        relationshipCertainty: { type: "number", description: "Certainty of this source-to-claim relationship, 0–1 (add_source); separate from claim certainty" },
        sourceObservedAt: { type: "string", description: "ISO source observation time (add_source)" },
        sourceLineageKey: { type: "string", description: "Stable lineage key used to prevent duplicate evidence from masquerading as corroboration" },
        sourceIndependence: { type: "string", enum: ["same_lineage", "independent", "unknown"], description: "Independence assessment for the source evidence" },
        producerMethod: { type: "string", description: "Method that asserted or derived the relationship" },
        derivationVersion: { type: "string", description: "Version of the derivation method, when derived" },
        sourceProvenance: { type: "object", description: "Bounded provenance metadata for the source relationship" },
        claimType: { type: "string", description: "Filter by claim type: state, cause, or action (search_claims)" },
        storage: { type: "string", enum: ["vnext"], description: "Optional explicit vNEXT storage selector for search_claims" },
        lifecycleStage: { type: "string", enum: ["extracted", "sourced", "linked", "canonical", "retired"], description: "Filter vNext claims by lifecycle stage (search_claims)" },
        includeReviewedRetired: { type: "boolean", description: "When true, include retired claims that already carry a human review stamp (Digest Memory membership; search_claims)" },
        hasEntityLinks: { type: "boolean", description: "Filter claims by whether they have entity links (search_claims)" },
        minLinks: { type: "number", description: "Filter: minimum link count (search)" },
        maxLinks: { type: "number", description: "Filter: maximum link count (search)" },
        minContentLength: { type: "number", description: "Filter: minimum content length in chars (search)" },
        maxContentLength: { type: "number", description: "Filter: maximum content length in chars (search)" },
        recalledBefore: { type: "string", description: "Filter: entries recalled before this ISO timestamp (search)" },
        recalledAfter: { type: "string", description: "Filter: entries recalled after this ISO timestamp (search)" },
        minRecallCount: { type: "number", description: "Filter: minimum recall count (search)" },
        maxRecallCount: { type: "number", description: "Filter: maximum recall count (search)" },
        hasTitle: { type: "boolean", description: "Filter: true=has title, false=no title (search)" },
        hasSummary: { type: "boolean", description: "Filter: true=has summary, false=no summary (search)" },
        deletionExpired: { type: "boolean", description: "Filter: true=deletionScheduled is in the past (search)" },
        createdBefore: { type: "string", description: "Filter: created before this ISO timestamp (vNext search)" },
        createdAfter: { type: "string", description: "Filter: created after this ISO timestamp (vNext search)" },
        updatedBefore: { type: "string", description: "Filter: updated/processed before this ISO timestamp (search)" },
        updatedAfter: { type: "string", description: "Filter: updated/processed after this ISO timestamp (search)" },
        sortBy: { type: "string", enum: ["createdAt", "contentLength", "linkCount", "recallCount"], description: "Sort field (search, default createdAt)" },
        sortOrder: { type: "string", enum: ["asc", "desc"], description: "Sort direction (search, default desc)" },
        offset: { type: "number", description: "Pagination offset (search, default 0)" },
      },
      required: ["action"],
    },
  },
  railway: {
    description: "Inspect and manage a Railway-hosted Platform Environment. Cross-environment operations require `platformEnvironmentId`, which resolves the hosting binding and authenticated connector through the canonical Platform Environment resolver. Omit it only for current-runtime self-inspection with status, logs, or build_logs. When Git auto-deploy is functioning, inspect that deployment and do not trigger a manual redeploy unless the user explicitly asks or a confirmed provider failure requires recovery. Destructive actions and secret values are intentionally not exposed.",
    category: "system",
    sideEffectDefault: 2,
    sideEffectActions: {
      status: 0, deployments: 0, logs: 0, build_logs: 0, list_variables: 0,
    },
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "deployments", "logs", "build_logs", "list_variables", "redeploy", "restart"], description: "Action" },
        platformEnvironmentId: { type: "number", description: "Platform Environment ID. Required except for current-runtime status, logs, and build_logs self-inspection." },
        deploymentId: { type: "string", description: "Specific deployment ID (optional — defaults to latest deployment for logs/build_logs/restart/redeploy)" },
        limit: { type: "number", description: "Max results (deployments default 10, for logs default 200, max 500)" },
      },
      required: ["action"],
    },
  },

  sentry: {
    description: "Query the existing Sentry integration for crash reports and external uptime evidence. Actions: status, issues, issue, events, latest_event, uptime (completed-day availability readiness), sync_availability (project a ready completed day into Metrics), resolve, unresolve, ignore.",
    category: "system",
    connectorKey: "sentry",
    advertiseWhenUnready: true,
    sideEffectDefault: 2,
    sideEffectActions: {
      status: 0, issues: 0, issue: 0, events: 0, latest_event: 0, uptime: 0,
      sync_availability: 2,
    },
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "issues", "issue", "events", "latest_event", "uptime", "sync_availability", "resolve", "unresolve", "ignore"], description: "Action. Prefer issues for the unresolved inventory; list is accepted as a compatibility alias for issues." },
        issueId: { type: "string", description: "Sentry issue ID (required for issue, events, latest_event, resolve, unresolve, ignore)" },
        query: { type: "string", description: "Sentry issue search query (default: is:unresolved). Space-separated terms are implicit AND. Boolean OR/AND operators are not supported; use key:[value1,value2] for multi-value match." },
        sort: { type: "string", description: "Sort order for issues: date, new, freq, user (default: date)" },
        limit: { type: "number", description: "Max results (issues default 25 max 100, for events default 10 max 100)" },
        full: { type: "boolean", description: "Include full event body with stacktrace (events, default true)" },
      },
      required: ["action"],
    },
  },
  meta: {
    description: "Queue and execute Meta/Ray-Ban DAT SDK calls through the mobile iOS bridge. Requires the mobile app debug overlay to be open so the phone can poll, execute native DAT calls locally, and post results back. When the user asks what they are looking at during a glasses session, capture first, analyze the image with the images tool, then answer from evidence; diagnose bridge failure before asking for manual debugging.",
    category: "system",
    sideEffectDefault: 2,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["queue", "call", "results", "commands", "status", "preflight", "initialize", "listDevices", "requestCamera", "register", "connect", "capture"], description: "Action. Direct DAT actions queue and wait by default; queue only queues; call uses datAction and waits." },
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
    description: "Inspect Expo/EAS projects and builds or launch one exact-source iOS preview build using the stored EXPO_ACCESS_TOKEN integration secret. start_build requires the full expected main commit SHA, never cancels another build, and fails closed if main moved. Use build_logs to fetch Xcode/build log artifacts and extract actual failure lines instead of relying on Expo summary text.",
    category: "system",
    connectorKey: "expo",
    sideEffectDefault: 2,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "projects", "builds", "build", "build_logs", "start_build", "cancel"], description: "Action" },
        projectId: { type: "string", description: "Expo app/project UUID for builds list. Defaults to mobile Expo config projectId when available." },
        buildId: { type: "string", description: "EAS build ID for build/build_logs/cancel. Defaults to latest build when omitted for build_logs; for cancel, omit buildId to cancel in-progress builds matching project/platform/profile." },
        expectedSourceRef: { type: "string", description: "Full 40-character Git commit SHA required for start_build. Launch fails if current GitHub main differs." },
        platform: { type: "string", description: "Platform filter for cancel, e.g. ios or android. start_build is fixed to ios." },
        profile: { type: "string", description: "Build profile filter for cancel, e.g. preview or production. start_build is fixed to preview." },
        limit: { type: "number", description: "Max builds to return (default 10, max 50)" },
      },
      required: ["action"],
    },
  },
  settings: {
    description: "Persist and retrieve key-value settings. Keys must start with an allowed prefix (memory.*, system.*, skill.*, hygiene.*).",
    category: "system",
    sideEffectDefault: 1,
    sideEffectActions: { get: 0 },
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "set", "delete"], description: "Action" },
        key: { type: "string", description: "Setting key (e.g., 'memory.hygiene.runCount')" },
        value: { description: "Value to store (set — any JSON-serializable value)" },
      },
      required: ["action", "key"],
    },
  },
  code: {
    description: "Query and navigate the selected Platform codebase knowledge graph — search, inspect symbols, analyze impact, trace flows, rename, and run Cypher.",
    category: "code",
    sideEffectDefault: 0,

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["query", "context", "impact", "changes", "architecture", "modules", "flows", "rename", "schema", "cypher"], description: "Action" },
        query: { type: "string", description: "Search query (query) or Cypher query (cypher)" },
        goal: { type: "string", description: "What you're trying to accomplish (query)" },
        task_context: { type: "string", description: "What you are working on (query)" },
        limit: { type: "number", description: "Max processes to return (query, default 5)" },
        max_symbols: { type: "number", description: "Max symbols per process (query, default 10)" },
        include_content: { type: "boolean", description: "Include source code in results (query/context)" },
        name: { type: "string", description: "Symbol/module/flow name (context/modules/flows)" },
        uid: { type: "string", description: "Symbol UID for direct lookup (context)" },
        file: { type: "string", description: "File path to disambiguate (context)" },
        target: { type: "string", description: "Symbol to analyze (impact)" },
        direction: { type: "string", description: "'upstream' or 'downstream' (impact)" },
        maxDepth: { type: "number", description: "Max traversal depth (impact, default 3)" },
        includeTests: { type: "boolean", description: "Include test files (impact)" },
        minConfidence: { type: "number", description: "Min confidence 0-1 (impact, default 0.7)" },
        symbol_name: { type: "string", description: "Symbol to rename (rename)" },
        symbol_uid: { type: "string", description: "Symbol UID (rename)" },
        new_name: { type: "string", description: "New name (rename)" },
        file_path: { type: "string", description: "File path (rename)" },
        dry_run: { type: "boolean", description: "Preview only (rename, default true)" },
      },
      required: ["action"],
    },
  },
  docx: {
    description: "Read uploaded or workspace Word documents (.docx), and write, edit, or clone documents in the scratch workspace. For uploaded attachments, pass the exact /objects/uploads/<id>.docx path from attachment metadata.",
    category: "file",
    sideEffectDefault: 1,
    sideEffectActions: { read: 0 },

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["read", "write", "edit", "clone"], description: "Action" },
        path: { type: "string", description: "Workspace file path (read/write/edit), or the exact /objects/uploads/<id>.docx attachment path (read)" },
        mode: { type: "string", enum: ["text", "rich", "annotated"], description: "Read mode (read, default 'text')" },
        content: { type: "string", description: "Content to write (write/clone)" },
        output_path: { type: "string", description: "Output path (edit/clone)" },
        replacements: { type: "array", description: "Find/replace pairs (edit)", items: { type: "object", properties: { find: { type: "string" }, replace: { type: "string" } }, required: ["find", "replace"] } },
        source_path: { type: "string", description: "Template document path (clone)" },
      },
      required: ["action"],
    },
  },
  business: {
    description: "Manage the business layer through the canonical principal- and Vault-scoped storage boundary. Object groups: Businesses, Financial Model, closed Pricing catalog (packages[max|max_plus|factory_plus] + extras), monthly operating Budgets (Department → Category → Line item), Business Plans, KPIs, and Metrics. get_model returns assumptions plus the full projection matrix (months, period rollups, gates, financing) for a Business; Forecast consumes Pricing for package numbers and does not own them. set_assumption writes one mix/volume assumption value and rejects retired package keys; link_assumption_kpi/clear_assumption_kpi assign or remove a KPI on an assumption row; each write returns the recomputed headline aggregates and gate statuses. get_pricing returns the full catalog including derived yearOneMonthly; first read seeds the locked ladder. update_package takes a closed package key plus sparse fields; update_extras is sparse. Budget actions require businessId; hierarchy mutations use the stable IDs returned by get_budget, and monthly amounts are integer USD cents. A KPI requires an existing metricId — create the metric first. Plan add_kpi/remove_kpi only attach or detach an existing KPI to a plan; create_kpi/delete_kpi create or destroy the KPI object. Business-entity actions manage the Business and its Vault memberships. Outputs include canonical @business_plan:id, @kpi:id, and @metric:id references.",
    sideEffectDefault: 1,
    sideEffectActions: {
      list_hiring_slots: 0, get_hiring_plan: 0, create_hiring_slot: 2, update_hiring_slot: 2, cancel_hiring_slot: 2,
      list: 0, get: 0, list_kpis: 0, get_kpi: 0, list_metrics: 0, get_metric: 0, sample_range: 0, sample_usage: 0,
      list_samples: 0, list_businesses: 0, get_business: 0, list_business_vaults: 0, get_model: 0, get_pricing: 0, update_package: 2, update_extras: 2, get_budget: 0,
      delete_budget_department: 2, delete_budget_category: 2, delete_budget_line_item: 2, create_business: 2,
      update_business: 2, archive_business: 2, add_business_vault: 2, remove_business_vault: 2, set_business_vaults: 2,
    },
    category: "strategy",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "list", "get", "create", "rename", "delete", "set_thematic_goal", "clear_thematic_goal", "add_initiative", "remove_initiative", "set_leading_metric", "clear_leading_metric", "set_lagging_kpi", "clear_lagging_kpi", "add_kpi", "remove_kpi", "assign_vault",
            "list_kpis", "get_kpi", "create_kpi", "update_kpi", "delete_kpi",
            "list_metrics", "get_metric", "create_metric", "update_metric", "delete_metric", "sample_range", "sample_usage", "list_samples", "record_sample", "delete_sample",
            "list_businesses", "get_business", "create_business", "update_business", "archive_business", "list_business_vaults", "add_business_vault", "remove_business_vault", "set_business_vaults",
            "list_hiring_slots", "get_hiring_plan", "create_hiring_slot", "approve_hiring_role", "update_hiring_slot", "cancel_hiring_slot", "remove_hiring_role", "get_model", "set_assumption", "link_assumption_kpi", "clear_assumption_kpi", "get_pricing", "update_package", "update_extras", "get_budget", "add_budget_department", "rename_budget_department", "delete_budget_department", "add_budget_category", "rename_budget_category", "delete_budget_category", "add_budget_line_item", "rename_budget_line_item", "delete_budget_line_item", "set_budget_monthly_amount",
          ],
          description: "Action. Plan actions operate on the plan id; KPI actions use kpiId; Metric actions use metricId; Business-entity, Model, Pricing, and Budget actions use businessId.",
        },
        id: { type: "string", description: "Business Plan ID (required for plan get/rename/delete/set_thematic_goal/clear_thematic_goal/add_initiative/remove_initiative/add_kpi/remove_kpi/assign_vault)" },
        name: { type: "string", description: "Name (plan/KPI/Metric create or rename; Budget hierarchy add/rename)" },
        goalId: { type: "string", description: "Thematic Goal ID (plan create/set_thematic_goal)" },
        projectId: { type: "number", description: "Initiative Project ID (add/remove_initiative and initiative measurement actions)" },
        kpiId: { type: "string", description: "KPI ID (set_lagging_kpi, link_assumption_kpi, legacy plan add_kpi/remove_kpi, and KPI get/update/delete)" },
        metricId: { type: "string", description: "Metric ID (set_leading_metric, create_kpi, and metric get/update/delete/list_samples/record_sample actions)" },
        sampleId: { type: "string", description: "Metric sample ID (required for delete_sample)" },
        vaultId: { type: "string", description: "Visible live Vault ID (plan create/assign_vault)" },
        query: { type: "string", description: "Search filter (list_kpis/list_metrics)" },
        slug: { type: "string", description: "Optional kebab-case slug (create_kpi/create_metric); auto-derived from name when omitted" },
        description: { type: "string", description: "Description (create/update KPI or Metric)" },
        unit: { type: "string", description: "Metric/sample unit label (create/update_metric, record_sample)" },
        direction: { type: "string", enum: ["higher_is_better", "lower_is_better", "target_band"], description: "Scoring/comparison direction (KPI or Metric)" },
        samplePeriod: { type: "string", enum: ["point", "daily", "weekly", "monthly", "custom"], description: "Metric sample cadence (create/update_metric)" },
        adapterKind: { type: "string", enum: ["manual", "internal", "expression"], description: "Metric data adapter (create/update_metric)" },
        status: { type: "string", enum: ["draft", "active", "archived"], description: "KPI/Metric status (create/update)" },
        targetLabel: { type: "string", description: "Human-readable KPI target statement (create/update_kpi)" },
        cadence: { type: "string", description: "KPI cadence label, e.g. Weekly, Monthly (create/update_kpi)" },
        ownerLabel: { type: "string", description: "KPI owner label (create/update_kpi)" },
        bullThreshold: { type: "number", description: "KPI bull (excellent) band threshold (create/update_kpi)" },
        onTrackThreshold: { type: "number", description: "KPI on-track (good) band threshold (create/update_kpi)" },
        bearThreshold: { type: "number", description: "KPI bear (warning) band threshold; below is critical (create/update_kpi)" },
        staleAfterHours: { type: "number", description: "Hours before a measured value is treated as stale (create/update_kpi, default 168)" },
        standingObjectiveKey: { type: "string", enum: ["none", "trust-security", "reliability-performance", "customer-health", "revenue-runway", "delivery-economics", "product-release", "founder-team", "corporate-stewardship"], description: "Optional standing operating objective this KPI owns, 1:1 per vault. Use none for an ordinary unbound KPI." },
        value: { type: "number", description: "Numeric value (record_sample; set_assumption assumption value)" },
        observedAt: { type: "string", description: "ISO timestamp the sample was observed (record_sample); defaults to now" },
        sourceRef: { type: "string", description: "Sample provenance label (record_sample, default 'manual')" },
        evidence: { type: "string", description: "Optional supporting evidence for a sample (record_sample)" },
        periodStart: { type: "string", description: "ISO period start for a non-point sample (record_sample)" },
        periodEnd: { type: "string", description: "ISO period end for a non-point sample (record_sample)" },
        start: { type: "string", description: "Inclusive ISO range start for sample_range/sample_usage" },
        end: { type: "string", description: "Exclusive ISO range end for sample_range/sample_usage; cannot be future or more than 400 days after start" },
        limit: { type: "number", description: "Max rows for list_samples (default 50, max 500)" },
        clearFields: { type: "array", items: { type: "string" }, description: "Explicit fields to clear on update_kpi/update_metric (e.g. description, targetLabel, standingObjectiveKey, bullThreshold)" },
        businessId: { type: "string", description: "Business entity ID (required for Business-entity actions, get_model, Pricing actions, Budget actions, and create_metric; optional filter for list_metrics and reassignment for update_metric)" },
        period: { type: "string", enum: ["monthly", "quarterly", "annually"], description: "Projection rollup cadence for get_model (default monthly). Months remain the source of truth; periods are aggregated from them." },
        assumptionKey: { type: "string", description: "Financial Model mix/volume field to write or link a KPI to (set_assumption, link_assumption_kpi, clear_assumption_kpi), e.g. newAccountsPerExternalMeeting, startingAccounts, quarterOneNewAccounts, annualAccountChurnPct, maxEntrySharePct, maxPlusEntrySharePct, factoryPlusEntrySharePct. Package prices, includes, extras, and markup are rejected — use update_package / update_extras." },
        hiringSlotId: { type: "string", description: "Hiring slot ID (Hiring Plan reads return stable IDs)" },
        roleId: { type: "string", description: "Canonical Job Role ID for approving a role" },
        quarter: { type: "string", description: "Hiring quarter YYYY Q1-Q4" },
        approvalMonth: { type: "string", description: "Compatibility approval month YYYY-MM" },
        plannedStartMonth: { type: "string", description: "Planned start month YYYY-MM" },
        idempotencyKey: { type: "string", description: "Replay-safe mutation key" },
        departmentId: { type: "string", description: "Budget Department ID (required for Department rename/delete and nested Category/Line item actions)" },
        categoryId: { type: "string", description: "Budget Category ID (required for Category rename/delete and nested Line item actions)" },
        lineItemId: { type: "string", description: "Budget Line item ID (required for Line item rename/delete/set amount)" },
        monthlyAmountCents: { type: "number", description: "Non-negative integer monthly Budget amount in USD cents (set_budget_monthly_amount)" },
        publicName: { type: "string", description: "Business display/brand name (create_business/update_business)" },
        entityName: { type: "string", description: "Business legal entity name (create_business/update_business)" },
        valuesPageId: { type: "string", description: "Library page ID for the Business Values narrative (create_business/update_business)" },
        visionPageId: { type: "string", description: "Library page ID for the Business Vision narrative (create_business/update_business)" },
        missionPageId: { type: "string", description: "Library page ID for the Business Mission narrative (create_business/update_business)" },
        phasesPageId: { type: "string", description: "Library page ID for the Business Phases narrative (create_business/update_business)" },
        pitchPageId: { type: "string", description: "Library page ID for the Business Pitch narrative (create_business/update_business)" },
        gtmPageId: { type: "string", description: "Library page ID for the Business GTM narrative (create_business/update_business)" },
        productPageId: { type: "string", description: "Library page ID for the Business Product narrative (create_business/update_business)" },
        brandPageId: { type: "string", description: "Library page ID for the Business Brand narrative (create_business/update_business)" },
        differentiatorsPageId: { type: "string", description: "Library page ID for the Business Differentiators narrative (create_business/update_business)" },
        marketPageId: { type: "string", description: "Library page ID for the Business Market narrative (create_business/update_business)" },
        icpPageId: { type: "string", description: "Library page ID for the Business ICP narrative (create_business/update_business)" },
        pricingPageId: { type: "string", description: "Library page ID for the Business Pricing narrative (create_business/update_business)" },
        activationPageId: { type: "string", description: "Library page ID for the Business Activation narrative (create_business/update_business)" },
        moatPageId: { type: "string", description: "Library page ID for the Business Moat narrative (create_business/update_business)" },
        businessStatus: { type: "string", enum: ["active", "archived"], description: "Business status (update_business)" },
        vaultIds: { type: "array", items: { type: "string" }, description: "Complete visible live Vault ID set for create_business (optional, defaults to active Vault) and set_business_vaults (required, non-empty)" },
        key: { type: "string", enum: ["max", "max_plus", "factory_plus"], description: "Closed Pricing package key (update_package)" },
        listMonthly: { type: "number", description: "Package list monthly price (update_package)" },
        yearOneCash: { type: "number", description: "Package year-one cash (update_package)" },
        yearTwoMonthly: { type: "number", description: "Package year-two monthly price (update_package)" },
        includedAgents: { type: "number", description: "Included Agents (update_package)" },
        includedPrincipals: { type: "number", description: "Included Principals (update_package)" },
        includedParticipants: { type: "number", description: "Included Participants; omit and clearFields to set unlimited (update_package)" },
        extraAgentMonthly: { type: "number", description: "Extra Agent monthly; omit and clearFields to null (update_package)" },
        extraPrincipalMonthly: { type: "number", description: "Extra Principal monthly; omit and clearFields to null (update_package)" },
        extraParticipantMonthly: { type: "number", description: "Extra Participant monthly; omit and clearFields to null (update_package)" },
        includedTokensMillions: { type: "number", description: "Included tokens in millions (update_package)" },
        factory: { type: "boolean", description: "Factory included (update_package)" },
        router: { type: "string", enum: ["default", "dedicated"], description: "Router kind (update_package)" },
        customization: { type: "string", enum: ["standard", "software_factory"], description: "Customization support (update_package)" },
        support: { type: "string", enum: ["activation_concierge", "elite_concierge"], description: "Support noun (update_package)" },
        extraUsagePerMillion: { type: "number", description: "Shared extra usage rate per million tokens (update_extras)" },
        workhorseInputPerMillion: { type: "number", description: "Shared workhorse input rate per million tokens (update_extras)" },
      },
      required: ["action"],
    },
  },
  goals: {
    description: "Manage life goals — unified system covering all horizons from daily goals (today) to lifetime aspirations. Horizons: today, this_week, this_month, this_quarter, this_year, three_year, ten_year, lifetime. Short horizons support periodDate for date-scoped queries. This is the canonical tool for all goal and priority operations. add_relationship/remove_relationship/list_relationships manage first-class Goal↔Person and Goal↔Meeting links. Use canonical @goal:id syntax in messages to link to goals. Legacy [goal:id] syntax is accepted during migration.",
    category: "work",
    sideEffectDefault: 1,
    sideEffectActions: { list: 0, get: 0, search: 0 },

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "get", "create", "update", "delete", "search", "set_parent", "unlink_parent", "list_relationships", "add_relationship", "remove_relationship", "set_review", "set_daily_plan", "get_daily_artifacts", "set_weekly_reflection", "set_weekly_plan", "set_monthly_plan", "set_monthly_reflection", "set_quarterly_plan", "set_quarterly_reflection"], description: "Action" },
        id: { type: "string", description: "Goal ID (required for get, update, delete, set_parent, unlink_parent, list_relationships, add_relationship, remove_relationship)" },
        targetType: { type: "string", enum: ["person", "meeting"], description: "Relationship target type (add_relationship)" },
        targetId: { type: "string", description: "Person or meeting ID to link (add_relationship)" },
        linkId: { type: "string", description: "Relationship link ID to remove (remove_relationship)" },
        shortName: { type: "string", description: "Short goal name (required for create)" },
        description: { type: "string", description: "Full description (create/update)" },
        domain: { type: "string", enum: ["career", "health", "relationships", "finance", "growth", "creative"], description: "Life domain" },
        horizon: { type: "string", enum: ["today", "this_week", "this_month", "this_quarter", "this_year", "three_year", "ten_year", "lifetime", "now", "3_year", "10_year", "decade"], description: "Time horizon" },
        status: { type: "string", enum: ["active", "on_track", "at_risk", "achieved", "blocked", "dormant"], description: "Goal status (create/update, default: active)" },
        query: { type: "string", description: "Search term (search action)" },
        parentId: { type: "string", description: "Goal ID to set as parent (set_parent action)" },
        filters: { type: "object", description: "Optional filters for list: { domain, horizon, search }" },
        targetDate: { type: "string", description: "Target date YYYY-MM-DD (create/update)" },
        periodDate: { type: "string", description: "Period date YYYY-MM-DD for short-horizon scoping (create/update)" },
        periodWeek: { type: "string", description: "Period week YYYY-Www for weekly goals (create/update)" },
        periodMonth: { type: "string", description: "Period month YYYY-MM for monthly goals (create/update)" },
        source: { type: "string", description: "Source of the goal (create/update)" },
        libraryPageId: { type: "string", description: "Library page ID to link as review/plan/reflection (set_review, set_daily_plan, set_weekly/monthly/quarterly actions)" },
        date: { type: "string", description: "Date in YYYY-MM-DD format (set_review, set_daily_plan, get_daily_artifacts; defaults to today)" },
        week: { type: "string", description: "Any date within the target week in YYYY-MM-DD format (set_weekly_plan/set_weekly_reflection; defaults to current week)" },
        month: { type: "string", description: "Target month in YYYY-MM format (set_monthly_plan/set_monthly_reflection; defaults to current month)" },
        quarter: { type: "string", description: "Target quarter in YYYY-QN format (set_quarterly_plan/set_quarterly_reflection; defaults to current quarter)" },
      },
      required: ["action"],
    },
  },
  blocking_graph: {
    description: "Universal Core blocked_by graph over typed canonical addresses (PLANNING.md § Universal blocked_by protocol; shared/blocked-by-protocol.ts). One predicate only; source waits on target; no self-edges/cycles; no second dependency store.",
    category: "work",
    sideEffectDefault: 1,
    sideEffectActions: { list_blockers: 0, list_blocked_items: 0 },
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list_blockers", "list_blocked_items", "add_blocker", "remove_blocker"], description: "Blocking graph action" },
        sourceAddress: { type: "string", description: "Canonical source address of the blocked item (waits on target)" },
        targetAddress: { type: "string", description: "Canonical address of the blocking prerequisite" },
        linkId: { type: "string", description: "Blocking edge id for remove_blocker" },
        idempotencyKey: { type: "string", description: "Required replay-safe key for add_blocker" },
        provenanceAddress: { type: "string", description: "Optional canonical supporting address" },
        cursor: { type: "string", description: "Cursor returned by a prior read" },
        lifecycle: { type: "string", enum: ["active", "retired"], description: "Lifecycle filter" },
        limit: { type: "number", description: "Bounded page size" },
      },
      required: ["action"],
    },
  },
  question: {
    description: QUESTION_TOOL_DESCRIPTION,
    category: "communication",
    sideEffectDefault: 2,
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description:
            "The concise, plain-language question to present. Must be easy for a human to understand at a glance — no internal codenames, smoke labels, ticket IDs, or system jargon.",
        },
        options: {
          anyOf: [
            {
              type: "array",
              minItems: 2,
              maxItems: 8,
              items: {
                anyOf: [
                  { type: "string", description: "User-visible answer label; a stable ID is derived." },
                  {
                    type: "object",
                    properties: {
                      id: { type: "string", description: "Stable short option ID." },
                      label: { type: "string", description: "User-visible answer label." },
                      description: {
                        type: "string",
                        description:
                          "Decision aid for this choice — not a restatement of the label. Write it as: choose this if you want to prioritize X; tradeoffs are Y, Z. Omit when it cannot make the decision easier.",
                      },
                    },
                    required: ["id", "label"],
                  },
                ],
              },
            },
            { type: "string", description: "A JSON-encoded array; accepted only as a recovery format and normalized before persistence." },
          ],
          description:
            "Two to eight discrete choices. Prefer an array of { id, label, description? } objects; plain labels and JSON-encoded arrays are normalized. Option descriptions must help decide (prioritize X; tradeoffs Y, Z), not restate the label.",
        },
        selectionMode: { type: "string", enum: ["single", "multiple"], description: "single by default; multiple allows more than one choice." },
        reasoning: {
          type: "string",
          description: "Why I'm asking — short context shown above the options so the user understands the judgment stake.",
        },
        principles: {
          type: "array",
          description: "Optional shortlist of immutable Principle revisions relevant to the judgment. User can also search the full Principle set when answering.",
          maxItems: 12,
          items: {
            type: "object",
            properties: {
              principleId: { type: "string" },
              revisionId: { type: "string" },
              title: { type: "string" },
              layer1: { type: "string" },
            },
            required: ["principleId", "revisionId", "title", "layer1"],
          },
        },
        allowResponseReasoning: { type: "boolean", description: "Allow the user to attach freeform reasoning, default false." },
        recommendation: {
          type: "object",
          description: "Optional agent preliminary judgment shown in the widget before the human confirms: highlighted answer, confidence %, prefilled reasoning, and checked principles. Prefer this whenever you have a clear take.",
          properties: {
            optionIds: {
              type: "array",
              minItems: 1,
              maxItems: 8,
              items: { type: "string" },
              description: "Option IDs the agent would choose. Must match prompt option ids. Exactly one id in single mode.",
            },
            confidence: { type: "number", description: "Confidence 1–100 for the recommended choice." },
            reasoning: { type: "string", description: "Short reasoning prefilled into the Reasoning box." },
            principleRevisionIds: {
              type: "array",
              items: { type: "string" },
              description: "Principle revision IDs checked as most important to the preliminary call. Prefer ids from the principles shortlist when provided.",
            },
          },
          required: ["optionIds", "confidence"],
          additionalProperties: false,
        },
      },
      required: ["question", "options"],
    },
  },
  phone_call: {
    description: "Prepare or confirm a user-initiated outbound phone call. Always prepare first to resolve the person and show a confirmation chip. Confirm only after the user presses Call.",
    category: "communication",
    sideEffectDefault: 2,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["prepare", "confirm"], description: "prepare resolves the person and requests confirmation; confirm dials using the one-time token" },
        query: { type: "string", description: "Person name or ID (required for prepare)" },
        confirmationToken: { type: "string", description: "One-time token returned by prepare (required for confirm)" },
        reasoning: { type: "string", description: "Why the call is being prepared or confirmed" },
      },
      required: ["action"],
    },
  },
  people: {
    description: "Personal contacts and import queue. Prefer quickSummary for current profile, notes for untimed evidence, interactions for time-bound events. set_vault_memberships is full-set replace (confirmReplace=true). Canonical @person:id.",
    category: "communication",
    sideEffectDefault: 1,
    sideEffectActions: {
      list: 0, get: 0, get_vault_memberships: 0, search: 0, agenda: 0, get_interactions: 0,
      scan_imports: 0, scan_ignored: 0, list_import_candidates: 0, get_import_candidate: 0,
      find_import_matches: 0, get_import_batch: 0,
    },

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "query", "get_many", "get", "get_vault_memberships", "add_vault_membership", "remove_vault_membership", "set_vault_memberships", "search", "agenda", "add_note", "update_note", "delete_note", "log_interaction", "get_interactions", "update_interaction", "delete_interaction", "create", "update", "merge", "scan_imports", "scan_ignored", "search_import_candidates", "list_import_candidates", "get_import_candidate", "find_import_matches", "add_import_candidate", "merge_import_candidate", "skip_import_candidate", "undo_import_decision", "preview_import_batch", "apply_import_batch", "get_import_batch"], description: "Action" },
        id: { type: "string", description: "Person ID or name (resolved automatically)" },
        query: { type: "string", description: "Person name or search term" },
        ids: { type: "array", items: { type: "string" }, description: "Person IDs for get_many (max 100)" },
        vaultId: { type: "string", description: "Vault ID for add_vault_membership/remove_vault_membership" },
        vaultIds: { type: "array", items: { type: "string" }, description: "Complete non-empty Vault ID set for set_vault_memberships" },
        confirmReplace: { type: "boolean", description: "Required true for set_vault_memberships because it replaces the complete membership set" },
        field: { type: "string", enum: ["id", "name", "email", "company", "role", "relation", "professionalRelations", "cabinetLevel", "tags", "introducedBy", "familiarity", "trust", "met", "lastInteractionDate", "createdAt", "updatedAt", "slackUserId"], description: "Field to filter for query action" },
        operator: { type: "string", enum: ["equals", "empty", "not_empty", "contains", "fuzzy", "in"], description: "Filter operator for query action" },
        value: { description: "Filter value for query action. Use string or string array for in." },
        fields: { type: "array", items: { type: "string" }, description: "Fields to return for query/get_many/list JSON projection. slackUserId is persons.social_profiles.slack (locator only)." },
        limit: { type: "number", description: "Max people to return for list/search/query (default 100 for query, max 500)" },
        offset: { type: "number", description: "Pagination offset for list/search/query" },
        format: { type: "string", enum: ["text", "json"], description: "Use json for structured list output" },
        content: { type: "string", description: "Supporting untimed context, evidence, history, or source detail (add_note/update_note). Use quickSummary for the concise current profile." },
        noteId: { type: "string", description: "Note ID (update_note/delete_note)" },
        interactionId: { type: "string", description: "Interaction ID (update_interaction/delete_interaction)" },
        title: { type: "string", description: "Note title (update_note)" },
        summary: { type: "string", description: "Interaction summary (log_interaction/update_interaction)" },
        type: { type: "string", enum: ["call", "text", "email", "in_person", "video", "social", "note"], description: "Interaction type (log_interaction/update_interaction)" },
        date: { type: "string", description: "Date YYYY-MM-DD (log_interaction)" },
        responseOwed: { type: "boolean", description: "Whether a response is still owed for this interaction — set false to clear the obligation (log_interaction/update_interaction)" },
        responseDueBy: { type: "string", description: "Date YYYY-MM-DD the owed response is due by (log_interaction/update_interaction)" },
        name: { type: "string", description: "Full name (create)" },
        email: { type: "string", description: "Primary email (create/update)" },
        cabinetLevel: { type: "string", enum: ["agent", "user", "family", "cabinet", "community", "network"], description: "Relationship tier (create)" },
        quickSummary: { type: "string", description: "Concise current profile shown in the UI (create/update). Prefer this for synthesized research or a compact description of who the person is." },
        newName: { type: "string", description: "New full name for the person (update rename; requires expectedCurrentName). The previous name is preserved as a nickname and denormalized name copies are synced." },
        expectedCurrentName: { type: "string", description: "Exact current name confirmation (required with newName for update rename)" },
        company: { type: "string", description: "Company (create)" },
        role: { type: "string", description: "Role/title (create)" },
        relation: { type: "string", description: "Personal/family relationship (create/update). One of the predefined values (Mother, Father, Spouse, Cousin, etc.)." },
        professionalRelations: { type: "array", items: { type: "string" }, description: "Professional relationships (create/update). Choose from: Partner, Investor, Advisor, Colleague, Employee, Vendor (Agent cannot set Customer)." },
        companyId: { type: "string", description: "Canonical Company ID to link this person to (create/update). Prefer this over the free-text company name so the profile renders a Company reference chip." },
        tags: { type: "array", items: { type: "string", description: "A tag label" }, description: "Cross-cutting tags (create/update)." },
        notes: { type: "string", description: "Supporting untimed context, evidence, history, or source detail (create). Do not use as the profile summary." },
        introducedBy: { type: "string", description: "Who introduced them (create)" },
        familiarity: { type: "string", enum: ["none", "surface", "deep"], description: "Familiarity level (create)" },
        trust: { type: "string", enum: ["ally", "positive", "none", "negative", "enemy"], description: "Trust level (create)" },
        slackUserId: { type: "string", description: "Slack User ID locator (U…) for create/update. Maps to persons.social_profiles.slack. Locator only — does not grant mapping, Session, or send. Omitted or blank is no write." },
        candidateId: { type: "string", description: "Import candidate ID for candidate actions" },
        personId: { type: "string", description: "Target Person ID for merge_import_candidate" },
        sourcePersonId: { type: "string", description: "Exact source Person ID to absorb (merge)" },
        targetPersonId: { type: "string", description: "Exact prime Person ID to preserve (merge)" },
        expectedSourceName: { type: "string", description: "Exact current source name confirmation (merge)" },
        expectedTargetName: { type: "string", description: "Exact current target name confirmation (merge)" },
        reason: { type: "string", description: "Auditable reason for the merge, minimum 8 characters (merge)" },
        decisionId: { type: "string", description: "Decision audit ID for undo_import_decision" },
        idempotencyKey: { type: "string", description: "Required replay-safe key for merge, import mutations, and batch apply" },
        decisions: { type: "array", items: { type: "object" }, description: "Batch decisions: [{ action: add|merge|skip, input: { candidateId, ... } }]" },
        batchId: { type: "string", description: "Import batch ID" },
        batchToken: { type: "string", description: "Immutable token returned by preview_import_batch" },
      },
      required: ["action"],
    },
  },
  jobs: {
    description: "Manage admin-only job role definitions used by future hiring plans and P&L headcount costs. Every field is available to query and edit: title, description, team, annual salary minimum/maximum, target annual performance or bonus compensation as a percentage of base salary, equity share count, and optional Scorecard Library page.",
    category: "work",
    sideEffectDefault: 1,
    sideEffectActions: { list: 0, get: 0 },
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "get", "create", "update", "delete"], description: "Action" },
        id: { type: "string", description: "Job role ID (required for get/update/delete)" },
        query: { type: "string", description: "Optional title, description, or team search for list" },
        limit: { type: "number", description: "Maximum roles to return for list (default 100, max 200)" },
        title: { type: "string", description: "Job title (required for create; optional sparse patch for update)" },
        description: { type: "string", description: "Job description" },
        team: { type: "string", enum: ["Executive", "Product", "Engineering", "Design", "Go-to-Market", "Customer Success", "Operations", "Finance", "People"], description: "Canonical seeded Team" },
        annualSalaryMin: { type: "number", description: "Annual base salary range minimum in whole dollars" },
        annualSalaryMax: { type: "number", description: "Annual base salary range maximum in whole dollars" },
        targetBonusPercent: { type: "number", description: "Target annual performance or bonus compensation as a percentage of base salary" },
        equityShareCount: { type: "number", description: "Equity share count" },
        scorecardPageId: { type: "string", description: "Library page ID or slug for the role Scorecard; null or clearFields clears it" },
        clearFields: { type: "array", items: { type: "string", enum: ["description", "scorecardPageId"] }, description: "Fields to explicitly clear during update. Supports description and scorecardPageId." },
      },
      required: ["action"],
    },
  },
  companies: {
    description: "Manage companies and company membership. Use canonical @company:id references.",
    category: "communication",
    sideEffectDefault: 1,
    sideEffectActions: { list: 0, get: 0 },
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "get", "create", "update", "delete", "add_person", "remove_person", "add_opportunity", "remove_opportunity"] },
        id: { type: "string", description: "Company ID or exact name" },
        query: { type: "string", description: "Company search query" },
        name: { type: "string", description: "Company name" },
        aliases: { type: "array", items: { type: "string" }, description: "Complete exact alternate-name set for canonical identity resolution (create/update). Updates replace active aliases; rename preserves the previous canonical name as an alias." },
        description: { type: "string", description: "Company description" },
        website: { type: "string", description: "Company website" },
        industry: { type: "string", description: "Company industry" },
        location: { type: "string", description: "Company location" },
        notes: { type: "string", description: "Company notes" },
        tags: { type: "array", items: { type: "string" }, description: "Company tags" },
        personId: { type: "string", description: "Person ID for add_person/remove_person" },
        opportunityId: { type: "number", description: "Opportunity ID for add_opportunity/remove_opportunity" },
      },
      required: ["action"],
    },
  },
  library: {
    description: "Vault-scoped Library pages and Notes. Shareable work belongs here, not scratch. Prefer edit_library_page for targeted edits; browse_tree/list_vaults for hierarchy. Canonical @page:slug.",
    category: "knowledge",
    sideEffectDefault: 1,
    sideEffectActions: {
      list_library_pages: 0, get_library_page: 0, search_library_pages: 0, search: 0,
      browse_tree: 0, tree: 0, list_vaults: 0, find_user_portrait: 0, list_notes: 0, get_note: 0,
    },

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list_library_pages", "get_library_page", "create_library_page", "update_library_page", "edit_library_page", "dismiss_library_page", "delete_library_page", "search_library_pages", "search", "browse_tree", "tree", "list_vaults", "find_user_portrait", "ensure_user_portrait", "link_pages", "annotate"], description: "Action" },
        id: { type: "string", description: "Page ID/slug" },
        title: { type: "string", description: "Title (create/update)" },
        plainTextContent: { type: "string", description: "Markdown content for pages (automatically converted to rich TipTap JSON and stored as the single source of truth)" },
        parentId: { type: ["string", "null"], description: "Destination parent page ID for update_library_page; null means the root of destinationVaultId" },
        destinationVaultId: { type: "string", description: "Explicit destination vault ID for update_library_page moves; required for cross-vault root moves" },
        vaultId: { type: "string", description: "Optional Vault ID filter for list, search, and browse_tree — restrict results to a single Vault. Use list_vaults to resolve Vault IDs." },
        canonicalFolder: { type: "string", enum: ["plans", "workflows", "specs", "skills"], description: "File the new page under the canonical per-Vault folder (create). Use 'specs' for specifications/implementation designs and 'skills' for skill run outputs, logs, and artifacts. Plans and Workflows are filed automatically by their producers. Ignored when parentId is supplied." },
        tags: { type: "array", items: { type: "string" }, description: "Tags for categorization (create/update)" },
        status: { type: "string", description: "Page status (create/update, e.g. draft, in-review, approved, implemented)" },
        surface: { type: "boolean", description: "Surface this page in Home/Simple Inbox when true with surfaceDurationHours; clear surfacing when false (create/update/edit/dismiss)" },
        surfaceDurationHours: { type: "number", description: "How many hours from now the page should stay surfaced; server computes surfaceUntil (create/update/edit)" },
        surfaceReason: { type: "string", description: "Optional reason/context for surfacing the page" },
        surfaceSection: { type: "string", description: "Optional surface section, defaults to inbox" },
        oneLiner: { type: "string", description: "One-line summary of the page (update_library_page)" },
        summary: { type: "string", description: "Multi-sentence summary of the page (update_library_page)" },
        query: { type: "string", description: "Search query (search actions)" },
        content: { type: "string", description: "Annotation text (annotate)" },
        annotationType: { type: "string", enum: ["observation", "connection", "confidence"], description: "Annotation type (annotate)" },

        fromPageId: { type: "string", description: "Source page ID (link_pages)" },
        toPageId: { type: "string", description: "Target page ID (link_pages)" },
        linkType: { type: "string", description: "Link type (link_pages)" },
        old_string: { type: "string", description: "Text to find in page content (edit_library_page)" },
        new_string: { type: "string", description: "Replacement text (edit_library_page)" },
        replace_all: { type: "boolean", description: "Replace all occurrences (edit_library_page, default false)" },
        limit: {
          type: "number",
          description:
            "Max pages to return for list/search actions (default 50, max 200)",
        },
      },
      required: ["action"],
    },
  },
  work: {
    description: "Manage projects and work status — create projects, list/get with tasks, manage files, milestones, goal links. Use `tasks` for individual task operations. Internal delivery and product work live here; commercial deals live on `exec` opportunities / Pipelines, not as work projects.",
    category: "work",
    sideEffectDefault: 1,
    sideEffectActions: { status: 0, list_projects: 0, get_project: 0, list_tasks: 0, read_file: 0 },

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create_project", "update_project", "set_status", "delete_project", "status", "list_projects", "get_project", "list_tasks", "set_goal", "add_file", "read_file", "remove_file", "add_milestone", "update_milestone", "remove_milestone"], description: "Action" },
        id: { type: "number", description: "Project ID" },
        title: { type: "string", description: "Project title (create_project)" },
        description: { type: "string", description: "Project description (create_project)" },
        priority: { type: "string", description: "Priority: high, mid, low" },
        ownerPersonId: { type: "string", description: "Accountability owner Person id (raw or @person:id). Omitted on create defaults to the cabinet user Person. me/agent are rejected." },
        tags: { type: "array", items: { type: "string" }, description: "Tags" },
        people: { type: "array", items: { type: "string" }, description: "People (create_project)" },
        status: { type: "string", enum: ["idea", "planning", "active", "on_hold", "completed"], description: "Project status (set_status) or status filter (list_projects)" },
        goalId: { type: ["string", "null"], description: "Goal ID (set_goal/create_project)" },
        blockedBy: { type: "array", items: { type: "string" }, description: "Optional prerequisite addresses projected into the Core blocked_by graph only (not a domain-row dependency field)" },
        fileId: { type: "string", description: "File ID (read_file/remove_file)" },
        fileName: { type: "string", description: "File name (add_file)" },
        fileMimeType: { type: "string", description: "MIME type (add_file)" },
        fileObjectKey: { type: "string", description: "Object storage key (add_file)" },
        fileSize: { type: "number", description: "File size (add_file)" },
        workspacePath: { type: "string", description: "Workspace file path to upload (add_file)" },
        milestoneId: { type: "number", description: "Milestone ID" },
        name: { type: "string", description: "Milestone name" },
        startDate: { type: "string", description: "Start date YYYY-MM-DD" },
        dueDate: { type: "string", description: "Due date YYYY-MM-DD" },
        milestoneStatus: { type: "string", description: "Milestone status: planned, active, completed" },
        order: { type: "number", description: "Display order" },
        clearFields: { type: "array", items: { type: "string" }, description: "Fields to explicitly clear (set to null). Allowed: description. (update_project)" },
        confirmDestructiveUpdate: { type: "boolean", description: "Required confirmation when clearing destructive fields like description (update_project)" },
        destructiveUpdateReason: { type: "string", description: "Reason for destructive clear — required with confirmDestructiveUpdate (update_project)" },
        taskStatus: { type: "string", enum: ["on_hold", "ready", "active", "done"], description: "Task status filter (list_tasks)" },
        limit: { type: "number", description: "Task page size (list_tasks, default 25, max 100)" },
        offset: { type: "number", description: "Task pagination offset (list_tasks, default 0, max 10000)" },
      },
      required: ["action"],
    },
  },
  tasks: {
    description: "Create, complete, delete, and update tasks.",
    category: "work",
    sideEffectDefault: 1,

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "complete", "delete", "update"], description: "Action" },
        title: { type: "string", description: "Task title (create/complete/delete/update — used for name lookup)" },
        description: { type: "string", description: "Task description (create/update)" },
        taskId: { type: "number", description: "Task ID (complete/delete/update)" },
        newTitle: { type: "string", description: "Rename task (update)" },
        status: { type: "string", description: "Status: on_hold, ready, active, done" },
        priority: { type: "string", description: "Priority: high, mid, low" },
        impact: { type: "string", description: "Impact: high, mid, low" },
        effort: { type: "string", description: "Effort: high, mid, low" },
        ownerPersonId: { type: "string", description: "Accountability owner Person id (raw or @person:id). Omitted on create defaults to the cabinet user Person. me/agent are rejected. Separate from assigneeSubject." },
        assigneeSubjectType: { type: ["string", "null"], enum: ["user", "invited_subject"], description: "Human assignee subject type. Use with assigneeSubjectId; assignment is separate from ownerPersonId." },
        assigneeSubjectId: { type: ["string", "null"], description: "Human assignee reference. For user, pass the User ID. For invited_subject, pass the recipient email; the server resolves or creates the global claimable subject." },
        requiresReview: { type: "boolean", description: "Requires review" },
        projectId: { type: "number", description: "Project ID to link" },
        milestoneId: { type: "number", description: "Required for create: positive milestone ID belonging to projectId. If the right milestone is unclear, find one or ask the user before creating the task." },
        deadline: { type: "string", description: "Deadline date (ISO string)" },
        blockedBy: { type: "array", items: { type: "string" }, description: "Optional prerequisite addresses projected into the Core blocked_by graph only (not a domain-row dependency field)" },
        clearFields: { type: "array", items: { type: "string" }, description: "Fields to explicitly clear (set to null). Allowed: description, assigneeSubjectType + assigneeSubjectId together, deadline. Project and milestone placement cannot be cleared. (update)" },
        confirmDestructiveUpdate: { type: "boolean", description: "Required confirmation when clearing destructive fields like description (update)" },
        destructiveUpdateReason: { type: "string", description: "Reason for destructive clear — required with confirmDestructiveUpdate (update)" },
      },
      required: ["action"],
    },
  },
  system: {
    description: "System operations — get system state snapshot, retrieve runtime logs, check budget, inspect principal-scoped reliability outcomes, rank principal-scoped tool-output pressure, list recent tool failures for pattern diagnosis, view current-process events, active runs, clear terminal zombie runs, connected accounts, and cumulative tool stats. A full log archive is available in the logs/ directory. Use log_files to list all available log files (with size and date). Use logs with the file parameter to read any historical log file by filename. For reliability, omit detail for the aggregate health summary; set detail='turn_failures' to list failed conversational turns or detail='tool_failures' to list individual failed tool calls in the window (tool failures are filterable by failureKind/tool/code).",
    category: "system",
    sideEffectDefault: 0,
    sideEffectActions: { save_history_rollup: 1 },

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["state", "logs", "log_files", "budget", "frontend_performance", "context_health", "reliability", "tool_output_pressure", "list_history_rollup_candidates", "save_history_rollup", "events", "active_runs", "clear_active_run", "accounts", "tool_stats"], description: "Action. Use log_files to list available log files; use logs to read a specific log file. tool_stats returns lifetime cumulative counters and does not support a time window." },
        limit: { type: "number", description: "Max entries to return (logs/events default 100; for reliability detail=tool_failures default 50, max 200)" },
        level: { type: "string", description: "Filter by log level: debug, info, warn, error (logs)" },
        source: { type: "string", description: "Filter by source module name (logs)" },
        file: { type: "string", description: "Log filename to read (logs). Use log_files action to list available files. If omitted, reads the current session log." },
        category: { type: "string", description: "Filter events by category (events)" },
        event: { type: "string", description: "Filter events by event name substring (events)" },
        runId: { type: "string", description: "Filter events by run ID (events) or run ID to clear (clear_active_run)" },
        reason: { type: "string", description: "Reason for clearing an active run (clear_active_run)" },
        provider: { type: "string", description: "Filter accounts by provider (accounts)" },
        hours: { type: "number", description: "Summary window in hours for frontend_performance/context_health/reliability/tool_output_pressure (default 24; max 720)" },
        offset: { type: "number", description: "Pagination offset for tool_output_pressure (default 0, max 5000)" },
        detail: { type: "string", enum: ["summary", "turn_failures", "tool_failures"], description: "Reliability detail mode (reliability). Omit or 'summary' for aggregate health; 'turn_failures' lists failed conversational turns with terminal/recovery metadata; 'tool_failures' lists individual failed tool calls." },
        failureKind: { type: "string", enum: ["input", "permission", "transient", "internal"], description: "Filter reliability tool_failures by structured failure kind (amber classes: permission/input/transient; internal is usually red)." },
        tool: { type: "string", description: "Filter reliability tool_failures by exact tool name (e.g. shell, git, scratch)." },
        code: { type: "string", description: "Filter reliability tool_failures by failure code when present (e.g. shell_policy_denied, scratch_edit_not_found)." },
        vaultId: { type: "string", description: "Visible Vault ID returned by list_history_rollup_candidates (save_history_rollup)." },
        rollupLevel: { type: "string", enum: ["hour", "day", "week", "month", "quarter", "year"], description: "Rollup level returned by list_history_rollup_candidates (save_history_rollup)." },
        timezone: { type: "string", description: "IANA timezone returned by list_history_rollup_candidates (save_history_rollup)." },
        bucketStart: { type: "string", description: "Exact ISO bucket start returned by list_history_rollup_candidates (save_history_rollup)." },
        sourceEntryIds: { type: "array", items: { type: "string" }, description: "Exact source entry IDs returned by list_history_rollup_candidates (save_history_rollup)." },
        summary: { type: "string", description: "Skill-authored chronology summary, 1-12000 characters (save_history_rollup)." },
      },
      required: ["action"],
    },
  },
  issues: {
    description: "Track product Issues — create, page unresolved tracked Issues, page the admin Reported queue with list_reported, fetch one by ID, resolve one with affirmative evidence, append a dated log entry with add_note, or permanently delete with confirm=true. Each add_note pushes an immutable, timestamped entry onto the Issue's append-only notes log (use get to read the full notes array back — e.g. to record what happened at each regression run). Create requires explicit reproSteps; platformEnvironmentId and buildId attach automatically from runtime identity when omitted. list never includes kind=reported; list_reported requires system:read and returns only reported Issues. delete requires confirm=true and is for intentional removal (e.g. Issue → Feature conversion), not ordinary resolution.",
    category: "system",
    sideEffectDefault: 1,
    sideEffectActions: { list: 0, list_reported: 0, get: 0, delete: 2 },

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "list", "list_reported", "get", "resolve", "add_note", "delete", "list_errors", "dismiss_error"], description: "Action" },
        id: { type: "string", description: "Issue ID (get/resolve/add_note/delete)" },
        fingerprint: { type: "string", description: "Aggregated error fingerprint — 64-char hex identity from list_errors (dismiss_error). Dismiss hides the error until it recurs; a new occurrence resurfaces it." },
        text: { type: "string", description: "Dated log entry text to append to the Issue's append-only notes log, 1-5000 characters (add_note)" },
        status: { type: "string", enum: ["open", "in_progress", "in_review", "resolved"], description: "Issue status filter (list, list_reported)" },
        excludeStatus: { type: "string", enum: ["open", "in_progress", "in_review", "resolved"], description: "Issue status to exclude (list, list_reported)" },
        offset: { type: "number", description: "Pagination offset (list, list_reported, default 0)" },
        limit: { type: "number", description: "Page size (list, list_reported, default 100, max 500)" },
        evidence: { type: "string", description: "Concise affirmative evidence note, 1-2000 characters (resolve)" },
        confirm: { type: "boolean", description: "Required true for delete permanent removal" },
        title: { type: "string", description: "Issue title (create)" },
        description: { type: "string", description: "Issue description (create)" },
        reproSteps: { type: "string", description: "Explicit reproduction steps — required for create; title-only shells are rejected" },
        platformEnvironmentId: { type: "number", description: "Platforms Environment ID (create; defaults from runtime identity when omitted)" },
        buildId: { type: "string", description: "Provider deployment/build ID (create; defaults from runtime identity when omitted)" },
      },
      required: ["action"],
    },
  },
  hooks: {
    description: "Manage event hooks — create, list, get, update, delete, and test reactive hooks that fire actions when system events match patterns.",
    category: "system",
    sideEffectDefault: 1,
    sideEffectActions: { list: 0, get: 0 },

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "get", "create", "update", "delete", "test"], description: "Action" },
        id: { type: "number", description: "Hook ID (get, update, delete, test)" },
        name: { type: "string", description: "Hook name (get by name, or create/update)" },
        description: { type: "string", description: "Hook description (create/update)" },
        eventPattern: { type: "string", description: "Glob-style event pattern, e.g., 'chat.*' or 'chat.autonomous.completed' (create/update)" },
        condition: { type: "object", description: "Optional payload field conditions (AND logic), e.g., {\"skillName\": \"triage\"} (create/update)" },
        actionType: { type: "string", enum: ["run_skill", "initiate_conversation", "tool_call"], description: "Action type (create/update)" },
        actionConfig: { type: "object", description: "Action configuration with optional {{payload.field}} templates (create/update)" },
        cooldownSeconds: { type: "number", description: "Minimum seconds between firings (create/update, default 0)" },
        enabled: { type: "boolean", description: "Whether hook is active (create/update, default true)" },
        maxFirings: { type: "number", description: "Max times this hook can fire before auto-disabling (create/update, default null = unlimited). Set to 1 for one-shot hooks." },
        eventId: { type: "string", description: "Event ID to test against (test)" },
        testEvent: { type: "string", description: "Synthetic event name for testing (test)" },
        testPayload: { type: "object", description: "Synthetic payload for testing (test)" },
      },
      required: ["action"],
    },
  },
  notion: {
    description: "Search, read, and browse Notion pages and databases.",
    category: "knowledge",
    sideEffectDefault: 0,

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "search", "get_page", "get_content", "list_databases", "query_database"], description: "Action" },
        query: { type: "string", description: "Search term" },
        id: { type: "string", description: "Page or Database ID" },
        account: { type: "string", description: "Notion account label (optional)" },
        limit: { type: "number", description: "Max results (default 10-20)" },
      },
      required: ["action"],
    },
  },
  gmail: {
    description: "Read, search, and draft emails via Gmail. Supports multiple accounts. Before composing a draft or reply body, follow the current user's active canonical writing-style instruction and load its referenced Library page when configured; complete the standard's required style checks before invoking Gmail. Gmail persists the supplied body verbatim and does not rewrite prose. When the user asks to draft a reply, use reply with the canonical @email_thread or @email_message ref; reply resolves the recipient and subject and persists native Gmail thread metadata. Use draft only for new standalone emails. Use draft, reply, or update_draft so persisted drafts render as inline widgets; plain chat email text is only for brainstorming or explicit copy-only requests. For update_draft, provide exactly one populated body operation and omit the other two. Empty placeholder objects are ignored. The human sends via the widget's Send button. There is no tool-level send action.",
    category: "communication",
    sideEffectDefault: 0,
    sideEffectActions: { draft: 1 },
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "Action" },
        query: { type: "string", description: "Search query (search, batch_read)" },
        id: { type: "string", description: "Message ID (read)" },
        draft_id: { type: "string", description: "Persisted email draft ID (required for update_draft)" },
        ids: { type: "array", items: { type: "string" }, description: "Array of message IDs (batch_read)" },
        excludeMessageIds: { type: "array", items: { type: "string" }, description: "Message IDs to skip (batch_read)" },
        to: { type: "string", description: "Recipient email (draft)" },
        update_to: { type: "array", items: { type: "string" }, description: "Non-empty To recipients (update_draft)" },
        update_cc: { type: "array", items: { type: "string" }, description: "Non-empty CC recipients (update_draft)" },
        update_bcc: { type: "array", items: { type: "string" }, description: "Non-empty BCC recipients (update_draft)" },
        subject: { type: "string", description: "Email subject" },
        body: { type: "string", description: "Email body (draft or reply creation only)" },
        ref: { type: "string", description: "Canonical @email_thread or @email_message reference (required for reply; also used by email_cache resolve)" },
        findReplace: { type: "object", properties: { find: { type: "string", description: "Exact text to find" }, replace: { type: "string", description: "Replacement text; may be empty to delete the match" }, replaceAll: { type: "boolean", description: "Replace every exact match; defaults false and rejects ambiguous matches" } }, required: ["find", "replace"], description: "Optional exact body edit for update_draft. Mutually exclusive with rangePatch and replaceBody; omit when unused." },
        rangePatch: { type: "object", properties: { start: { type: "number", description: "Zero-based inclusive character offset" }, end: { type: "number", description: "Zero-based exclusive character offset" }, replacement: { type: "string", description: "Replacement text; may be empty to delete the range" }, expectedBodyHash: { type: "string", description: "SHA-256 hash of the current draft body; stale hashes are rejected" } }, required: ["start", "end", "replacement", "expectedBodyHash"], description: "Optional guarded body range edit for update_draft. Mutually exclusive with findReplace and replaceBody; omit when unused." },
        replaceBody: { type: "object", properties: { body: { type: "string", description: "Complete replacement body" }, clear: { type: "boolean", description: "Set true to explicitly clear the body when body is empty" } }, required: ["body"], description: "Optional explicit whole-body replacement for update_draft. Mutually exclusive with findReplace and rangePatch; omit when unused. Empty placeholder objects are ignored; clearing requires clear=true." },
        maxResults: { type: "number", description: "Max results (default 100 for batch_read)" },
        account: { type: "string", description: "Target account label or email" },
        attachmentId: { type: "string", description: "Attachment ID (download_attachment)" },
        fileName: { type: "string", description: "Override filename (download_attachment)" },
        triage_action: { type: "string", description: "Sub-action for triage_log: 'get_triaged_ids' (default, reads live email_messages triage state plus legacy log rows) or 'record'" },
        sinceHours: { type: "number", description: "Hours to look back for triaged IDs from live email_messages and legacy triage logs (default 168 / 7 days)" },
        entries: { type: "array", items: { type: "object", properties: { gmailMessageId: { type: "string" }, accountId: { type: "string" }, tier: { type: "string" }, senderEmail: { type: "string" }, subject: { type: "string" }, cachedMessageId: { type: "number" }, cacheId: { type: "number" }, reason: { type: "string" } }, required: ["tier"] }, description: "Triage entries to record (triage_log record or mark_triaged)" },
        cache_action: { type: "string", description: "Sub-action for email_cache: 'get_untriaged' (fetch untriaged cached emails), 'mark_triaged' (mark cached emails as triaged), 'get_unenriched' (fetch triaged emails that haven't been enriched yet), 'store_enrichment' (store enrichment data for a thread), 'search' (search cached emails by query), 'resolve' or 'get_thread' (resolve @email_thread/@email_message refs to cached thread/messages), 'sync_status' (check sync health), 'pipeline_counts' (raw pipeline counts from DB), 'get_message' (raw email_messages row by message_id with enrichment status), 'diagnose' (compare pipeline counts vs unenriched query for divergence), 'run_downstream' (manually run triage + enrichment pipeline)" },
        limit: { type: "number", description: "Max results for email_cache get_untriaged (default 200, max 500) or search (default 20, max 100)" },
        thread_id: { type: "string", description: "Provider thread ID (store_enrichment or email_cache get_thread/resolve)" },

        account_id: { type: "string", description: "Account ID (store_enrichment)" },
        message_id: { type: "number", description: "Cached message ID (store_enrichment)" },
        summary: { type: "string", description: "Enrichment summary of the thread (store_enrichment)" },
        decisions: { type: "array", items: { type: "string" }, description: "Key decisions identified in the thread (store_enrichment)" },
        actions: { type: "array", items: { type: "string" }, description: "Action items identified in the thread (store_enrichment)" },
        dismissed: { type: "boolean", description: "Whether to dismiss this thread (store_enrichment)" },
        dismiss_reason: { type: "string", description: "Reason for dismissing the thread (store_enrichment)" },
        days: { type: "number", description: "Number of days to look back for search (default 7, max 90)" },
      },
      required: ["action"],
    },
  },
  content: {
    description: "Social content queue and live X/Twitter actions: queue drafts, list queue, suggest times, and post/reply/lookup/delete/news when connected.",
    category: "communication",
    sideEffectDefault: 1,
    sideEffectActions: {
      list: 0, suggest_times: 0, x_status: 0, x_lookup: 0, x_news_search: 0, x_news_lookup: 0,
      x_post: 2, x_reply: 2, x_delete: 2,
    },
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["queue_draft", "list", "suggest_times", "x_status", "x_post", "x_reply", "x_lookup", "x_delete", "x_news_search", "x_news_lookup"], description: "Queue, schedule, or live X action" },
        platform: { type: "string", description: "Platform (default: x)" },
        content: { type: "string", description: "Post text (queue_draft)" },
        threadParts: { type: "array", items: { type: "string" }, description: "Thread parts (queue_draft)" },
        metadata: { type: "object", description: "Optional metadata (queue_draft)" },
        status: { type: "string", description: "Queue status filter (list)" },
        count: { type: "number", description: "Time suggestions count (suggest_times, default 7)" },
        startDate: { type: "string", description: "Start ISO 8601 (suggest_times)" },
        endDate: { type: "string", description: "End ISO 8601 (suggest_times)" },
        limit: { type: "number", description: "Max results (list, default 20)" },
        text: { type: "string", description: "Tweet text (x_post/x_reply)" },
        tweet_id: { type: "string", description: "Tweet ID or URL (x_reply/x_lookup/x_delete)" },
        query: { type: "string", description: "Search query (x_news_search)" },
        max_results: { type: "string", description: "Max results (x_news_search)" },
        article_id: { type: "string", description: "X News/Grok Story ID (x_news_lookup)" },
      },
      required: ["action"],
    },
  },
  meetings: {
    description: "Manage calendar events, create bounded focus blocks, dispatch the live meeting bot, and query completed meeting records. Action add creates an editable Meeting Draft inline widget; only the authenticated human can approve and schedule it. Direct calendar update/delete, create_calendar_block, and meeting-bot join/leave remain independently authorization-gated.",
    category: "calendar",
    sideEffectDefault: 0,
    sideEffectActions: { add: 1, update: 2, delete: 2, create_calendar_block: 2, join: 2, leave: 2 },

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "list", "update", "delete", "create_calendar_block", "join", "status", "diagnostics", "recap", "leave", "set_metadata", "get_metadata", "link_artifact", "unlink_artifact", "records", "count", "get"], description: "Action. Use records/count/get for canonical completed meeting sessions and note totals." },
        summary: { type: "string", description: "Meeting title (add/update)" },
        start: { type: "string", description: "Start time ISO 8601 (required for add)" },
        end: { type: "string", description: "End time ISO 8601 (default: +1h)" },
        description: { type: "string", description: "Description (add/update)" },
        location: { type: "string", description: "Location (add/update)" },
        attendees: { type: "array", items: { type: "string", description: "Email" }, description: "Attendee emails (add/update)" },
        eventId: { type: "string", description: "Event ID (required for update/delete/set_metadata/get_metadata)" },
        from: { type: "string", description: "Range start ISO 8601 (list, default: now)" },
        to: { type: "string", description: "Range end ISO 8601 (list, default: +7d)" },
        limit: { type: "number", description: "Max events (list, default 20)" },
        accountId: { type: "string", description: "Google account ID" },
        calendarId: { type: "string", description: "Calendar ID (default: primary)" },
        visibility: { type: "string", enum: ["default", "public", "private", "confidential"], description: "Event visibility (add/update). default = calendar default, public = visible to all, private = only attendees, confidential = shows as busy to others" },
        googleEventId: { type: "string", description: "Google Calendar event ID (set_metadata/get_metadata)" },
        eventType: { type: "string", enum: ["focus_block", "exercise", "meeting", "planning", "admin", "personal"], description: "Event type classification (set_metadata)" },
        notes: { type: "string", description: "Optional notes for the event metadata (set_metadata)" },
        agendaLibraryPageId: { type: "string", description: "Library page ID or slug to claim as the meeting's single canonical preparation page (set_metadata). Once claimed, update that page instead of linking another agenda or brief." },
        sharedRoom: { type: "boolean", description: "Whether this meeting uses one shared physical room and needs acoustic speaker diarization (set_metadata)" },
        sharedAudioAttendeeEmail: { type: "string", description: "Deprecated compatibility input: any non-empty value enables sharedRoom; null disables it (set_metadata)" },
        metadataId: { type: "number", description: "Metadata record ID (link_artifact)" },
        linkId: { type: "number", description: "Artifact link record ID to remove (unlink_artifact)" },
        libraryPageId: { type: "string", description: "Library page ID or slug to link as a meeting artifact (link_artifact)" },
        artifactKind: { type: "string", description: "Required explicit artifact kind for link_artifact. Use research, follow_up, recap, or another non-preparation kind. Agenda/brief calls resolve or claim the canonical preparation page and cannot replace it." },
        attendeeEmails: { type: "array", items: { type: "string" }, description: "Attendee emails for auto-linking people (set_metadata)" },
        meetingId: { type: "string", description: "Canonical meeting session ID (get)" },
        timeZone: { type: "string", description: "IANA time zone for start/end (create_calendar_block; default America/Chicago)" },
        url: { type: "string", description: "Zoom or Google Meet URL (join). Omit to resolve from the calendar." },
        title: { type: "string", description: "Optional meeting session title (join). Defaults to the calendar event summary or 'Meeting'." },
        sessionId: { type: "string", description: "Meeting session ID (status, leave, or recap)" },
        query: { type: "string", description: "Search completed meeting titles and participant names or emails (records)" },
        notesFilter: { type: "string", enum: ["any", "with_notes", "without_notes"], description: "Optional transcript-note filter for records. Omit or use any to search all completed meetings." },
        startAfter: { type: "string", description: "Inclusive meeting start boundary ISO 8601 (records)" },
        startBefore: { type: "string", description: "Exclusive meeting start boundary ISO 8601 (records)" },
        offset: { type: "number", description: "Pagination offset for completed meeting records" },
      },
      required: ["action"],
    },
  },
  git: {
    description: "Interact with Git repositories. Normal clone takes no routing inputs and resolves the canonical Mantra / Web / stage source binding; clone + platformEnvironmentId or clone_from_environment targets one Platform Environment through the same resolver. Write actions only work on session-owned clones in repos/.",
    category: "work",
    sideEffectDefault: 0,
    sideEffectActions: { clone: 1, add: 1, commit: 1, push: 2, create_pr: 2 },

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["clone", "clone_from_environment", "pull", "status", "log", "diff", "branch", "checkout", "show", "add", "commit", "push", "create_pr", "merge_pr", "delete_branch"], description: "Action. Bare clone uses the canonical Mantra / Web / stage source binding; clone + platformEnvironmentId or clone_from_environment selects that environment." },
        platformEnvironmentId: { type: "number", description: "Optional on clone and required on clone_from_environment. When present and positive, resolves that Platform Environment source binding instead of the canonical stage default." },
        directory: { type: "string", description: "Omit to use the sole repository clone owned by this session. If multiple session clones exist, pass the directory name returned by clone. Use \".\" or \"self\" only for read-only inspection of the workspace root repo." },
        branch: { type: "string", description: "Branch name" },
        ref: { type: "string", description: "Git ref (show/checkout)" },
        ref1: { type: "string", description: "First ref (diff)" },
        ref2: { type: "string", description: "Second ref (diff)" },
        file: { type: "string", description: "File path (diff/checkout)" },
        count: { type: "number", description: "Log entries (default 20)" },
        grep: { type: "string", description: "Filter log by message" },
        branchAction: { type: "string", enum: ["list", "create", "switch"], description: "Branch sub-action" },
        name: { type: "string", description: "Branch name (create/switch)" },
        files: { type: "array", items: { type: "string" }, description: "File paths to stage (add). Use [\".\"] for all changes." },
        message: { type: "string", description: "Commit message (commit)" },
        title: { type: "string", description: "PR title (create_pr)" },
        body: { type: "string", description: "PR description in markdown (create_pr)" },
        base: { type: "string", description: "Base branch for PR (create_pr, default: main)" },
        draft: { type: "boolean", description: "Create as draft PR (create_pr, default: false)" },
        force: { type: "boolean", description: "Force push (push, default: false)" },
        pr_number: { type: "number", description: "PR number (checkout or merge_pr)" },
        merge_method: { type: "string", enum: ["merge", "squash", "rebase"], description: "Merge method (merge_pr, default: squash)" },
        commit_title: { type: "string", description: "Custom merge commit title (merge_pr)" },
        commit_message: { type: "string", description: "Custom merge commit message (merge_pr)" },
      },
      required: ["action"],
    },
  },
  scenarios: {
    description: "Scenario modeling — create scenarios, manage actors, build move trees, run simulations, manage assumptions, track artifacts. Always call list_scenarios first.",
    category: "strategy",
    sideEffectDefault: 1,
    sideEffectActions: {
      list_scenarios: 0, get_scenario: 0, get_move_tree: 0, get_move: 0, get_move_path: 0,
      list_actors: 0, get_actor: 0, list_child_moves: 0, list_assumptions: 0,
      list_end_conditions: 0, list_notes: 0, list_context: 0, list_artifacts: 0,
      get_artifact: 0, list_move_definitions: 0, get_move_definition: 0, list_states: 0, get_state: 0,
    },

    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "list_scenarios", "get_scenario", "create_scenario", "update_scenario", "delete_scenario",
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
          description: "Action — see tool description for required params per action",
        },
        goalId: { type: "string", description: "Scenario ID — REQUIRED for most actions. Call list_scenarios first to get available goalIds." },
        id: { type: "string", description: "Entity ID (actor, move, assumption, end condition, note, artifact, or simulation run)" },
        moveId: { type: "string", description: "Move instance ID or refId (short hash like 'emo1Jg')" },
        assumptionId: { type: "string", description: "Assumption ID (link/unlink_assumption_to_move)" },
        parentMoveInstanceId: { type: "string", description: "Parent move instance ID (null for root)" },
        parentId: { type: "string", description: "Parent move instance ID (required for list_child_moves)" },
        newParentId: { type: "string", description: "New parent move instance ID for reparent_move (null or omit to move to root)" },
        actorId: { type: "string", description: "Actor ID" },
        moveDefinitionId: { type: "string", description: "Move definition ID (REQUIRED for create_move — use list_move_definitions to find one, or create_move_definition first)" },
        title: { type: "string", description: "Title for scenario, move, or assumption" },
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
    description: "Personal decision log — open Decisions are live working surfaces. Open path: create → append (or update replace) Data/Scenarios/Plan → add_link. Close this same row with lock (outcome/description, trafficLight, reasoning, optional provenance). Closed path only: add_update changelog. record_judgment mints a NEW closed judgment only when the USER decided something consequential that is part of a broad pattern worth saving — never for every Question, UI nit, or reversible local fork, and never to close an open row the room already owns. Find: search, list_for_target (any address add_link accepts). Always list or search before mutating if the id is not in hand.",
    category: "strategy",
    sideEffectDefault: 1,
    sideEffectActions: { list: 0, get: 0, search: 0, list_for_target: 0 },
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "get", "search", "list_for_target", "create", "update", "append", "delete", "lock", "reopen", "add_update", "edit_update", "delete_update", "add_link", "remove_link", "record_judgment"],
          description: "Action",
        },
        id: { type: "string", description: "Decision ID" },
        updateId: { type: "string", description: "Decision update ID (edit_update / delete_update)" },
        linkId: { type: "string", description: "Decision link ID (remove_link)" },
        title: { type: "string", description: "Decision title (create/update/record_judgment)" },
        description: { type: "string", description: "Short description / outcome text (create/update/lock/record_judgment)" },
        answer: { type: "string", description: "The chosen answer. Required to lock an open Decision from the UI. create/update/lock persist it on the same row." },
        vaultId: { type: "string", description: "Single owning Vault ID (create/update). Omitted create stamps the active Vault." },
        status: { type: "string", enum: ["open", "closed", "all"], description: "Filter for list/search" },
        query: { type: "string", description: "Non-empty text search over title, description, sections, reasoning (search)" },
        limit: { type: "number", description: "Max search results (default 20, max 50)" },
        trafficLight: { type: "string", enum: ["green", "yellow", "red"], description: "Traffic-light status (lock, or update on closed decisions)" },
        dataContent: { type: "string", description: "Markdown for the Data section (create/update replace; append concatenates)" },
        scenariosContent: { type: "string", description: "Markdown for the Scenarios section (create/update replace; append concatenates)" },
        planContent: { type: "string", description: "Markdown for the Plan section (create/update replace; append concatenates)" },
        content: { type: "string", description: "Update entry text (add_update / edit_update — closed only)" },
        targetAddress: { type: "string", description: "Canonical link or reverse-lookup target, e.g. @person:id, @project:id, @strategy:id, @page:uuid" },
        targetType: { type: "string", description: "Compatibility input: canonical target type" },
        targetId: { type: "string", description: "Compatibility input: target ID" },
        predicate: { type: "string", enum: ["relates_to", "governs", "guided_by", "governed_by", "decided_by", "evidence_for", "triggered_by", "produced"], description: "Explicit Decision relationship predicate (defaults to relates_to)" },
        reasoning: { type: "string", description: "Why this judgment was made (lock / record_judgment)" },
        ownerPersonRole: { type: "string", enum: ["self", "partner"], description: "Judgment owner role: self=agent, partner=user (lock / record_judgment)" },
        principleRevisionIds: { type: "array", items: { type: "string" }, description: "Current principle revision IDs that governed this judgment (lock / record_judgment)" },
        sourceSessionId: { type: "string", description: "Source session for replay-safe judgment provenance (lock / record_judgment)" },
        sourceToolCallId: { type: "string", description: "Source tool call for replay-safe judgment provenance (lock / record_judgment)" },
        triggeredByAddress: { type: "string", description: "Canonical address that triggered the judgment, e.g. @question:sessionId:toolCallId (lock / record_judgment)" },
        answerPayload: { type: "object", description: "Structured answer payload for the judgment (lock / record_judgment)" },
      },
      required: ["action"],
    },
  },
  exec: {
    description: "Manage career Exec data and the commercial Opportunities Pipeline (UI: Pipelines). Skills inventory, experience log, verified metrics/education, opportunity artifacts, and revenue/career deals only. An Opportunity is an external commercial pursuit with a counterparty — job, consulting engagement, business venture, passive income stream, customer, or partner. Never create opportunities for internal project work, delivery plans, product ideas, implementation tracks, or work pipelines; those belong on `work`/`tasks`/`plan`.",
    category: "knowledge",
    sideEffectDefault: 1,
    sideEffectActions: {
      list_skills: 0, get_skill: 0, list_experience: 0, get_experience: 0,
      list_opportunities: 0, get_opportunity: 0, list_opportunity_activities: 0,
      list_passions: 0, get_passion: 0, list_metrics: 0, list_education: 0,
      get_opportunity_artifacts: 0,
    },
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list_skills", "get_skill", "create_skill", "update_skill", "delete_skill", "list_experience", "get_experience", "create_experience", "update_experience", "delete_experience", "list_opportunities", "get_opportunity", "create_opportunity", "update_opportunity", "delete_opportunity", "list_opportunity_activities", "create_or_link_opportunity_activity", "update_opportunity_activity", "unlink_opportunity_activity", "list_passions", "get_passion", "create_passion", "update_passion", "delete_passion", "list_metrics", "create_metric", "update_metric", "delete_metric", "list_education", "create_education", "update_education", "delete_education", "set_artifact", "get_opportunity_artifacts", "render_artifact_docx"], description: "Action. create_opportunity is only for external commercial deals in the Pipelines UI — never internal project or delivery work." },

        id: { type: "number", description: "Skill or experience ID (get/update/delete)" },
        name: { type: "string", description: "Skill name (required for create_skill)" },
        category: { type: "string", enum: ["technical", "business", "creative", "interpersonal", "domain"], description: "Skill category" },
        skillType: { type: "string", enum: ["foundational", "applied", "tool", "domain"], description: "Skill type section: foundational (base capabilities), applied (produce deliverables), tool (specific technologies), domain (accumulated field knowledge)" },
        proficiency: { type: "string", enum: ["novice", "developing", "competent", "proficient", "expert"], description: "Proficiency level" },
        energyLevel: { type: "string", enum: ["draining", "neutral", "energizing", "flow"], description: "Energy level" },
        domain: { type: "string", description: "Experience domain (required for create_experience)" },
        narrative: { type: "string", description: "Experience narrative" },
        years: { type: "number", description: "Years of experience" },
        startDate: { type: "string", description: "Start date YYYY-MM format (experience)" },
        endDate: { type: "string", description: "End date YYYY-MM format, null for present (experience)" },
        keyOutcomes: { type: "array", items: { type: "string" }, description: "Key outcomes" },
        transferableAssets: { type: "array", items: { type: "string" }, description: "Transferable assets" },
        title: { type: "string", description: "Commercial opportunity title (required for create_opportunity). Name the deal or counterparty pursuit, not an internal workstream." },
        description: { type: "string", description: "Commercial opportunity description — external deal context only, not project scope notes" },
        type: { type: "string", enum: ["job", "consulting", "business", "passive_income", "customer", "partner"], description: "Commercial opportunity type (required for create_opportunity). job/consulting/business/passive_income/customer/partner only — never use create_opportunity for internal projects or delivery pipelines." },
        status: { type: "string", enum: ["discovered", "qualified", "researched", "pursuing", "active", "passed", "lost"], description: "Commercial pipeline status for an external opportunity" },

        probability: { type: "number", description: "Probability 0-1 (opportunities)" },
        isFullTime: { type: "boolean", description: "Whether opportunity is full time" },
        hoursPerWeek: { type: "number", description: "Hours per week commitment" },
        timeCommitmentPeriod: { type: "string", enum: ["week", "month"], description: "Time commitment period" },
        timeHorizonMonths: { type: "number", description: "Months until income starts" },
        evInputs: { type: "object", description: "Type-specific EV inputs (e.g. {annualComp: 150000} for job, {rate: 200, hoursPerWeek: 20, durationMonths: 6} for consulting)" },
        company: { type: "string", description: "Company name (experience; legacy fallback for opportunities)" },
        companyId: { type: "string", description: "Company ID for create/update_opportunity; use the canonical @company:id target" },
        location: { type: "string", description: "Location (e.g. 'Remote', city name)" },
        teamSizePeak: { type: "number", description: "Peak team size (experience)" },
        directReports: { type: "number", description: "Number of direct reports (experience)" },
        pnlOwned: { type: "string", description: "P&L ownership scope (experience)" },
        budgetManaged: { type: "string", description: "Budget managed scope (experience)" },
        fundingRaised: { type: "string", description: "Total funding raised (experience)" },
        companyContext: { type: "string", description: "Company context/description (experience)" },
        nextSteps: { type: "string", description: "Next steps for this opportunity" },
        priority: { type: "string", enum: ["high", "mid", "low"], description: "Opportunity priority" },
        contactPersonId: { type: "string", description: "People person ID for contact" },
        sourceType: { type: "string", enum: ["manual", "landscape", "referral"], description: "How opportunity was sourced" },
        sourceSignalId: { type: "string", description: "Landscape signal ID if sourced from signal" },
        requiredSkills: { type: "array", items: { type: "string" }, description: "Skills required for this opportunity" },
        statusFilter: { type: "string", description: "Filter opportunities by status (list_opportunities)" },
        typeFilter: { type: "string", description: "Filter opportunities by type (list_opportunities)" },
        tier: { type: "string", enum: ["mission", "value", "exploration"], description: "Passion tier (required for create_passion)" },
        content: { type: ["string", "object"], description: "Passion content text (create_passion) or structured artifact content (render_artifact_docx)" },
        sourceRef: { type: "string", description: "Source reference for passion (optional)" },
        position: { type: "number", description: "Display order position (passions)" },
        jdText: { type: "string", description: "Job description text (to store on an opportunity)" },
        jobUrl: { type: "string", description: "URL of the job posting (opportunities)" },
        vaultId: { type: ["string", "null"], description: "Optional Vault ID for an opportunity. Pass null to unassign it." },
        championPersonId: { type: "string", description: "People person ID for the champion/key contact at this opportunity (create/update_opportunity)" },
        followUpBy: { type: "string", description: "Follow-up deadline date YYYY-MM-DD (create/update_opportunity)" },
        followUpNote: { type: "string", description: "Note about what the follow-up should cover (create/update_opportunity)" },
        format: { type: "string", enum: ["headline", "cv"], description: "Resume format: headline (1 page) or cv (full). Default: headline" },
        libraryPageId: { type: "string", description: "Library page ID/slug to link as artifact (set_artifact; pass null to clear)" },
        opportunityId: { type: "number", description: "Opportunity ID for artifacts or activity association actions" },
        associationId: { type: "number", description: "Opportunity activity association ID (update/unlink activity)" },
        personId: { type: "string", description: "Person ID for an opportunity activity" },
        interactionId: { type: "string", description: "Existing Person interaction ID to link instead of creating a duplicate" },
        date: { type: "string", description: "Interaction date YYYY-MM-DD" },
        summary: { type: "string", description: "Interaction summary" },
        direction: { type: "string", enum: ["inbound", "outbound", "mutual"], description: "Interaction direction" },
        meaningfulness: { type: "string", enum: ["high", "medium", "low"], description: "Interaction meaningfulness" },
        responseOwed: { type: "boolean", description: "Whether a response is owed" },
        responseDueBy: { type: "string", description: "Response due date YYYY-MM-DD" },
        capitalImpact: { type: "string", enum: ["deposit", "withdrawal", "neutral"], description: "Relationship capital impact" },
        tags: { type: "array", items: { type: "string" }, description: "Interaction tags" },
        experienceId: { type: "number", description: "Experience ID for metrics" },
        metric: { type: "string", description: "Metric name" },
        value: { type: "string", description: "Metric value" },
        institution: { type: "string", description: "Education institution" },
        degree: { type: "string", description: "Education degree" },
        field: { type: "string", description: "Education field" },
        year: { type: "string", description: "Education year" },
        notes: { type: "string", description: "Education notes" },
        kind: { type: "string", description: "Artifact kind: resume, cover_letter, or research (set_artifact/render_artifact_docx)" },
        fileName: { type: "string", description: "Optional DOCX filename" },
      },
      required: ["action"],
    },
  },
  theses: {
    description: "Manage theses — hard-to-vary explanations backed by evidence and tested by predictions.",
    category: "knowledge",
    sideEffectDefault: 2,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "get", "create", "update", "delete", "add_evidence", "update_evidence", "remove_evidence", "add_prediction", "resolve_prediction", "remove_prediction"], description: "Action" },
        id: { type: "string", description: "Thesis ID (get/update/delete/add_evidence/add_prediction)" },
        title: { type: "string", description: "Thesis title (create/update)" },
        statement: { type: "string", description: "The hard-to-vary claim (create/update)" },
        tags: { type: "array", items: { type: "string" }, description: "Freeform tags (create/update)" },
        status: { type: "string", enum: ["draft", "active", "superseded", "invalidated", "all"], description: "Status (create/update/list filter)" },
        conviction: { type: "string", enum: ["low", "high"], description: "Conviction level — binary stance (create/update)" },
        successorId: { type: "string", description: "Successor thesis ID (update when superseding)" },
        content: { type: "string", description: "Evidence summary text (add_evidence/update_evidence)" },
        sourceUrl: { type: "string", description: "Evidence source URL (add_evidence/update_evidence)" },
        position: { type: "number", description: "Evidence display order (add_evidence/update_evidence)" },
        evidenceId: { type: "string", description: "Evidence ID (update_evidence/remove_evidence)" },
        claim: { type: "string", description: "Prediction claim (add_prediction)" },
        deadline: { type: "string", description: "Prediction deadline YYYY-MM-DD (add_prediction)" },
        outcome: { type: "string", enum: ["pending", "correct", "incorrect", "expired"], description: "Prediction outcome (resolve_prediction)" },
        predictionId: { type: "string", description: "Prediction ID (resolve_prediction/remove_prediction)" },
        resolutionNotes: { type: "string", description: "Optional notes explaining prediction resolution (resolve_prediction)" },
      },
      required: ["action"],
    },
  },
  news: {
    description: "Manage the News system — signal discovery, surfaced items, sources, topics, diagnostics, and scan runs. Actions: summary (health + counts + latest surfaced), scan, list_signals, get_signal, dismiss_signal, save_signal, surface_signal, add_source, list_sources, update_source, delete_source, list_scan_runs, interest_graph, batch_curate.",
    category: "knowledge",
    sideEffectDefault: 1,
    sideEffectActions: {
      summary: 0, list_signals: 0, get_signal: 0, list_sources: 0, list_scan_runs: 0, interest_graph: 0,
    },
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["summary", "scan", "list_signals", "get_signal", "dismiss_signal", "save_signal", "surface_signal", "add_source", "add_topic", "list_sources", "update_source", "delete_source", "list_scan_runs", "interest_graph", "batch_curate"], description: "Action" },
        decisions: { type: "array", description: "Array of curation decisions (batch_curate). Each: { fingerprint, isRelevant, score, title, reason, matchedTopics, summary? }", items: { type: "object" } },
        id: { type: "string", description: "Signal or source ID (get_signal, dismiss_signal, save_signal, surface_signal, update_source, delete_source)" },
        source_type: { type: "string", enum: ["channel_x", "channel_web", "x", "web", "x_account", "reddit", "rss", "subreddit", "rss_feed", "pinned_topic", "hackernews", "github_repo", "polymarket", "stocktwits", "arxiv", "youtube_channel"], description: "Optional source type. For list_signals accepts channel or stored item types. For add/list/update sources use channel_x, channel_web, x_account, subreddit, rss_feed, pinned_topic, hackernews, github_repo, polymarket, stocktwits, arxiv, youtube_channel." },
        value: { type: "string", description: "Source value — account, URL, subreddit, topic, etc. (add_source/update_source)" },
        enabled: { type: "boolean", description: "Toggle source on/off (update_source)" },
        status: { type: "string", enum: ["new", "surfaced", "dismissed", "saved", "archived"], description: "Filter by status (list_signals)" },
        limit: { type: "number", description: "Max results (list_signals, list_scan_runs, default 50)" },
        offset: { type: "number", description: "Pagination offset (list_signals)" },
        min_relevance: { type: "number", description: "Minimum relevance score filter (list_signals, 0-1)" },
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
    description: "Manage pronunciation dictionary entries — teach Agent how to correctly pronounce names, brands, and technical terms. Entries are case-sensitive.",
    category: "voice",
    sideEffectDefault: 1,
    sideEffectActions: { list: 0 },

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add", "update", "remove"], description: "Action" },
        word: { type: "string", description: "The word as written (case-sensitive, required for add/update/remove)" },
        alias: { type: "string", description: "How the word should be pronounced (required for add/update)" },
      },
      required: ["action"],
    },
  },
  rules: {
    description: RULES_TOOL_DESCRIPTION,
    category: "knowledge",
    sideEffectDefault: 1,
    sideEffectActions: { list: 0, get: 0 },

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "get", "save", "create", "update", "delete"], description: "Action" },
        id: { type: "string", description: "Rule ID (required for get, update, delete)" },
        rule: { type: "string", description: "The explicit personal behavioral command (required for save/create). Any conditions or context under which the Rule applies must be stated within the Rule text itself." },
        tags: { type: "array", items: { type: "string", description: "A category tag" }, description: "Tags for categorization" },
      },
      required: ["action"],
    },
  },
  orient: {
    description: "Unified session orientation — set title, topics, and persona in a single call. On first-turn orientation (no title set yet), `title` and a selectable `persona` are required. Never omit persona; use Companion when the opening has no job. Root is never a session seat. For mid-session re-orientation, all parameters are optional for partial updates.",
    category: "communication",
    sideEffectDefault: 1,

    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Session title, 1-3 words" },
        topics: { type: "array", items: { type: "string" }, description: "Topic keywords, up to 8" },
        persona: { type: ["string", "number"], description: "Persona name or numeric ID to activate" },
        reasoning: { type: "string", description: "Brief explanation of why these orientation choices were made" },
      },
      required: [],
    },
    whenToUse: "On the first turn of every session to set a title, optional topics, and a selectable persona. Always pick a seat — Companion when the opening has no job. Also for mid-session re-orientation when the conversation's purpose shifts. The active persona determines which context sections and tools load — switch persona to change what's assembled.",
  },
  session: {
    description: "Session metadata, agenda, lifecycle, attention, and tree messaging. Prefer list_agenda + complete/skip/defer; never guess item IDs. Children do not inherit agendas. Coding missions: delegation=engineering (parent needs trusted engineering + build:write; child uses its own clone).",
    category: "communication",
    sideEffectDefault: 0,
    sideEffectActions: {
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
    },

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "get_agenda", "list_agenda", "set_agenda", "apply_agenda_template", "update_agenda_item", "complete_agenda_item", "skip_agenda_item", "defer_agenda_item", "set_status", "end", "list", "search", "get_messages", "spawn_child", "send_message", "initiate", "set_attention", "message_parent", "message_child", "message_sibling"], description: "Action. Prefer list_agenda plus the narrow complete/skip/defer actions for agenda progress; legacy get_agenda/update_agenda_item remain supported. Use apply_agenda_template to start the session agenda from a saved reusable template instead of hand-authoring items." },
        sessionId: { type: "string", description: "Target session ID. Agenda actions default to the current session; omit this field for the current conversation." },
        runStatus: { type: "string", enum: ["resolved", "saved", "failed"], description: "Lifecycle state to set for set_status. resolved is accepted as a legacy alias for saved; session.status is the source of truth." },
        summary: { type: "string", description: "Brief summary of the session (end)" },
        limit: { type: "number", description: "Max results to return (list/search/get_messages)" },
        type: { type: "string", description: "Filter by session type (list)" },
        status: { type: "string", description: "Filter by status (list)" },
        query: { type: "string", description: "Search query (search)" },
        topic: { type: "string", description: "Short topic/title for the new child session (spawn_child)." },
        reason: { type: "string", description: "Free-text reason describing why the child is being spawned (spawn_child); included in the warm-start brief. This text cannot grant permissions or trusted engineering provenance." },
        spawnReason: { type: "string", description: "Idempotency key for spawn_child; reusing the same (parent, spawnReason) returns the existing child instead of creating a new one. Defaults to 'spawn_child:<topic>'." },
        delegation: { type: "string", enum: ["conversation", "engineering"], description: "Child persona mode. Use engineering to select Engineer for coding missions. Execution authority is inherited from the spawner after server validation; defaults to conversation persona mode." },
        agenda: { type: "array", items: { type: "object", properties: { id: { type: "string", description: "Stable item ID (optional when creating; generated if omitted)" }, title: { type: "string", description: "Simple 3–5 word title" }, description: { type: "string", description: "One to three sentence description" }, status: { type: "string", enum: ["open", "complete", "skipped", "deferred"] }, resolution: { type: "string", description: "Discrete resolution; required when status is complete" } }, required: ["title", "description"] }, description: "Ordered agenda items for set_agenda, spawn_child, or converse initiation. Existing agendas are replaced only by set_agenda." },
        itemId: { type: "string", description: "Exact stable agenda item ID returned by list_agenda/get_agenda. Required for update_agenda_item, skip_agenda_item, and defer_agenda_item. Optional for complete_agenda_item: when omitted, the single current open item is completed. Never guess it." },
        agendaId: { type: "string", description: "Agenda template (definition) ID to apply as this session's agenda, replacing any current items (apply_agenda_template). Search the agendas tool first to resolve the template ID." },
        resolution: { type: "string", description: "Discrete resolution required only for complete_agenda_item. Omit it for skip_agenda_item and defer_agenda_item." },
        item: { type: "object", properties: { title: { type: "string", description: "Replacement 3–5 word title" }, description: { type: "string", description: "Replacement description" }, status: { type: "string", enum: ["open", "complete", "skipped", "deferred"] }, resolution: { type: "string", description: "Resolution required only when the resulting status is complete; omitted or blank optional fields are ignored, and non-complete statuses remove any prior resolution" } }, description: "Sparse agenda item patch for the backward-compatible update_agenda_item action. Send only fields that should change." },
        content: { type: "string", description: "Message body to deliver for send_message, message_parent, message_child, or message_sibling." },
        toSessionId: { type: "string", description: "Target session ID for send_message, message_child, or message_sibling." },
        toSpawnReason: { type: "string", description: "Resolve a direct child or sibling by its spawn reason for message_child or message_sibling." },
        topic: { type: "string", description: "Short session topic for initiate. Autonomous inspect skills cannot mint a conversation." },
        message: { type: "string", description: "Opening message for initiate. The conversation must be the deliverable, not a page about other work." },
        isPinned: { type: "boolean", description: "Whether set_attention pins or unpins the target session (default true)." },
      },
      required: ["action"],
    },
  },
  router: {
    description: "Call and inspect the model routing layer.",
    category: "knowledge",
    sideEffectDefault: 0,

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["eval", "list_inference_calls", "get_inference_call"], description: "eval: run an arbitrary prompt through the production model router without writing app state. list_inference_calls/get_inference_call inspect audited model calls." },
        id: { type: "string", description: "Inference call ID (get_inference_call)" },
        profile: { type: "string", description: "For eval: optional diagnostic semantic-tier override: max, high, balanced, or fast. Normal routing uses the active persona tier. For list: filter by recorded audit profile/tier." },
        activityId: { type: "string", description: "Optional audit activity ID for router.eval. Does not select the model tier." },
        systemPrompt: { type: "string", description: "System prompt for eval." },
        userPrompt: { type: "string", description: "User prompt/source text for eval." },
        jsonMode: { type: "boolean", description: "Request JSON-mode output and parse the response when possible." },
        temperature: { type: "number", description: "Eval temperature, clamped 0-1. Default 0.2." },
        maxTokens: { type: "number", description: "Eval output token cap, clamped 1-4000. Default 1200." },
        metadata: { type: "object", description: "Optional audit metadata such as purpose, sampleId, promptVersion." },
        limit: { type: "number", description: "Max number of inference calls to return (default 50, max 200)." },
        model: { type: "string", description: "Filter inference calls by model name." },
        status: { type: "string", enum: ["complete", "past"], description: "Filter inference calls: complete = this boot session, past = before this boot." },
        runId: { type: "string", description: "Exact Agent run ID filter for list_inference_calls." },
        sessionId: { type: "string", description: "Exact chat Session ID filter for list_inference_calls." },
        offset: { type: "number", description: "Pagination offset for list_inference_calls (default 0, max 10000)." },
      },
      required: ["action"],
    },
  },
  plan: {
    description: "Multi-step plans as child-session missions. Decompose by shippable deliverable, not pipeline phase; children already run full domain SOP. needs_review is a human gate — only a later interactive turn may approve; resume never does.",
    category: "execution",
    sideEffectDefault: 1,
    sideEffectActions: { get: 0, list: 0 },
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "get", "associate_session", "unlink_session", "list", "reconcile_library", "execute", "update_step", "edit", "add_steps", "pause", "review", "resume"], description: "Action" },
        title: { type: "string", description: "Plan title (create/edit)" },
        steps: { type: "array", items: { type: "object", properties: { title: { type: "string" }, instructions: { type: "string" }, persona: { type: "string", description: "Selectable persona for this mission. Choose from the personas available to the current user based on the mission's primary deliverable, not incidental verbs." } }, required: ["title", "instructions", "persona"] }, description: "Ordered steps (create). Each step is a self-sufficient mission producing one shippable, verifiable deliverable (a merged PR, a written spec, a completed analysis) — never a pipeline phase of another step. Instructions must name the inputs/context to load and what done looks like, since the child starts with fresh context." },
        planId: { type: "string", description: "Plan ID — prefer the Plan DB ID; Library page ID or slug also resolve when unambiguous (get, associate_session, unlink_session, execute, update_step, edit, add_steps, pause, resume)" },
        goalId: { type: "string", description: "Optional goal to link (create/edit)" },
        projectId: { type: "number", description: "Optional project to link (create/edit)" },
        blocking: { type: "boolean", description: "Block originating session during execution (create/edit; default on create: auto — true for ≤5 steps, false for >5)" },
        workspace: { type: "string", description: "Git repo URL for shared workspace across steps (create/edit)" },
        vaultId: { type: "string", description: "Owning Vault for the execution Plan page (create; defaults to the active Vault). The page is filed under that Vault's canonical Plans folder." },
        stepId: { type: "string", description: "Step ID within the plan (update_step/review)" },
        decision: { type: "string", enum: ["approve", "request_changes", "retry", "stop"], description: "Human review decision (review). The call is accepted only from a later interactive human turn after the gate opened." },
        reason: { type: "string", description: "Bounded review reason or requested changes (review; required for request_changes)." },
        status: { type: "string", enum: ["pending", "completed", "failed", "skipped", "blocked", "needs_review"], description: "Step status (update_step). Use blocked for external dependency/error blocks and needs_review when Ray must test, approve, or respond." },
        stepEdits: { type: "array", items: { type: "object", properties: { stepId: { type: "string" }, title: { type: "string" }, instructions: { type: "string" }, persona: { type: "string", description: "Selectable persona for this mission." }, status: { type: "string", enum: ["pending", "completed", "failed", "skipped", "blocked", "needs_review"] } }, required: ["stepId"] }, description: "Step definition edits for plan(action: edit). Each edit may change title, instructions, persona, and/or status." },
        outcome: { type: "string", description: "Step outcome summary (update_step). For needs_review this is the scannable ask shown as the review card headline: one or two plain sentences naming exactly what the human must decide or do. Keep it short; put context in reviewDetail. Use canonical reference chips (@page:id, @pr:repo/number, @person:id) instead of pasting URLs or IDs." },
        reviewDetail: { type: "string", description: "Optional supporting detail for a needs_review gate (update_step). The fuller instructions, context, or evidence the human needs, rendered as a readable body beneath the headline. Prefer short lines or a few bullet-style steps over one dense paragraph, and use canonical reference chips (@page:id, @pr:repo/number) for any objects." },
        newSteps: { type: "array", items: { type: "object", properties: { title: { type: "string" }, instructions: { type: "string" }, persona: { type: "string", description: "Selectable persona for this mission." } }, required: ["title", "instructions", "persona"] }, description: "New steps to add (add_steps), each with its mission persona" },
        afterStepId: { type: "string", description: "Insert new steps after this step ID, null to append (add_steps)" },
        sessionId: { type: "string", description: "Session ID to unlink from a plan (unlink_session; defaults to the current session)" },
        limit: { type: "number", description: "Page size (list: default 20, max 100; reconcile_library: default 200, max 500)" },
        offset: { type: "number", description: "Pagination offset (list and reconcile_library, default 0)" },
        mode: { type: "string", enum: ["preview", "apply"], description: "Reconciliation mode (reconcile_library; defaults to preview). Apply moves only Plan-registry joined pages and retires only proven-empty duplicate Plans containers." },
      },
      required: ["action"],
    },
  },

  agendas: {
    description: "Manage reusable conversational agenda definitions. Definitions are editable templates; Session agendas are independent execution snapshots and are never rewritten by definition edits. These templates are the canonical source for recurring conversation flows (e.g. pitch, qualification, onboarding); search here and apply one with the session tool's apply_agenda_template action before hand-authoring a session agenda. The reserved FTUE definition is editable but cannot be deleted.",
    category: "automation",
    sideEffectDefault: 1,
    sideEffectActions: { list: 0, get: 0, search: 0 },
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "get", "search", "create", "update", "delete"], description: "Action" },
        id: { type: "string", description: "Agenda definition ID (get, update, delete)" },
        name: { type: "string", description: "Agenda name (create/update)" },
        description: { type: "string", description: "Agenda description (create/update)" },
        query: { type: "string", description: "Search query (search)" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Stable item ID. Omit only when creating a new item." },
              title: { type: "string", description: "Simple 3–5 word item title" },
              description: { type: "string", description: "One to three sentence item instructions" },
            },
            required: ["title", "description"],
          },
          description: "Ordered agenda definition items (create/update). Definition items never carry execution status or resolution.",
        },
        clearFields: { type: "array", items: { type: "string", enum: ["description"] }, description: "Fields to explicitly clear (update)" },
        limit: { type: "number", description: "Max definitions to return (default 50, max 100)" },
      },
      required: ["action"],
    },
  },
  templates: {
    description: "Document template map: unique id → Library shape page. Skills bind closed keys (spec, daily, weekly) to template ids. Resolve before writing Spec / Daily Digest / Weekly Summary artifacts; validate headings against the shape page; missing required headings become visible Residual. Account rows overlay global ids without forking skill process.",
    category: "automation",
    sideEffectDefault: 1,
    sideEffectActions: { list: 0, get: 0, search: 0, resolve: 0 },
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "get", "search", "resolve", "create", "update", "bind"], description: "Action" },
        id: { type: "string", description: "Template id (get/update)" },
        name: { type: "string", description: "Human label (create/update)" },
        pageId: { type: "string", description: "Library page UUID that is the shape (create/update)" },
        status: { type: "string", enum: ["active", "deprecated"], description: "Template status (create/update)" },
        query: { type: "string", description: "Search query (search)" },
        skill: { type: "string", description: "Skill name or id (resolve)" },
        skillName: { type: "string", description: "Alias of skill (resolve)" },
        skillId: { type: "string", description: "Skill UUID (bind)" },
        key: { type: "string", enum: ["spec", "daily", "weekly"], description: "Closed binding key (resolve/bind)" },
        templateId: { type: "string", description: "Template id (bind)" },
      },
      required: ["action"],
    },
  },
  skills: {
    description: "Manage Agent's skill library — reusable instruction sets. The 'get' action returns full skill details including the structured weighted checklist used by the scorer. The 'run' action spawns an autonomous skill execution. The 'runs' action returns recent execution history (status, duration, score, timestamps, and failureReason/endReason for failed runs) from skill_runs — same data shown in the dashboard's Run History panel. The 'scores' action returns scored runs from skill_runs (the source of truth).",
    category: "knowledge",
    sideEffectDefault: 1,
    sideEffectActions: { list: 0, get: 0, search: 0, scores: 0, run: 1 },

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "get", "create", "update", "edit", "set_persona", "delete", "search", "run", "runs", "scores"], description: "list: show all skills. get: read full skill details by name including structured checklist. create: add a new skill. update: modify an existing skill by id (wholesale field replacement). edit: surgical find/replace within one text field (default 'process') without resending the whole field — mirrors edit_library_page. set_persona: set or clear the current user's persona override for a skill. delete: remove a user-created skill by id. search: find skills by query string. run: spawn an autonomous skill execution by skill ID. runs: get recent skill_runs (status, duration, pass rate, timestamps) for a skill by name — matches the dashboard Run History panel. scores: get scoring history from skill_runs." },
        id: { type: "string", description: "Skill UUID (update, edit, delete)" },
        field: { type: "string", enum: ["process", "description"], description: "Text field to surgically edit (edit, default 'process')." },
        old_string: { type: "string", description: "Exact text to find in the target field (edit)." },
        new_string: { type: "string", description: "Replacement text; empty string deletes the matched text (edit)." },
        replace_all: { type: "boolean", description: "Replace all occurrences (edit, default false). Required when old_string appears more than once." },
        name: { type: "string", description: "Skill name (get, create, search)" },
        query: { type: "string", description: "Search query (search action)" },
        description: { type: "string", description: "Skill description (create/update)" },
        process: { type: "string", description: "Skill process/instructions (create/update)" },
        checklist: { type: "array", items: { type: "object", properties: { check: { type: "string" }, weight: { type: "number" }, kind: { type: "string", enum: ["judgment", "tool_invoked", "child_skill_invoked"], description: "Evaluation kind. Default 'judgment' is LLM-scored. 'tool_invoked' requires a successful tool/action invocation. 'child_skill_invoked' requires an exact fresh child SkillRun from this parent run to succeed." }, tool: { type: "string", description: "Tool name for kind 'tool_invoked'. Validated against the tool registry at write time." }, action: { type: "string", description: "Optional exact action required for kind 'tool_invoked'. Validated against the named tool's action enum." }, skill: { type: "string", description: "Required child Skill name for kind 'child_skill_invoked'." } }, required: ["check"] }, description: "Structured quality checklist for scoring (create/update). The checklist is the single quality spec: judgment items are LLM-evaluated; 'tool_invoked' and 'child_skill_invoked' items are evaluated structurally and gate terminal status — a failed one marks the run and its launching timer 'degraded'." },
        scoreThreshold: { type: "number", description: "Minimum checklist pass rate 0-1 (create/update). A scored run below this reconciles the skill run and its launching timer run to 'degraded'. Pass null to clear." },
        version: { type: "string", description: "Version string (create/update)" },
        sessionType: { type: "string", enum: ["autonomous", "agent"], description: "System session switch (create/update). 'autonomous' files runs under SYSTEM; 'agent' is a visible conversation." },
        personaId: { type: ["number", "null"], description: "Persona ID for set_persona. Pass null to clear the override and use the product recommendation." },
        preContext: { type: "string", description: "Optional pre-context string to pass to the skill run (run)" },
        wait: { type: "boolean", description: "If true (default), wait for the skill run to complete before returning. If false, fire-and-forget. (run)" },
        limit: { type: "number", description: "Number of records to return (runs and scores actions, default 20, max 50)" },
      },
      required: ["action"],
    },
  },
  cognition: {
    description: "Cognitive state, observations, personas, and agent profile. Use orient to switch personas; resolve_toolset previews resident vs on-demand tools; update_global_persona_template mutates seed bundles (system:write).",
    category: "cognition",
    sideEffectDefault: 1,
    sideEffectActions: { get_emotion: 0, emotion_history: 0, get_persona: 0, list_personas: 0 },
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["set_emotion", "get_emotion", "emotion_history", "observe", "get_profile", "update_profile", "get_persona", "list_personas", "resolve_toolset", "create_persona", "update_persona", "update_global_persona_template"], description: "Action" },
        observation_type: { type: "string", enum: ["pattern", "gap", "change", "connection", "opportunity"], description: "Observation type (observe)" },
        observation: { type: "string", description: "Specific, evidence-based metacognitive observation in 1–3 short sentences (observe)" },
        agentName: { type: "string", description: "New name for the agent (update_profile, 1-80 chars)" },
        metadata: { type: "object", description: "Metadata to merge into the agent profile (update_profile)" },
        state_name: { type: "string", description: "Emotional state name (set_emotion, e.g., 'focused', 'curious', 'frustrated')" },
        valence: { type: "number", description: "Emotional valence -1 (negative) to 1 (positive) (set_emotion)" },
        arousal: { type: "number", description: "Emotional arousal 0 (calm) to 1 (activated) (set_emotion)" },
        triggers: { type: "array", items: { type: "string" }, description: "What triggered this state (set_emotion)" },
        context: { type: "string", description: "Context for the emotional state (set_emotion)" },
        narrative: { type: "string", description: "A few sentences about what's alive emotionally — grounds the state in felt experience (set_emotion)" },
        limit: { type: "number", description: "Max history entries (emotion_history, default 10)" },
        id: { type: "number", description: "Persona ID (update_persona; optional for resolve_toolset — defaults to the active persona)" },
        name: { type: "string", description: "Persona name (create_persona)" },
        description: { type: "string", description: "Persona description (create_persona, update_persona)" },
        prompt_overlay: { type: "string", description: "Behavioral prompt overlay (create_persona, update_persona)" },
        expression_tags: { type: "array", items: { type: "string" }, description: "Recommended expression tags (create_persona, update_persona)" },
        cognitive_overrides: { type: "object", description: "Cognitive parameter overrides (create_persona, update_persona)" },
        context_sections: { type: "object", additionalProperties: { type: "boolean" }, description: "Persisted context section bundle mapping section IDs to enabled/disabled (create_persona, update_persona)" },
        tool_bundle: { type: "array", items: { type: "string" }, description: "Persisted non-core tool names loaded by this persona; empty means passthrough/all tools (create_persona, update_persona)" },
      },
      required: ["action"],
    },
    whenToUse: "When you want to manage cognitive state, record a constrained metacognitive observation, read or update your own profile, or manage persisted persona configuration. Use set_emotion when your cognitive state shifts. Use the `orient` tool to switch personas.",
  },
  finance: {
    description: "Query financial data from connected bank accounts.",
    category: "finance",
    sideEffectDefault: 0,

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["summary", "transactions", "holdings", "liabilities", "debt_payments", "categories", "budget", "income", "recurring", "forecast", "accounts", "assets", "goals", "import_transactions", "link_account", "refresh", "amortize", "list_amortizations", "remove_amortization"], description: "Action" },
        transactionId: { type: "string", description: "Plaid transaction ID (amortize)" },
        originalAmount: { type: "number", description: "Original lump amount in dollars (amortize)" },
        spreadMonths: { type: "number", description: "Number of months to spread expense across, 1-120 (amortize)" },
        startMonth: { type: "string", description: "Start month YYYY-MM (amortize)" },
        isActive: { type: "boolean", description: "Whether amortization is active (amortize update; pass an id to update an existing one)" },
        startDate: { type: "string", description: "Start date YYYY-MM-DD (transactions)" },
        endDate: { type: "string", description: "End date YYYY-MM-DD (transactions)" },
        category: { type: "string", description: "Plaid category filter (transactions)" },
        accountId: { type: "string", description: "Account ID filter (transactions)" },
        limit: { type: "number", description: "Max results (transactions, default 50)" },
        months: { type: "number", description: "Number of months to forecast (forecast, default 12)" },
        mode: { type: "string", enum: ["this_month", "last_month", "trailing_avg"], description: "Comparison mode (budget, default this_month)" },
        month: { type: "string", description: "Specific month YYYY-MM (budget, overrides mode when provided)" },
        goal_action: { type: "string", enum: ["list", "create", "update", "delete"], description: "Sub-action for goals (default list)" },
        name: { type: "string", description: "Goal name (goals create/update)" },
        targetAmount: { type: "number", description: "Target dollar amount (goals create/update)" },
        currentAmount: { type: "number", description: "Current dollar amount (goals create/update, manual)" },
        targetDate: { type: "string", description: "Target date YYYY-MM-DD (goals create/update)" },
        notes: { type: "string", description: "Notes (goals create/update)" },
        linkedAccountIds: { type: "array", items: { type: "string" }, description: "Plaid account IDs to link (goals create/update)" },
        id: { type: "number", description: "Goal ID (goals update/delete)" },
      },
      required: ["action"],
    },
  },
  images: {
    description: "Generate, edit, or analyze images. For uploads, use the exact /objects/uploads/<id>.<ext> object path from attachment metadata without rewriting it. Render generated or uploaded images inline as ![descriptive alt](/objects/uploads/<id>.<ext>), not signed/download URLs. Analyze may rename a UUID or camera-dump Files display name to a short useful title; the object path stays unchanged. Actions: generate (text-to-image), edit (combine/modify images), analyze (describe/extract from an image).",
    category: "media",
    sideEffectDefault: 1,
    sideEffectActions: { analyze: 0 },

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["generate", "edit", "analyze"], description: "Action" },
        prompt: { type: "string", description: "Text prompt — what to generate/edit, or what to look for when analyzing" },
        size: { type: "string", description: "Image size as WIDTHxHEIGHT (generate, default 1024x1024). Both dimensions must be divisible by 16, aspect ratio between 1:3 and 3:1. Examples: 1024x1024, 1920x1080, 1080x1920" },
        quality: { type: "string", enum: ["low", "medium", "high", "auto"], description: "Image quality (generate, default auto). Low is fastest/cheapest, high is most detailed." },
        background: { type: "string", enum: ["opaque", "auto"], description: "Background type (generate, default auto). Note: transparent backgrounds not yet supported." },
        outputFormat: { type: "string", enum: ["png", "jpeg", "webp"], description: "Output image format (generate, default png)" },
        depth: { type: "string", enum: ["quick", "deep"], description: "Analysis depth (analyze). Quick uses a fast model, deep uses the most capable. Default uses the configured Media tier." },
        images: { type: "array", items: { type: "string" }, description: "Array of workspace file paths (edit)" },
        path: { type: "string", description: "Workspace file path to an image (analyze)" },
        url: { type: "string", description: "URL of an image to fetch and analyze (analyze)" },
        base64: { type: "string", description: "Raw base64-encoded image data (analyze)" },
        mediaType: { type: "string", description: "MIME type when using base64, e.g. image/png (analyze, default image/png)" },
      },
      required: ["action"],
    },
  },
  timers: {
    description: "Manage scheduled timers and one-time reminders — list all or filter by name, get details by ID or name, view runs, create, update, delete, or manually trigger. Use frequency=once with fireAt for one-time timers; unmanaged user timers composed only of Once schedules auto-delete after firing.",
    category: "system",
    sideEffectDefault: 1,
    sideEffectActions: { list: 0, get: 0, runs: 0 },

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "get", "runs", "create", "update", "delete", "trigger"], description: "Action" },
        id: { type: "string", description: "Timer ID (get/runs/update/delete/trigger). For get, a timer name is also accepted as a fallback." },
        scheduleId: { type: "string", description: "Schedule ID within the timer (trigger, defaults to first schedule)" },
        name: { type: "string", description: "Timer name (create/update, or list filter)" },
        description: { type: "string", description: "Timer description (create/update)" },
        type: { type: "string", enum: ["agent", "system", "me", "skill", "pipeline", "reminder"], description: "Timer type: agent, system, me, skill, pipeline, reminder (create). Pipeline runs a deterministic domain command from prompt; use reminder for one-time scheduled prompts; unmanaged user timers composed only of Once schedules auto-delete after firing." },
        prompt: { type: "string", description: "Timer prompt (create/update)" },
        skillId: { type: "string", description: "Skill ID (create/update, when type=skill)" },
        schedules: { type: "array", items: { type: "object", properties: { id: { type: "string", description: "Schedule ID" }, frequency: { type: "string", enum: ["every_x_minutes", "every_x_hours", "every_x_weeks", "daily", "weekly", "monthly", "quarterly", "annually", "custom", "once"], description: "Schedule frequency. Use every_x_weeks with interval, daysOfWeek, and timeOfDay for biweekly or multi-week cadence. Use 'once' with fireAt for one-time reminders." }, interval: { type: "number", description: "Interval value (every_x_minutes/every_x_hours/every_x_weeks)" }, timeOfDay: { type: "string", description: "Time of day HH:MM (daily/weekly/monthly/quarterly/annually)" }, daysOfWeek: { type: "array", items: { type: "string", enum: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] }, description: "Days of the week (weekly)" }, dayOfMonth: { type: "number", description: "Day of month 1-31 (monthly)" }, monthOfYear: { type: "number", description: "Month of year 1-12 (annually)" }, dayOfYear: { type: "number", description: "Day of year 1-366 (annually)" }, quarter: { type: "number", description: "Quarter 1-4 (quarterly)" }, cronExpression: { type: "string", description: "Cron expression (custom)" }, fireAt: { type: "string", description: "ISO datetime string for one-time fire (use with frequency=once for reminders)" } }, required: ["id", "frequency"] }, description: "Schedule definitions (create/update)" },
        enabled: { type: "boolean", description: "Whether timer is enabled (create/update)" },
        timezone: { type: "string", description: "IANA timezone (create/update, default America/New_York)" },
        limit: { type: "number", description: "Max timers to return for list (default 100) or max runs to return for runs (default 20)" },
      },
      required: ["action"],
    },
  },
  health: {
    description: "Query health metrics and fully manage the wellness calendar. Autonomous skills must not call save_learning or save_gratitude; those are user-authored personal logs. Actions: summary (7-day summary by metric type), metrics (raw metric rows with optional type/date filters), list_activities (all active wellness activities), log_activity (record a completion by activityId or name with fuzzy match, optional date param YYYY-MM-DD for past-date logging), activity_status (all activities grouped by status: overdue/due_soon/on_track/never_done with urgency scores — includes tier and metricValue for metric-backed activities), create_activity (add a new wellness activity with name, intervalDays, category, and optional fields including linkedMetricType, greatThreshold, goodThreshold for metric-backed auto-completion), update_activity (modify an existing activity by activityId or name — set newName, benefit, risk, intervalDays, category, linkedMetricType, greatThreshold, goodThreshold, windowStart, windowEnd), delete_activity (archive an activity by activityId or name), activity_logs (view completion history with tier and metricValue, optionally filtered by activityId and days), delete_log (delete a specific log entry by logId), save_gratitude (upsert a gratitude entry — content required, date optional defaults to today, auto-logs Gratitude wellness activity), get_gratitude (get a single gratitude entry by date, defaults to today), list_gratitudes (list gratitude entries in reverse-chronological order, optional limit default 30), save_learning (upsert a learning entry — content required, date optional defaults to today, auto-logs Learning wellness activity), get_learning (get a single learning entry by date, defaults to today), list_learnings (list learning entries in reverse-chronological order, optional limit default 30).",
    category: "health",
    sideEffectDefault: 1,
    sideEffectActions: {
      summary: 0, metrics: 0, activity_status: 0, list_activities: 0, activity_logs: 0,
      get_gratitude: 0, list_gratitudes: 0,
    },

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["summary", "metrics", "list_activities", "log_activity", "activity_status", "create_activity", "update_activity", "delete_activity", "activity_logs", "delete_log", "save_gratitude", "get_gratitude", "list_gratitudes", "save_learning", "get_learning", "list_learnings"], description: "Action" },
        type: { type: "string", description: "Filter by metric type (metrics)" },
        days: { type: "number", description: "Number of days to look back (metrics, default 30) or max entries to return (activity_logs, default 50)" },
        activityId: { type: "number", description: "Wellness activity ID (log_activity, update_activity, delete_activity, activity_logs)" },
        name: { type: "string", description: "Wellness activity name for fuzzy match (log_activity, update_activity, delete_activity) or exact name (create_activity)" },
        notes: { type: "string", description: "Optional notes when logging an activity" },
        date: { type: "string", description: "Date in YYYY-MM-DD format (log_activity past-date logging, save_gratitude, get_gratitude). Future dates not allowed for log_activity." },
        content: { type: "string", description: "Gratitude or learning entry text content (save_gratitude/save_learning, max 5000 chars)" },
        limit: { type: "number", description: "Max entries to return (list_gratitudes/list_learnings, default 30)" },
        logId: { type: "number", description: "Wellness log entry ID to delete (delete_log)" },
        newName: { type: "string", description: "Rename an activity (update_activity)" },
        intervalDays: { type: "number", description: "Recurrence interval in days (create_activity, update_activity)" },
        category: { type: "string", enum: ["daily_practice", "weekly_ritual", "monthly_renewal", "quarterly_reset", "annual_checkup"], description: "Activity category — auto-derived from intervalDays if omitted (1d=daily, 2-7d=weekly, 8-30d=monthly, 31-90d=quarterly, 91+=annual). Override explicitly if needed." },
        benefit: { type: "string", description: "What this activity provides (create_activity, update_activity)" },
        risk: { type: "string", description: "Risk of not doing this activity (create_activity, update_activity)" },
        linkedMetricType: { type: "string", description: "Health metric type to link for auto-completion, e.g. 'mindful_minutes', 'steps' (create_activity, update_activity)" },
        greatThreshold: { type: "number", description: "Daily metric value threshold for 'great' tier (create_activity, update_activity)" },
        goodThreshold: { type: "number", description: "Daily metric value threshold for 'good' tier (create_activity, update_activity)" },
        windowStart: { type: "number", description: "Window start boundary (create_activity, update_activity). Meaning depends on category: hour 0-23 for daily, day 1-7 for weekly, day 1-28 for monthly, month-in-quarter 1-3 for quarterly, month 1-12 for annual" },
        windowEnd: { type: "number", description: "Window end boundary (create_activity, update_activity). Same unit as windowStart. Supports wrap-around (e.g. daily 22-6 = 10pm to 6am)" },
      },
      required: ["action"],
    },
  },

  weather: {
    description: "Get weather data — current conditions, daily/hourly forecasts, historical weather, and NWS severe weather alerts. Default location: Chicago.",
    category: "weather",
    sideEffectDefault: 0,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["current", "forecast", "hourly", "alerts", "historical"], description: "Action" },
        location: { type: "string", description: "City or place name to geocode (default: Chicago)" },
        latitude: { type: "number", description: "Latitude (use with longitude instead of location)" },
        longitude: { type: "number", description: "Longitude (use with latitude instead of location)" },
        days: { type: "number", description: "Number of forecast days (forecast, default 7, max 16)" },
        hours: { type: "number", description: "Number of forecast hours (hourly, default 24, max 168)" },
        startDate: { type: "string", description: "Start date YYYY-MM-DD (required for historical)" },
        endDate: { type: "string", description: "End date YYYY-MM-DD (historical, defaults to startDate)" },
        timezone: { type: "string", description: "Timezone (default: America/Chicago)" },
      },
      required: ["action"],
    },
  },
  slack: {
    description: "Outbound Slack delivery door owned by the Slack Mod. status returns provider-free readiness (inactive_mod | no_installation | disabled | unconfigured | ready). send posts one bot-attributed message to a mapped Person DM or the one allowlisted channel under explicit authority, with durable replay-safe receipts. Person Slack IDs are locators only — send still requires an active mapping. Slack-ingress turns cannot call this tool.",
    category: "communication",
    advertiseWhenUnready: true,
    sideEffectDefault: 2,
    sideEffectActions: { status: 0 },
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["status", "send"],
          description: "status is readiness only; send is the only mutation.",
        },
        to: {
          type: "string",
          enum: ["person", "channel"],
          description: "send destination kind. person = mapped DM; channel = the one allowlisted channel.",
        },
        personId: {
          type: "string",
          description: "Canonical Person id when to=person. Not a Slack U… id and not a User id.",
        },
        channelId: {
          type: "string",
          description: "Optional when to=channel. If present must equal the installation allowlisted C… id; omit to use that id.",
        },
        text: {
          type: "string",
          description: "Message body, 1–4000 Unicode characters after trim. No silent truncate, blocks, or files.",
        },
        idempotencyKey: {
          type: "string",
          description: "Required replay identity for send, 8–120 chars. Same key + same body returns the existing receipt; same key + different body fails closed.",
        },
      },
      required: ["action"],
    },
  },
  tools: {
    description: "Discover authority-allowed tools and load callable schemas on demand. `list` summarizes allowed tools; interactive `get` returns full docs and hydrates that tool into the current run.",
    category: "system",
    sideEffectDefault: 0,

    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "get"], description: "list = summarize authority-allowed tools; get = return full docs and, in interactive chat, load one allowed callable schema" },
        tool: { type: "string", description: "Exact tool name to document and load (get)" },
      },
      required: ["action"],
    },
  },

  backup: {
    description: "Manage database backups — create snapshots, list history, inspect metadata, and delete old backups. Restore is intentionally not exposed to agents; humans must use the Dev page for restore operations.",
    category: "system",
    sideEffectDefault: 2,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "list", "get", "delete"], description: "Action" },
        id: { type: "string", description: "Backup ID (get or delete)" },
        limit: { type: "number", description: "Max results (list, default 20)" },
      },
      required: ["action"],
    },
  },

  routers: {
    description: "Manage named LLM Routers (exclusive model-connector pools) and Account assignment. Distinct from the diagnostic `router` tool. list/get/list_legacy require system:read; create/add_connector/update_connector/move/set_account_router require system:write (Account assignment also needs users:write).",
    category: "system",
    sideEffectDefault: 2,
    sideEffectActions: { list: 0, get: 0, list_legacy: 0 },
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "get", "list_legacy", "create", "add_connector", "update_connector", "move_connector", "set_account_router"],
          description: "Action. list/get/list_legacy are reads; create makes a named Router; add_connector creates an empty model connector on a Router (no legacy secret inherit); update_connector patches status/priorityPinned/tierMappings on any model connector id; move_connector reparents onto a Router or null legacy; set_account_router assigns an Account's router_id.",
        },
        id: { type: "string", description: "Router UUID (get)" },
        name: { type: "string", description: "Router display name (create)" },
        routerId: { type: "string", description: "Router UUID (add_connector destination; move_connector/set_account_router destination). Omit or null on move_connector to return connector to legacy NULL pool during parallel cutover." },
        kind: {
          type: "string",
          description: "Connector kind for add_connector: claude-cli | openai-subscription | openai | anthropic | grok-subscription | grok-api",
        },
        connectorId: { type: "number", description: "provider_connections id for a model connector (move_connector, update_connector)" },
        status: { type: "string", description: "active | inactive (update_connector)" },
        priorityPinned: { type: "boolean", description: "Pin connector ahead of unpinned peers (update_connector)" },
        tierMappings: {
          type: "object",
          description: "Per-tier model config object { max, high, balanced, fast } matching the connector provider (update_connector)",
        },
        accountId: { type: "string", description: "Account UUID (set_account_router)" },
      },
      required: ["action"],
    },
  },

  indexed_content: {
    description: "Retrieve archived content and structured indexes. Full originals are stored in object storage when content exceeds display limits — use this tool to list, inspect, or read specific sections of archived content by reference ID.",
    category: "system",
    sideEffectDefault: 0,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "get", "read_section"], description: "Action: list (recent indexed items), get (fetch index record), read_section (fetch raw text from a byte range)" },
        id: { type: "string", description: "Reference ID of the indexed content (get, read_section)" },
        sourceType: { type: "string", description: "Filter by source type (list, e.g., 'web_fetch', 'email', 'shell', 'file', 'compaction')" },
        limit: { type: "number", description: "Max results (list, default 20)" },
        sectionIndex: { type: "number", description: "Section index to read (read_section, 0-based)" },
        charOffset: { type: "number", description: "Character offset to start reading from (read_section)" },
        charLength: { type: "number", description: "Number of characters to read (read_section, default: entire remaining content)" },
      },
      required: ["action"],
    },
  },
  platforms: {
    description: "Manage platform infrastructure, Product intent, and Features — provider connections, environments, bindings, build lifecycle, canonical Products, and Feature CRUD/KPI/session history. create_product writes products. create_product_legacy is frozen; do not invent a second Product table. Feature create requires summary + productId + ownerPersonId; status always starts ready and stage changes reset status to ready.",
    category: "system",
    sideEffectDefault: 2,
    sideEffectActions: {
      list_connections: 0, get_connection: 0, test_connection: 0,
      list_environments: 0, get_environment: 0, get_environment_status: 0,
      list_products: 0,
      get_build_lifecycle: 0, get_build_status: 0, list_environment_workflows: 0,
      get_cloudflare_pages_project: 0,
      poll_cloudflare_pages_deployment: 0,
    },
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list_connections", "get_connection", "test_connection", "create_connection", "list_environments", "get_environment", "get_environment_status", "provision_database_roles", "get_build_lifecycle", "set_build_lifecycle", "disable_build_lifecycle", "delete_build_lifecycle", "get_build_status", "start_build_workflow", "list_environment_workflows", "create_platform", "update_platform", "list_products", "create_product", "update_product", "create_product_legacy", "update_product_legacy", "create_environment", "update_environment", "delete_environment", "save_source_binding", "save_hosting_binding", "get_cloudflare_pages_project", "deploy_cloudflare_pages", "cancel_cloudflare_pages_deployment", "poll_cloudflare_pages_deployment", "repair_cloudflare_pages_project", "list_features", "get_feature", "create_feature", "update_feature", "archive_feature", "delete_feature", "link_feature_kpi", "unlink_feature_kpi", "list_feature_sessions", "list_feature_history"], description: "Action. Feature actions: list_features, get_feature, create_feature, update_feature, archive_feature, delete_feature, link_feature_kpi, unlink_feature_kpi, list_feature_sessions, list_feature_history." },
        id: { type: "number", description: "Connection ID, Platform ID, Product ID, or Environment ID depending on action. Not Feature UUID — use featureId for Feature actions." },
        platformEnvironmentId: { type: "number", description: "Alias for Environment `id` on environment-scoped actions (get_environment, get_environment_status, build lifecycle/status, hosting/source bindings, Cloudflare Pages). Same positive Platform Environment ID as railway.platformEnvironmentId. If both are supplied they must match." },
        platformIds: { type: "array", items: { type: "number" }, description: "Writable Platform IDs to associate on create_product" },
        deploymentId: { type: "string", description: "Existing Cloudflare Pages deployment ID to retry; omit to trigger production" },
        cloudflareRepair: { type: "object", description: "Safe mutable Cloudflare Pages project settings: buildCommand, destinationDirectory, rootDirectory, productionBranch, deployment and preview controls" },
        provider: { type: "string", description: "Provider name e.g. 'railway', 'github' (create_connection)" },
        label: { type: "string", description: "Human-readable label (create_connection)" },
        credential: { type: "string", description: "API token or credential value (create_connection only — stored encrypted, never returned)" },
        name: { type: "string", description: "Platform/product/environment name (create/update actions)" },
        description: { type: "string", description: "Description for platform/product create/update actions, or the Feature description body on create_feature/update_feature (empty string clears it)" },
        status: { type: "string", description: "Platform/product status (active, paused, archived) or Feature status on update_feature only (ready, in_progress, needs_review). Feature create always starts ready; a stage change also resets Feature status to ready." },
        vaultId: { type: "string", description: "Live same-account Vault ID for Product placement on create_product/update_product; omit to use the active Vault on create, pass null to clear" },
        connectionId: { type: "number", description: "Provider connection ID to bind (save_source_binding, save_hosting_binding)" },
        owner: { type: "string", description: "Repo owner/org (save_source_binding)" },
        repo: { type: "string", description: "Repo name (save_source_binding)" },
        branch: { type: "string", description: "Branch name (save_source_binding)" },
        autoDeploy: { type: "boolean", description: "Auto-deploy on push (save_source_binding)" },
        codeIndexingEnabled: { type: "boolean", description: "Enable GitNexus code indexing for this environment source binding (save_source_binding)" },
        projectId: { type: "string", description: "Railway project ID (save_hosting_binding). For Features use productId (number), not this string Railway id." },
        providerEnvironmentId: { type: "string", description: "Railway environment ID (save_hosting_binding)" },
        serviceId: { type: "string", description: "Railway service ID (save_hosting_binding)" },
        projectName: { type: "string", description: "Railway project name (save_hosting_binding)" },
        providerEnvironmentName: { type: "string", description: "Railway environment name (save_hosting_binding)" },
        serviceName: { type: "string", description: "Railway service name (save_hosting_binding)" },
        publicUrl: { type: "string", description: "Public URL (save_hosting_binding)" },
        idempotencyKey: { type: "string", description: "Required replay-safe key for provision_database_roles and link_feature_kpi" },
        confirmation: { type: "string", description: "Exact explicit confirmation phrase required immediately before provision_database_roles mutation" },
        allowLive: { type: "boolean", description: "Separate explicit authorization for live/production provisioning; omitted or false denies live" },
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
        featureId: { type: "string", description: "Feature UUID for get_feature, update_feature, archive_feature, delete_feature, link_feature_kpi, unlink_feature_kpi, list_feature_sessions, list_feature_history" },
        productId: { type: "number", description: "Canonical Product ID for list_features filter, create_feature (required), and update_feature Product reassignment" },
        summary: { type: "string", description: "Feature title text (required on create_feature; optional on update_feature; max 500)" },
        ownerPersonId: { type: "string", description: "Feature owner Person ID (required on create_feature; optional on update_feature)" },
        stage: { type: "string", enum: ["idea", "spec", "develop", "test", "calibrate", "maintain", "deprecate"], description: "Feature stage (create_feature defaults to idea; update_feature may change it and resets status to ready)" },
        specPageId: { type: "string", description: "Optional Library page ID for the Feature spec (create_feature/update_feature); pass empty string on update to clear" },
        search: { type: "string", description: "Optional summary substring filter for list_features" },
        includeArchived: { type: "boolean", description: "Include archived Features on list_features (default false)" },
        kpiAddress: { type: "string", description: "Canonical KPI/Metric address for link_feature_kpi (intended_benefit target)" },
        linkId: { type: "string", description: "Address-link ID for unlink_feature_kpi" },
        confirm: { type: "boolean", description: "Required true for delete_feature permanent deletion" },
        historyNote: { type: "string", description: "Required why-note when update_feature changes status; recommended on every stage/status change. Recorded on feature_history." },
        historySource: { type: "string", description: "Optional provenance source label for feature_history (e.g. smoke, review, manual)." },
        sessionId: { type: "string", description: "Optional session id stamped onto feature_history when a pipeline job mutates the Feature." },
        changeSha: { type: "string", description: "Merge commit SHA to stamp on feature_history when stage advances into a room that declares identity change_sha (today: Test). Prefer the merge commit already written to merged_pull_requests — never the PR head, never a historyNote parse. Develop Review pass should supply this on the stage write." },
        toStage: { type: "string", enum: ["idea", "spec", "develop", "test", "calibrate", "maintain", "deprecate"], description: "Filter list_feature_history by destination stage" },
        toStatus: { type: "string", enum: ["ready", "in_progress", "needs_review"], description: "Filter list_feature_history by destination status" },
        fromStage: { type: "string", enum: ["idea", "spec", "develop", "test", "calibrate", "maintain", "deprecate"], description: "Filter list_feature_history by prior stage" },
        fromStatus: { type: "string", enum: ["ready", "in_progress", "needs_review"], description: "Filter list_feature_history by prior status" },
      },
      required: ["action"],
    },
  },
};

bindToolSideEffectCatalog((toolName) => {
  const meta = TOOLS[toolName];
  if (meta?.sideEffectDefault === undefined) return undefined;
  return { default: meta.sideEffectDefault, actions: meta.sideEffectActions };
});

/**
 * Tool name aliases — canonical new names pointing to legacy tool definitions.
 * Bridge-tools also maps these aliases to the same handler functions.
 * Remove once all stored references (skills, memory, rules) have migrated.
 */
export const TOOL_ALIASES: Record<string, string> = {
  projects: "work",        // Domain 2: Work → Projects
  observations: "cognition", // Domain 6 compatibility → canonical Cognition
  create: "content",       // Domain 10: Content → Create
  // Models often emit cognition actions as bare tool names (prompt says
  // `set_emotion` / `observe`). Rewrite to the registered cognition umbrella
  // and inject action at executeTool so schema validation still requires it.
  set_emotion: "cognition",
  get_emotion: "cognition",
  emotion_history: "cognition",
  observe: "cognition",
  get_profile: "cognition",
  update_profile: "cognition",
  get_persona: "cognition",
  list_personas: "cognition",
  resolve_toolset: "cognition",
  create_persona: "cognition",
  update_persona: "cognition",
  update_global_persona_template: "cognition",
};

/** Cognition action names that models sometimes emit as top-level tool names. */
export const COGNITION_ACTION_TOOL_ALIASES = new Set([
  "set_emotion",
  "get_emotion",
  "emotion_history",
  "observe",
  "get_profile",
  "update_profile",
  "get_persona",
  "list_personas",
  "resolve_toolset",
  "create_persona",
  "update_persona",
  "update_global_persona_template",
]);

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

function toolMetaToSchema(name: string, meta: ToolMeta): ToolSchema {
  const baseParams: Record<string, any> = meta.parameters || { type: "object" as const, properties: {} };
  const properties = { ...(baseParams.properties || {}), reasoning: { type: "string", description: "One-sentence audit reason." } };
  const required = Array.from(new Set([...(Array.isArray(baseParams.required) ? baseParams.required : []), "reasoning"]));
  const parameters = { ...baseParams, properties, required };
  const description = meta.description;
  return {
    name,
    description,
    category: normalizeCategory(meta.category),
    parameters,
  };
}

function toolMetaToDefinition(name: string, meta: ToolMeta): ToolDefinition {
  const schema = toolMetaToSchema(name, meta);
  return {
    ...schema,

    // The unified registry contains every public executable tool. Handler
    // composition is private to bridge-tools and must never become a second
    // registration source.
    source: "bridge",
    usageCount: 0,
    lastUsed: null,
    errors: 0,
    amberFailures: 0,
    unclassifiedErrors: 0,
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
      tool.amberFailures = perf.amberFailures;
      tool.unclassifiedErrors = perf.unclassifiedErrors;
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
  if (!cachedSchemas) {
    const schemas = Object.entries(TOOLS).map(([name, meta]) => toolMetaToSchema(name, meta));
    cachedSchemas = schemas;
    log.debug(`getToolSchemas: total=${cachedSchemas.length}`);
  }
  // Readiness gate is applied per-call and never cached: a secret-backed
  // integration tool whose connector is unconfigured must not be advertised as
  // callable, and must re-appear the moment it is configured (no restart).
  return withoutUnreadyIntegrationTools(cachedSchemas);
}

/** Resolve one registered public tool name through the canonical alias map. */
export function resolveRegisteredTool(name: string): { name: string; schema: ToolSchema } | null {
  const canonicalName = TOOL_ALIASES[name] ?? name;
  const meta = toolMetaForName(canonicalName);
  if (!meta) return null;
  return { name: canonicalName, schema: toolMetaToSchema(canonicalName, meta) };
}

/** Resolve tool metadata for a canonical name or compatibility alias. */
function toolMetaForName(name: string): ToolMeta | undefined {
  return TOOLS[name] ?? TOOLS[TOOL_ALIASES[name]];
}

/**
 * Withhold integration tools whose secret-backed connector is not configured.
 *
 * This extends the same "advertise a capability only when it is ready"
 * invariant the mod composition layer already enforces for integration cards
 * (contribution-resolver requires `state === "ready"`) to the static core tool
 * registry, which composition never sees. Without this, an unconfigured
 * integration tool (e.g. sentry with no SENTRY_* secrets) is handed to the
 * model unconditionally and fails on every call — a phantom capability.
 *
 * Only connectors with a cheap, definitive synchronous secret signal are gated.
 * `secretConnectorReadiness` returns `undefined` for OAuth/provider-backed
 * connectors (whose readiness needs principal-scoped async lists) and for
 * untagged tools, so this never hides a tool on uncertainty — it withholds only
 * on a proven "setup-required". Dispatch is keyed independently of the schema
 * set, so a deliberately-invoked unconfigured tool still routes to its handler
 * and returns the truthful "not configured" message.
 */
function withoutUnreadyIntegrationTools<T extends { name: string }>(schemas: T[]): T[] {
  const withheld: string[] = [];
  const filtered = schemas.filter((schema) => {
    const meta = toolMetaForName(schema.name);
    const connectorKey = meta?.connectorKey;
    if (!connectorKey || meta?.advertiseWhenUnready) return true;
    if (secretConnectorReadiness(connectorKey) === "setup-required") {
      withheld.push(schema.name);
      return false;
    }
    return true;
  });
  if (withheld.length > 0) {
    log.debug(`getToolSchemas: withheld ${withheld.length} unconfigured integration tool(s): ${withheld.join(", ")}`);
  }
  return filtered;
}

/**
 * Always-loaded core tools. Available to every persona regardless of its tool
 * bundle, because they are the minimum set required to communicate, orient,
 * reason, remember, manage work, and progressively load long-tail schemas.
 * Persona tool bundles are additive on top of this core; they never remove a core
 * tool. `tools` hydrates one authority-allowed schema for the current interactive
 * run, while `orient` can replace the whole initial working set by switching mode.
 */
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "orient",
  "question",
  "cognition",
  "memory",
  "goals",
  "tasks",
  "plan",
  "people",
  "library",
  "session",
  "tools",
]);

/**
 * Gate a tool-schema list by a persona's tool bundle.
 *
 * Semantics mirror persona context bundles: an empty (or absent) bundle means
 * "no gating" — every tool passes through, preserving today's behavior so no
 * existing persona regresses. A non-empty bundle defines the initial model tool
 * set as the always-on core plus explicit inclusions. This is separate from
 * authority filtering (what a session is *allowed* to call): interactive
 * `tools.get` may progressively hydrate one authority-allowed schema for the
 * current run without mutating the persona bundle.
 */
export function filterToolsForPersonaBundle<T extends { name: string }>(
  schemas: T[],
  bundle: string[] | null | undefined,
): T[] {
  if (!bundle || bundle.length === 0) return schemas;
  const included = new Set(bundle);
  return schemas.filter(schema => CORE_TOOL_NAMES.has(schema.name) || included.has(schema.name));
}

/**
 * Reconcile a mid-run persona-switch tool refresh against the pre-switch set.
 *
 * A persona switch changes persona *gating*, never authority. It must never be
 * able to reduce the callable set below the core tools that were already
 * available: losing orient/tools/session mid-run strands the agent with no way
 * to recover or switch back. `filterToolsForPersonaBundle` only *passes through*
 * core tools already present in the authority set — it cannot re-add them — so a
 * degraded authority resolution (null/restricted principal at refresh time)
 * yields an empty set that silently lobotomizes the run.
 *
 * This is the single structural guarantee for that invariant: if the refreshed
 * set is empty, or drops a core tool that was present before the switch, the
 * refresh is degraded and the caller keeps the last known-good set instead.
 */
export function reconcilePersonaSwitchToolSet<T extends { name: string }>(
  previous: T[],
  refreshed: T[],
): { tools: T[]; degraded: boolean; missingCore: string[] } {
  const previousCore = new Set(
    previous.filter(tool => CORE_TOOL_NAMES.has(tool.name)).map(tool => tool.name),
  );
  const refreshedNames = new Set(refreshed.map(tool => tool.name));
  const missingCore = [...previousCore].filter(name => !refreshedNames.has(name));
  const degraded = refreshed.length === 0 || missingCore.length > 0;
  return { tools: degraded ? previous : refreshed, degraded, missingCore };
}

export interface ToolCatalogEntry {
  name: string;
  description: string;
  category: string;
  isCore: boolean;
}

/** First sentence (or a bounded prefix) of a tool description, for compact catalog labels. */
function toolSummaryLine(description: string): string {
  const trimmed = (description || "").trim();
  const period = trimmed.indexOf(". ");
  const firstSentence = period > 0 ? trimmed.slice(0, period + 1) : trimmed;
  return firstSentence.length > 160 ? `${firstSentence.slice(0, 157).trimEnd()}…` : firstSentence;
}

/**
 * Catalog of agent tools a persona bundle can toggle, for the persona editor.
 * Core tools are marked so the UI can render them as always-on. Skill/bridge
 * tools are included by the same TOOLS source; the editor decides presentation.
 */
export function getToolCatalog(): ToolCatalogEntry[] {
  return Object.entries(TOOLS)
    .map(([name, meta]) => ({
      name,
      description: toolSummaryLine(meta.description),
      category: normalizeCategory(meta.category),
      isCore: CORE_TOOL_NAMES.has(name),
    }))
    .sort((a, b) => (a.isCore === b.isCore ? a.name.localeCompare(b.name) : a.isCore ? -1 : 1));
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
    jobs: { action: "list" },
    gmail: { action: "recent" },
    create_task: { title: "YOUR_TASK_TITLE" },
    complete_task: { title: "TASK_TITLE_TO_COMPLETE" },
    update_task: { title: "TASK_TITLE", priority: "high" },
    issues: { action: "create", title: "YOUR_ISSUE_TITLE" },
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
      const { chatFileStorage } = await import("./chat-file-storage");
      const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
      const sessions = await chatFileStorage.getAllSessions();
      const skillIds = new Set<string>();
      for (const session of sessions) {
        if (new Date(session.updatedAt).getTime() < cutoffMs) continue;
        if (!session.parentSessionId || !session.sessionKey?.startsWith("auto:")) continue;
        const skillId = session.sessionKey.slice(5);
        if (skillId) skillIds.add(skillId);
      }
      log.log(`getRecentlyUsedSkillIds: ${skillIds.size} skills used in sessions in last ${days} days: [${[...skillIds].join(", ")}]`);
      return skillIds;
    } catch (err: any) {
      log.warn(`getRecentlyUsedSkillIds failed: ${err.message}`);
      return new Set();
    }
  });
}

