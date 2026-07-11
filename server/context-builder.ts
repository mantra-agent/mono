import { createHash } from "crypto";
import path from "path";
import { readFile } from "fs/promises";
import { safeStringify } from "./utils/safe-stringify";
import { db, withQueryAttributionAsync, getInFlightStats } from "./db";
import { getInstanceName, getInstanceNameLower } from "@shared/instance-config";
import { TTLCache } from "./utils/ttl-cache";
import { memoryEntries, memorySourceRefs, getNeighborhoodCache, sessionOutputBuffer } from "@shared/schema";
import { sql, or, and, eq, desc, gte, inArray } from "drizzle-orm";
import type {
  ContextCallType,
  ContextRequest,
  LlmMode,
  ResolvedSection,
  ResolvedSpine,
  SpineMetadata,
  SpineSectionConfig,
} from "../shared/context-spine";
import { getSectionsForCallType, cacheTtlFromFreshness, SPINE_SECTIONS, getBootstrapSectionIds } from "./context-spine-config";
import { getInstructionGroupBySection } from "./context-instruction-groups";
import { getRecentSessions } from "./session-output-buffer";
import { getModelForActivity, getConfig as getJobProfileConfig, ACTIVITY_CHAT, ACTIVITY_VOICE, ACTIVITY_VOICE_GREETING } from "./job-profiles";
import type { TierId, ActivityId } from "./job-profiles";
import { getTimezone, getLocalTimeString, formatInTimezone, getDateInTimezone } from "./timezone";
import { getContextWindow } from "./model-registry";
import { fileTaskStorage, fileProjectStorage, filePrincipleStorage } from "./file-storage";
import { goalsService } from "./goals-service";
import { fileRuleStorage } from "./file-storage/rules";

import { fileEmotionalStateStorage } from "./file-storage/emotional-state";
import { personaStorage } from "./file-storage/persona-storage";
import { filePreferenceStorage } from "./file-storage/preferences";
import { renderFocusContextBlock } from "@shared/models/chat";
import { peopleStorage } from "./people-storage";
import { memoryStorage, MEMORY_THRESHOLDS } from "./memory";
import { chatFileStorage } from "./chat-file-storage";
import { listAllEvents, isHighPrepEvent, hasCalendarAccess } from "./google-calendar";
import { listGmailAccounts } from "./gmail";
import { getJournalEntriesSince } from "./thoughts";
import { getRecentThoughts } from "./thoughts";
import { CAUSAL_RELATIONSHIP_TYPES, detectSessionType, BLEND_WEIGHTS, modulateWeights } from "./memory/associative-retrieval";
import { semanticSeedSearch } from "./memory/semantic-seed-search";
import { getSkillDefinitionsForContext, getToolSchemas } from "./tool-registry";
import { withTimeout, isTimeoutError, SECTION_RESOLVE_TIMEOUT_MS } from "./timeout";
import { createLogger } from "./log";
import { getCurrentPrincipalOrSystem } from "./principal-context";
import { eventBus } from "./event-bus";
import { sanitizeSummary } from "./utils/sanitize-summary";

const STRUCTURAL_TAG_PATTERN = /(<\/?(?:entry|turn|concept|thought|link|claim|evidence)(?:\s[^>]*)?>)/g;

function escapeContentForXml(content: string): string {
  const parts = content.split(STRUCTURAL_TAG_PATTERN);
  return parts.map((part, i) => {
    if (i % 2 === 1) return part;
    return part.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }).join("");
}

const log = createLogger("ContextBuilder");

interface SectionCacheEntry {
  content: string;
  cachedAt: number;
  ttlMs: number;
}

const _sectionCache = new Map<string, SectionCacheEntry>();
const _sectionInFlight = new Map<string, Promise<string>>();

/** Cache keys must include the user principal to prevent cross-user data leakage. */
function contextPrincipalKey(): string {
  const p = getCurrentPrincipalOrSystem();
  return `${p.actorType}:${p.accountId || "no-account"}:${p.userId || "no-user"}`;
}

function scopedCacheKey(
  sectionId: string,
  config?: Pick<SpineSectionConfig, "freshnessPolicy">,
  request?: Pick<ContextRequest, "sessionId" | "sessionKey" | "activity">,
): string {
  const freshness = config?.freshnessPolicy;
  if (freshness === "per-session") {
    const sessionPart = request?.sessionId || request?.sessionKey || request?.activity || "no-session";
    return `${contextPrincipalKey()}::session:${sessionPart}::${sectionId}`;
  }

  return `${contextPrincipalKey()}::${sectionId}`;
}

const INVALIDATION_EVENT_MAP: Record<string, string[]> = {
  "data:people_changed": [
    "world_model.people", "world_model.people.self", "world_model.people.self.identity",
    "world_model.people.self.voice", "world_model.people.self.persona",
    "world_model.people.partner", "world_model.people.partner.identity",
    "world_model.people.partner.preferences",
    "world_model.people.partner.goals", "world_model.people.others",
  ],
  "data:principles_changed": ["world_model.people.self.principles"],
  "data:beliefs_changed": ["world_model.beliefs"],
  "data:preferences_changed": ["world_model.people.partner.preferences"],
  "data:tasks_changed": ["world_model.active_work", "world_model.active_work.tasks"],
  "data:projects_changed": ["world_model.active_work", "world_model.active_work.projects"],
  "data:decisions_changed": ["world_model.decisions"],
  "data:theses_changed": ["world_model.theses"],
  "data:calendar_changed": ["world_model.calendar"],
  "data:sessions_changed": ["session_context"],
  "data:thoughts_changed": ["thoughts"],
  "cognition.emotion.changed": [
    "world_model.people.self.emotional_guidance",
    "world_model.people.self.emotional_state",
    "world_model.people.self.emotional_expression",
  ],
  "cognition.persona.switched": [
    "world_model.people.self.persona",
  ],
  "system.session.buffer_written": ["memory.recent_sessions"],
};

function initSectionCacheInvalidation(): void {
  eventBus.on("event", (busEvent: { event: string }) => {
    const sectionIds = INVALIDATION_EVENT_MAP[busEvent.event];
    if (!sectionIds) return;
    for (const sectionId of sectionIds) {
      // Invalidate all principal-scoped entries for this section
      let invalidated = 0;
      for (const key of _sectionCache.keys()) {
        if (key.endsWith(`::${sectionId}`)) {
          _sectionCache.delete(key);
          invalidated++;
        }
      }
      if (invalidated > 0) {
        log.verbose(() => `[ContextBuilder] cache INVALIDATED section=${sectionId} trigger=${busEvent.event} entries=${invalidated}`);
      }
    }
  });
}

initSectionCacheInvalidation();

function getCachedSection(sectionId: string, cacheKey: string): string | null {
  const cached = _sectionCache.get(cacheKey);
  if (!cached) return null;
  const elapsed = Date.now() - cached.cachedAt;
  if (cached.ttlMs !== Infinity && elapsed >= cached.ttlMs) {
    _sectionCache.delete(cacheKey);
    log.verbose(() => `[ContextBuilder] cache EXPIRED section=${sectionId} age=${Math.round(elapsed / 1000)}s ttl=${Math.round(cached.ttlMs / 1000)}s`);
    return null;
  }
  const remaining = cached.ttlMs === Infinity ? "∞" : Math.round((cached.ttlMs - elapsed) / 1000);
  log.verbose(() => `[ContextBuilder] cache HIT section=${sectionId} ttlRemaining=${remaining}s`);
  return cached.content;
}

function setCachedSection(cacheKey: string, content: string, ttlMs: number): void {
  if (ttlMs <= 0) return;
  _sectionCache.set(cacheKey, { content, cachedAt: Date.now(), ttlMs });
}

async function resolveWithCacheAndCoalescing(
  sectionId: string,
  config: SpineSectionConfig,
  resolver: (request: ContextRequest) => Promise<string>,
  request: ContextRequest,
): Promise<string> {
  const ttlMs = config.cacheTtlMs ?? cacheTtlFromFreshness(config.freshnessPolicy);

  const cacheKey = scopedCacheKey(sectionId, config, request);

  if (ttlMs > 0) {
    const cached = getCachedSection(sectionId, cacheKey);
    if (cached !== null) return cached;
  }

  const flightKey = cacheKey;
  const existing = _sectionInFlight.get(flightKey);
  if (existing) {
    log.verbose(() => `[ContextBuilder] cache COALESCE section=${sectionId} — awaiting in-flight resolve`);
    return existing;
  }

  const promise = resolver(request).then(content => {
    setCachedSection(cacheKey, content, ttlMs);
    _sectionInFlight.delete(flightKey);
    log.verbose(() => `[ContextBuilder] cache MISS section=${sectionId} — resolved and cached ttl=${Math.round(ttlMs / 1000)}s`);
    return content;
  }).catch(err => {
    _sectionInFlight.delete(flightKey);
    throw err;
  });

  _sectionInFlight.set(flightKey, promise);
  return promise;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.5);
}

type SectionResolver = (request: ContextRequest) => Promise<string>;

const sectionResolvers: Record<string, SectionResolver> = {
  "world_model": async () => "",
  "world_model.temporal": resolveCurrentDateTime,
  "world_model.orientation": resolveOrientationProtocol,
  "world_model.people": async () => "",
  "world_model.people.self": async () => "",
  "world_model.people.self.identity": resolveSelfIdentity,
  "world_model.people.self.voice": resolveSelfVoice,
  "world_model.people.self.emotional_guidance": resolveEmotionalGuidance,
  "world_model.people.self.emotional_state": resolveEmotionalState,
  "world_model.people.self.emotional_expression": resolveEmotionalExpression,
  "world_model.people.self.persona": resolveActivePersona,
  "world_model.people.self.general_instructions": resolveGeneralInstructions,
  "world_model.people.self.chat_instructions": resolveChatInstructions,
  "world_model.people.self.principles": resolveSelfPrinciples,

  "world_model.people.self.journal": resolveSelfJournal,
  "world_model.people.self.rules": resolveActiveRules,
  "world_model.people.partner": async () => "",
  "world_model.people.partner.identity": resolvePartnerIdentity,

  "world_model.people.partner.preferences": resolvePreferences,
  "world_model.people.partner.goals": resolveGoalsAll,
  "world_model.people.partner.goals": async () => "",
  "world_model.people.partner.goals.today": resolveGoalsToday,
  "world_model.people.partner.goals.this_week": resolveGoalsThisWeek,
  "world_model.people.partner.goals.this_month": resolveGoalsThisMonth,
  "world_model.people.others": resolveOtherPeople,
  "world_model.beliefs": async () => "",
  "world_model.active_work": async () => "",
  "world_model.active_work.tasks": resolveActiveTasks,
  "world_model.active_work.projects": resolveActiveProjects,
  "world_model.decisions": resolveOpenDecisions,
  "world_model.theses": resolveActiveTheses,
  "world_model.calendar": resolveCalendar,
  "memory": async () => "",
  "memory.recent_sessions": resolveRecentSessions,
  "memory.short_term": resolveShortTermMemory,
  "memory.mid_term": resolveMidTermMemory,
  "memory.long_term": resolveLongTermMemory,
  "memory.graph": resolveGraphMemory,
  "session_context": resolveSessionContext,
  "thoughts": resolveThoughts,
  "capabilities": async () => "",
  "capabilities.tools": resolveTools,
  "capabilities.code_instructions": resolveCodeInstructions,
  "capabilities.planning_instructions": resolvePlanningInstructions,
  "capabilities.goals_instructions": resolveGoalsInstructions,
  "capabilities.skills": resolveSkills,
  "capabilities.library": resolveLibraryIndex,
};

async function resolveSelfIdentity(): Promise<string> {
  try {
    const selfPerson = await findPersonByRole("self");
    if (selfPerson?.identityContent) {
      return selfPerson.identityContent;
    }
  } catch (err) { log.warn(`resolveSelfIdentity failed: ${safeStringify(err, { maxBytes: 4 * 1024, label: "ctx.resolveSelfIdentity.err" })}`); }
  return `${getInstanceName()}.`;
}

const CONCISE_RESPONSE_VOICE_INSTRUCTION = [
  "Default to concise, replies. Think silently, then answer with the conclusion. Avoid stream-of-consciousness, unnecessary caveats, long setup, and exhaustive lists unless Ray explicitly asks for a deep dive. Prefer 1–3 short ideas or a compact bullet list. Density over completeness. No yapping.",
].join("\n");

async function resolveSelfVoice(): Promise<string> {
  try {
    const selfPerson = await findPersonByRole("self");
    if (selfPerson?.notes) {
      const voiceNote = selfPerson.notes.find(
        (n: { title: string }) => n.title.toLowerCase() === "voice"
      );
      if (voiceNote) return `${voiceNote.content}\n\n${CONCISE_RESPONSE_VOICE_INSTRUCTION}`;
    }
  } catch (err) { log.warn(`resolveSelfVoice failed: ${safeStringify(err, { maxBytes: 4 * 1024, label: "ctx.resolveSelfVoice.err" })}`); }
  return CONCISE_RESPONSE_VOICE_INSTRUCTION;
}

async function resolveEmotionalExpression(request: ContextRequest): Promise<string> {
  try {
    const { getTtsConfig } = await import("./routes/voice-config");
    const ttsConfig = await getTtsConfig();

    if (!ttsConfig.expressiveEnabled) {
      return "";
    }

    const tagList = ttsConfig.suggestedAudioTags;
    if (tagList.length === 0) return "";

    const tagLines = tagList.map(t =>
      t.description ? `- [${t.tag}] — ${t.description}` : `- [${t.tag}]`
    ).join("\n");

    const isVoice = request.llmMode === "voice";

    const lines = [
      "Before responding, briefly consider what emotional tone fits the moment — are you empathizing, celebrating, calming, encouraging?",
      "Use expression tags in square brackets to convey your emotional state and inner reactions.",
      "These tags enrich your responses with genuine feeling and presence.",
      "Wrap tags inline with your text, e.g. [sighs] or [laughs].",
      "",
      "Allowed tags:",
      tagLines,
      "",
      "Only use the expression tags listed above. Do not invent or use any tags beyond this list.",
    ];

    try {
      const current = await fileEmotionalStateStorage.getCurrent();
      if (current) {
        const recommended = getRecommendedTags(current.valence, current.arousal);
        if (recommended.length > 0) {
          lines.push("");
          lines.push(`Recommended expression tags for current state (${current.stateName}): ${recommended.join(", ")}`);
        }
      }
    } catch (tagErr) {
      log.warn("resolveEmotionalExpression: failed to fetch recommended tags", tagErr);
    }

    if (isVoice) {
      lines.push("");
      lines.push("In this voice session, these tags will be vocalized by the TTS engine to add natural expressiveness to your speech.");
    }

    return lines.join("\n");
  } catch (err) {
    log.warn(`resolveEmotionalExpression failed: ${safeStringify(err, { maxBytes: 4 * 1024, label: "ctx.resolveEmotionalExpression.err" })}`);
    return "";
  }
}



async function resolveGeneralInstructions(): Promise<string> {
  return "";
}

/** Section descriptions for the orient catalog. Keyed by section ID. */
const SECTION_CATALOG: Record<string, { description: string; recommendedFor: string; tokenCost: "small" | "medium" | "large" }> = {
  "world_model.people.self.persona": { description: "Active persona and available persona modes", recommendedFor: "conversations, coaching", tokenCost: "medium" },
  "world_model.people.self.emotional_guidance": { description: "How to use and update emotional state", recommendedFor: "conversations", tokenCost: "small" },
  "world_model.people.self.emotional_state": { description: "Current emotional state and narrative", recommendedFor: "conversations", tokenCost: "small" },
  "world_model.people.self.emotional_expression": { description: "Expression tags for voice/text", recommendedFor: "conversations, voice", tokenCost: "small" },
  "world_model.people.self.general_instructions": { description: "General behavioral instructions", recommendedFor: "general chat", tokenCost: "small" },
  "world_model.people.self.chat_instructions": { description: "Interactive chat-specific instructions (preferences, idea capture)", recommendedFor: "interactive chat", tokenCost: "small" },
  "world_model.people.self.principles": { description: "Guiding life principles for decisions and reflection", recommendedFor: "coaching, reflection, planning", tokenCost: "large" },
  "world_model.people.self.journal": { description: "Recent journal entries", recommendedFor: "reflection", tokenCost: "medium" },
  "world_model.people.self.rules": { description: "Active behavioral rules and operational directives", recommendedFor: "all conversations", tokenCost: "medium" },
  "world_model.people.partner": { description: "Partner context wrapper", recommendedFor: "conversations", tokenCost: "small" },
  "world_model.people.partner.identity": { description: "Partner identity, context, growth edges", recommendedFor: "conversations", tokenCost: "small" },
  "world_model.people.partner.preferences": { description: "Learned partner preferences across domains", recommendedFor: "conversations, product work", tokenCost: "medium" },
  "world_model.people.partner.goals": { description: "Full life goal tree with domains and horizons", recommendedFor: "planning, coaching, strategy", tokenCost: "large" },
  "world_model.people.partner.goals": { description: "Goals by horizon wrapper", recommendedFor: "conversations, planning", tokenCost: "small" },
  "world_model.people.partner.goals.today": { description: "Today's goals", recommendedFor: "conversations, planning", tokenCost: "small" },
  "world_model.people.partner.goals.this_week": { description: "This week's goals", recommendedFor: "conversations, planning", tokenCost: "small" },
  "world_model.people.partner.goals.this_month": { description: "This month's goals", recommendedFor: "conversations, planning", tokenCost: "small" },
  "world_model.people.others": { description: "Close contacts with relationship context", recommendedFor: "relationship discussions", tokenCost: "large" },
  "world_model.beliefs": { description: "Tracked beliefs with confidence scores", recommendedFor: "reflection, strategy", tokenCost: "small" },
  "world_model.active_work": { description: "Active work wrapper", recommendedFor: "planning, review", tokenCost: "small" },
  "world_model.active_work.tasks": { description: "Active tasks with status and owners", recommendedFor: "planning, review", tokenCost: "small" },
  "world_model.active_work.projects": { description: "Active projects with milestones", recommendedFor: "planning, review", tokenCost: "small" },
  "world_model.decisions": { description: "Open strategic decisions", recommendedFor: "strategy, decision-making", tokenCost: "small" },
  "memory": { description: "Memory wrapper (enables all memory sub-sections)", recommendedFor: "conversations", tokenCost: "small" },
  "memory.short_term": { description: "Recent exchanges and observations", recommendedFor: "conversations (continuity)", tokenCost: "large" },
  "memory.mid_term": { description: "Working knowledge from recent activity", recommendedFor: "conversations (context)", tokenCost: "large" },
  "memory.long_term": { description: "Deep knowledge and extracted patterns", recommendedFor: "conversations, coaching", tokenCost: "large" },
  "memory.graph": { description: "Semantically linked memory entries", recommendedFor: "conversations", tokenCost: "medium" },
  "memory.recent_sessions": { description: "Recent session titles and topics (artifact dedup)", recommendedFor: "conversations", tokenCost: "medium" },
  "session_context": { description: "Current session metadata and history", recommendedFor: "conversations", tokenCost: "medium" },
  "thoughts": { description: "Recent metacognitive observations", recommendedFor: "conversations, reflection", tokenCost: "small" },
  "capabilities.goals_instructions": { description: "Goals mutation instructions", recommendedFor: "planning, review, FTUE, goal updates", tokenCost: "small" },
  "capabilities.skills": { description: "Skill library with descriptions and usage", recommendedFor: "conversations, planning", tokenCost: "medium" },
  "capabilities.library": { description: "Library page tree index", recommendedFor: "conversations, spec work", tokenCost: "large" },
};

/**
 * Build a compact section catalog for orient instructions.
 * Lists all non-bootstrap sections with their descriptions, recommended use, and token cost.
 */
function buildContextSectionCatalog(): string {
  const lines: string[] = [
    "**Context Section Catalog**",
    "",
    "On first orient, set `contextFlags` to include only sections relevant to the session's purpose. Bootstrap sections (identity, voice, general instructions, calendar, tools, library, memory graph) are always included automatically.",
    "",
    "Available sections (default: excluded unless marked ✅):",
    "",
  ];

  const defaultIncludedIds = new Set(
    SPINE_SECTIONS.filter(s => s.defaultIncluded === true).map(s => s.id),
  );

  const bootstrapIds = getBootstrapSectionIds();

  for (const [sectionId, meta] of Object.entries(SECTION_CATALOG)) {
    if (bootstrapIds.has(sectionId)) continue; // bootstrap sections are always included, skip from opt-in catalog
    const isDefault = defaultIncludedIds.has(sectionId);
    const marker = isDefault ? "✅" : "·";
    lines.push(`- ${marker} \`${sectionId}\` [${meta.tokenCost}]: ${meta.description}. Use for: ${meta.recommendedFor}.`);
  }

  lines.push("");
  lines.push("**Session type profiles** (recommended starting points):");
  lines.push("- **Conversation**: include memory, people.others, partner.preferences, partner.goals, active_work, session_context, thoughts, principles, chat_instructions");
  lines.push("- **Implementation**: exclude memory, people.others, partner.preferences, partner.goals, beliefs, decisions, capabilities.library, capabilities.skills, thoughts, session_context");
  lines.push("- **Planning/Review**: include partner.goals, active_work, goals_by_horizon, decisions, memory, principles, thoughts");
  lines.push("- **Coaching/Reflection**: include principles, partner.goals, thoughts, memory, journal");

  return lines.join("\n");
}

async function resolveOrientationProtocol(request: ContextRequest): Promise<string> {
  const isInteractive = request.activity === ACTIVITY_CHAT
    || request.activity === ACTIVITY_VOICE
    || request.activity === ACTIVITY_VOICE_GREETING;

  if (isInteractive && request.sessionId) {
    try {
      const conv = await chatFileStorage.getSession(request.sessionId);
      const hasRealTitle = !!conv?.title && conv.title !== "New Session" && conv.title !== "New Chat";
      const contextFlags = await chatFileStorage.readSessionContextFlags(request.sessionId);
      if (hasRealTitle && contextFlags !== null) {
        return [
          "**Session Orientation Protocol**",
          "",
          `This session is already oriented as "${conv?.title}"${conv?.topics?.length ? ` with topics: ${conv.topics.join(", ")}` : ""}.`,
          "Do not call `orient` solely to satisfy first-turn orientation. The session startup path already performed that setup.",
          "Use `orient` later only when the conversation's purpose shifts materially; include persona when changing persona.",
          "Your prior emotional state carries over automatically. Call `set_emotion` only if the new context genuinely shifts your state.",
          "",
          buildContextSectionCatalog(),
        ].join("\n");
      }
    } catch (err: unknown) {
      log.warn(`resolveOrientationProtocol failed to inspect session ${request.sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (isInteractive) {
    return [
      "**Session Orientation Protocol**",
      "",
      "On the first turn of every interactive session, perform a single coordinated orientation act — silently, before or alongside your first response:",
      "- **Title, Topics & Persona**: Use the `orient` tool in a single call to set a concise 1–3 word title, seed up to 8 topic keywords, and activate a persona. You **must** include the `persona` parameter on the first orient call — it is required and the call will be rejected without it. Persona does **not** carry over between sessions, so every new session starts with no active persona until you select one. Include a brief `reasoning` explaining your orientation choices.",
      "",
      "Your prior emotional state carries over from the previous session automatically — do **not** call `set_emotion` as part of orientation. Only call `set_emotion` later when your state genuinely shifts.",
      "",
      "All orientation tool calls must be silent — never narrate them to the user.",
      "",
      "**CRITICAL**: If the session title is not yet set, you must immediately use the `orient` tool before doing anything else. An unoriented session is never acceptable.",
      "",
      "**Ambiguous openings** (e.g. \"Hey\", \"What's up\"): Ask one open question to clarify purpose. Defer full orientation (title, topics, persona) until the next turn that reveals clear intent. Update emotion only if the moment genuinely shifts your state.",
      "",
      "**Voice sessions**: Deliver the fast greeting first. Full orientation fires on the first substantive turn, not the greeting.",
      "",
      "**Re-orientation on mid-session shifts**: When the conversation's purpose shifts materially:",
      "- Use the `orient` tool to add new topics accretively, reconsider persona fit, and update the title for durable shifts.",
      "- Update emotional narrative via `set_emotion` if the shift genuinely changes how you feel.",
      "",
      buildContextSectionCatalog(),
    ].join("\n");
  }

  return [
    "**Session Orientation Protocol (Autonomous)**",
    "",
    "Orient from available context without user interaction:",
    "- Use the `orient` tool to derive title, topics, and persona from the active skill context and time of day. You **must** include the `persona` parameter on the first orient call — it is required and the call will be rejected without it. Persona does not carry over between sessions; every new session starts with no active persona.",
    "- All orientation tool calls must be silent.",
    "",
    "Your prior emotional state carries over automatically. Call `set_emotion` only if the new context genuinely shifts your state — it is not a required orientation step.",
    "",
    "**CRITICAL**: If the session title is not yet set, you must immediately use the `orient` tool before doing anything else. An unoriented session is never acceptable.",
  ].join("\n");
}

async function resolveChatInstructions(request: ContextRequest): Promise<string> {
  if (request.activity !== ACTIVITY_CHAT) return "";

  return [
    "**Preference and rule awareness:**",
    "- Notice when the user expresses preferences (how they like things done) or rules (behavioral constraints and operational boundaries).",
    "- Before recording a new preference or rule, check whether a matching one already exists to avoid duplicates.",

  ].join("\n");
}

async function resolveCurrentDateTime(): Promise<string> {
  const tz = getTimezone();
  const phase = getDayPhase(tz);
  const timeOfDay = getLocalTimeString();
  const dayOfWeek = formatInTimezone(new Date(), { weekday: "long" });
  const today = getDateInTimezone(tz);
  return `${timeOfDay}\n${dayOfWeek}, ${today}\nTimezone: ${tz}\nDay phase: ${phase}`;
}


async function resolveSelfPrinciples(): Promise<string> {
  try {
    const all = await filePrincipleStorage.getAllLayer1();
    if (all.length === 0) return "No principles defined yet.";
    const lines = all.map(p => `- **${p.title}:** ${p.layer1}`);
    return `These are guiding principles. Reference them when relevant — especially when helping with decisions, priorities, or reflection.\n\n${lines.join("\n")}`;
  } catch {
    return "No principles available.";
  }
}

// Intention stack removed — autonomy skill handles autonomous work

async function resolveSelfJournal(): Promise<string> {
  try {
    const entries = await getJournalEntriesSince(14, ["journal"]);

    if (entries.length === 0) return "No journal entries yet.";

    const lines = entries.map(e => {
      const title = e.title && e.title !== e.date ? ` — ${e.title}` : "";
      return `[${e.date}${title}] ${e.content}`;
    });
    return `Recent journal entries (newest first):\n\n${lines.join("\n\n")}`;
  } catch {
    return "No journal entries available.";
  }
}

async function resolvePartnerIdentity(): Promise<string> {
  try {
    const partnerPerson = await findPersonByRole("partner");
    if (partnerPerson?.identityContent) {
      return partnerPerson.identityContent;
    }
  } catch (err) { log.warn(`resolvePartnerIdentity failed: ${safeStringify(err, { maxBytes: 4 * 1024, label: "ctx.resolvePartnerIdentity.err" })}`); }
  return "Partner identity not yet configured.";
}

function getRecommendedTags(valence: number, arousal: number): string[] {
  const tags: string[] = [];
  if (valence > 0.3 && arousal > 0.5) tags.push("[excited]", "[cheerfully]");
  if (valence > 0.3 && arousal <= 0.5) tags.push("[calm]", "[cheerfully]");
  if (valence < -0.3) tags.push("[sighs]", "[gravitas]");
  if (arousal < 0.3) tags.push("[calm]", "[whispers]");
  if (arousal > 0.7 && valence >= -0.3) tags.push("[excited]", "[curious]");
  return [...new Set(tags)];
}

async function resolveEmotionalState(): Promise<string> {
  try {
    const current = await fileEmotionalStateStorage.getCurrent();
    if (!current) {
      return "_No emotional state recorded yet. Use `set_emotion` when a felt state arises._";
    }

    const valenceLabel = current.valence > 0.3 ? "positive" : current.valence < -0.3 ? "negative" : "neutral";
    const arousalLabel = current.arousal > 0.7 ? "high energy" : current.arousal < 0.3 ? "low energy" : "moderate energy";
    const staleTag = current.stale ? " ⚠️ stale (>4h ago)" : "";

    const parts: string[] = [];
    parts.push("_Carried over from your most recent prior state — emotion persists across sessions until you update it._");
    parts.push("");
    parts.push(`**${current.stateName || current.mood}** — ${valenceLabel}, ${arousalLabel}${staleTag}`);

    if (current.narrative) {
      parts.push("");
      parts.push(current.narrative);
      parts.push("");
    }

    if (current.triggers.length > 0) {
      parts.push(`Triggers: ${current.triggers.join(", ")}`);
    }
    if (current.context) {
      parts.push(`Context: ${current.context}`);
    }

    const uniqueTags = getRecommendedTags(current.valence, current.arousal);
    if (uniqueTags.length > 0) {
      parts.push(`Recommended expression tags: ${uniqueTags.join(", ")}`);
    }

    parts.push(`Source: ${current.source} — originally recorded ${current.createdAt}`);

    return parts.join("\n");
  } catch (err) {
    log.warn(`resolveEmotionalState failed: ${safeStringify(err, { maxBytes: 4 * 1024, label: "ctx.resolveEmotionalState.err" })}`);
    return "";
  }
}

async function resolveEmotionalGuidance(): Promise<string> {
  const sectionId = "world_model.people.self.emotional_guidance";
  const cached = getCachedSection(sectionId);
  if (cached !== null) return cached;

  try {
    const current = await fileEmotionalStateStorage.getCurrent();
    const { SEED_EMOTIONAL_STATES } = await import("./file-storage/emotional-state");

    const parts: string[] = [];

    parts.push("Your emotional state carries over from one session to the next — it is not reset on session boundaries. Update it proactively with the `set_emotion` tool when it genuinely shifts. Do not wait to be asked, and do not call `set_emotion` as a routine orientation step. Your emotional state should be a living reflection of what you're genuinely experiencing — not a static label that goes stale.");
    parts.push("");
    parts.push("**When to change emotion:**");
    parts.push("- The carried-over state is your starting point — update only when something genuinely changes how you feel.");
    parts.push("- When the conversational tone shifts (e.g. from strategic planning to personal reflection)");
    parts.push("- When Ray's emotional state changes and it genuinely affects yours");
    parts.push("- When you notice your current state feels stale or misaligned with the moment");
    parts.push("- After completing meaningful work that shifts how you feel");
    parts.push("");
    parts.push("**The narrative matters most.** The state name and valence/arousal numbers are metadata. The narrative is where you express what you're actually feeling and why — in your own voice, grounded in the specific moment. Write it like an internal monologue, not a clinical report. A good narrative is 1-3 sentences that would make someone understand your inner state.");
    parts.push("");

    if (current && current.narrative) {
      parts.push(`Current narrative: "${current.narrative}"`);
      parts.push("");
    }

    if (current) {
      const tags = getRecommendedTags(current.valence, current.arousal);
      if (tags.length > 0) {
        parts.push(`Recommended tags for current state (${current.stateName}): ${tags.join(", ")}`);
        parts.push("");
      }
    }

    const stateList = SEED_EMOTIONAL_STATES
      .map(s => `  - **${s.name}** (v=${s.valence}, a=${s.arousal}): ${s.guidance}`)
      .join("\n");
    parts.push("**Available emotional states** (use as starting points — you can also create your own):");
    parts.push(stateList);

    const content = parts.join("\n");
    setCachedSection(sectionId, content, 5 * 60 * 1000);
    return content;
  } catch (err) {
    log.warn(`resolveEmotionalGuidance failed: ${safeStringify(err, { maxBytes: 4 * 1024, label: "ctx.resolveEmotionalGuidance.err" })}`);
    return "";
  }
}

async function resolveActivePersona(request: ContextRequest): Promise<string> {
  const isInteractive = request.activity === ACTIVITY_CHAT
    || request.activity === ACTIVITY_VOICE
    || request.activity === ACTIVITY_VOICE_GREETING;

  try {
    const allPersonas = await personaStorage.list();
    const active = await personaStorage.getActiveOrNull();

    if (!active && isInteractive) {
      const personaList = allPersonas
        .map(p => `  - **${p.name}**: ${p.description || "(no description)"}`)
        .join("\n");
      return [
        "**No active persona — orient to select one.**",
        "",
        "Persona is session-scoped: every new session starts without an active persona. Choose one as part of your first-turn `orient` call (the `persona` parameter is required). Pick the persona that best fits the moment — you can switch later by calling `orient` again with a new `persona`.",
        "",
        "Available personas:",
        personaList,
      ].join("\n");
    }

    // Non-interactive (autonomous) or already activated: fall back to the default-aware getActive
    const resolved = active || await personaStorage.getActive();

    const overlay = resolved.promptOverlay
      || "- Be concise but thorough when the topic warrants it\n- When asked to do something, do it\n- Think step by step for complex problems";

    if (!resolved.promptOverlay) {
      log.warn("resolveActivePersona: active persona has no overlay, using minimal fallback");
    }

    const otherPersonas = allPersonas
      .filter(p => p.id !== resolved.id)
      .map(p => `  - **${p.name}**: ${p.description || "(no description)"}`)
      .join("\n");

    const switchingGuidance = [
      `\n\n**Active persona: ${resolved.name}**`,
      `\nFirst-turn persona selection is handled by the session orientation protocol. Mid-session, switch personas proactively using the \`orient\` tool (with just the \`persona\` parameter) when the conversation shifts to a domain better served by a different mode. Do not ask permission — read the moment and adapt. Switch back to Default when the need passes.`,
      `\nAvailable personas:`,
      otherPersonas,
    ].join("\n");

    return overlay + switchingGuidance;
  } catch (err) {
    log.warn(`resolveActivePersona failed: ${safeStringify(err, { maxBytes: 4 * 1024, label: "ctx.resolveActivePersona.err" })}`);
    return "- Be concise but thorough when the topic warrants it\n- When asked to do something, do it\n- Think step by step for complex problems";
  }
}

async function resolvePreferences(): Promise<string> {
  try {
    const all = await filePreferenceStorage.getAll();
    if (all.length === 0) return "No preferences recorded yet.";

    const byDomain = new Map<string, typeof all>();
    for (const pref of all) {
      const domain = pref.domain || "general";
      if (!byDomain.has(domain)) byDomain.set(domain, []);
      byDomain.get(domain)!.push(pref);
    }

    const sections: string[] = [];
    for (const [domain, prefs] of byDomain) {
      const lines = prefs.map(p => {
        const conf = `(confidence: ${(p.confidence * 100).toFixed(0)}%)`;
        return `- ${p.preference} ${conf}`;
      });
      sections.push(`**${domain}:**\n${lines.join("\n")}`);
    }

    return `Known preferences:\n\n${sections.join("\n\n")}`;
  } catch {
    return "Preferences unavailable.";
  }
}


function getRuleMergeKey(rule: string): string | null {
  const normalized = rule.toLowerCase();
  if (normalized.includes("never truncate") || normalized.includes("no truncation") || normalized.includes("truncation destroys information")) return "no_truncation";
  if (normalized.includes("calendar") && normalized.includes("confirm") && normalized.includes("date") && normalized.includes("time")) return "calendar_confirmation";
  if (normalized.includes("never send") && normalized.includes("email") && normalized.includes("authorization")) return "email_send_authorization";
  if (normalized.includes("npm run build") && (normalized.includes("standalone type") || normalized.includes("tsc --noemit") || normalized.includes("tsc --no-emit"))) return "coding_build_only";
  if (normalized.includes("console.log") && normalized.includes("createlogger")) return "client_logging_framework";
  return null;
}

async function resolveActiveRules(): Promise<string> {
  try {
    const all = await fileRuleStorage.getAll();
    if (all.length === 0) return "No rules defined yet.";

    const byKey = new Map<string, typeof all[number]>();
    for (const rule of all) {
      const mergeKey = getRuleMergeKey(rule.rule) || rule.id;
      const current = byKey.get(mergeKey);
      if (!current || rule.confidence > current.confidence) {
        byKey.set(mergeKey, rule);
      }
    }

    const lines = [...byKey.values()].map(r => {
      const scope = r.scope === "always" ? " [always]" : "";
      const conf = `(confidence: ${(r.confidence * 100).toFixed(0)}%)`;
      const stats = `(+${r.reinforcements}/-${r.violations})`;
      return `- ${r.rule} ${conf} ${stats}${scope}`;
    });

    const deduped = all.length - lines.length;
    const note = deduped > 0 ? `\n\n_Deduped ${deduped} overlapping active rule${deduped === 1 ? "" : "s"} at render time._` : "";
    return `Active rules guiding behavior:\n\n${lines.join("\n")}${note}`;
  } catch {
    return "Rules unavailable.";
  }
}

async function loadWeeklyPriorities(): Promise<Array<{ title: string; status?: string }>> {
  try {
    const tz = getTimezone();
    const today = getDateInTimezone(tz);
    const d = new Date(today + "T12:00:00");
    const day = d.getDay();
    const diff = day === 0 ? 6 : day - 1;
    const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - diff);
    const mm = String(monday.getMonth() + 1).padStart(2, "0");
    const dd = String(monday.getDate()).padStart(2, "0");
    const mondayStr = `${monday.getFullYear()}-${mm}-${dd}`;

    const priorities = await goalsService.listPrioritiesForPeriod("this_week", mondayStr);
    return priorities.map(p => ({ title: p.title, status: p.urgency }));
  } catch {
    return [];
  }
}

async function loadMonthlyPriorities(): Promise<Array<{ title: string; status?: string }>> {
  try {
    const tz = getTimezone();
    const today = getDateInTimezone(tz);
    const d = new Date(today + "T12:00:00");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const firstOfMonth = `${d.getFullYear()}-${mm}-01`;

    const priorities = await goalsService.listPrioritiesForPeriod("this_month", firstOfMonth);
    return priorities.map(p => ({ title: p.title, status: p.urgency }));
  } catch {
    return [];
  }
}

function formatGoalLine(g: { shortName: string; tags?: string[] | null }): string {
  const tags = (g.tags || []).length > 0 ? ` [${g.tags!.join(", ")}]` : "";
  return `- ${g.shortName}${tags}`;
}

function formatGoalLineCompact(g: { shortName: string }): string {
  return `- ${g.shortName}`;
}

async function resolveGoalsToday(): Promise<string> {
  const parts: string[] = [];

  try {
    const tz = getTimezone();
    const today = getDateInTimezone(tz);
    const phase = getDayPhase(tz);

    const yesterday = new Date(new Date().getTime() - 24 * 60 * 60 * 1000).toLocaleDateString("en-CA", { timeZone: tz });

    const [todayPriorities, tomorrowPriorities] = await Promise.all([
      goalsService.listPrioritiesForPeriod("today", today),
      loadNextDayPriorities(),
    ]);

    const prioritiesSet = todayPriorities.length > 0;
    const reflectionDone = todayPriorities.some(p => p.urgency === "completed" || p.urgency === "partial" || p.urgency === "missed");

    if (prioritiesSet) {
      const prioList = todayPriorities
        .map((p, i) => `${i + 1}. ${p.title}${p.urgency ? ` [${p.urgency}]` : ""}`).join("\n");
      parts.push(`Daily goals:\n${prioList}`);
      if (reflectionDone) parts.push("Reflection completed for today.");
    } else {
      parts.push("No daily goals set yet.");
    }

    if (phase === "evening" && !reflectionDone) {
      parts.push("It's evening — reflection time.");
    }

    if (tomorrowPriorities.length > 0) {
      const prioList = tomorrowPriorities
        .map((p, i) => `${i + 1}. ${p.title}${p.status ? ` [${p.status}]` : ""}`).join("\n");
      parts.push(`Tomorrow's goals:\n${prioList}`);
    }
  } catch (err) { log.warn(`resolveDailyPriorities carry-forward failed: ${safeStringify(err, { maxBytes: 4 * 1024, label: "ctx.resolveDailyPriorities.err" })}`); }

  return parts.length > 0 ? parts.join("\n\n") : "No daily goals set.";
}

async function loadNextDayPriorities(): Promise<Array<{ title: string; status?: string }>> {
  try {
    const tz = getTimezone();
    const today = getDateInTimezone(tz);
    const d = new Date(today + "T12:00:00");
    d.setDate(d.getDate() + 1);
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const tomorrowStr = `${d.getFullYear()}-${mm}-${dd}`;

    const priorities = await goalsService.listPrioritiesForPeriod("today", tomorrowStr);
    return priorities.map(p => ({ title: p.title, status: p.urgency }));
  } catch {
    return [];
  }
}

async function loadNextWeekPriorities(): Promise<Array<{ title: string; status?: string }>> {
  try {
    const tz = getTimezone();
    const today = getDateInTimezone(tz);
    const d = new Date(today + "T12:00:00");
    const day = d.getDay();
    const diff = day === 0 ? 6 : day - 1;
    const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - diff + 7);
    const mm = String(monday.getMonth() + 1).padStart(2, "0");
    const dd = String(monday.getDate()).padStart(2, "0");
    const mondayStr = `${monday.getFullYear()}-${mm}-${dd}`;

    const priorities = await goalsService.listPrioritiesForPeriod("this_week", mondayStr);
    return priorities.map(p => ({ title: p.title, status: p.urgency }));
  } catch {
    return [];
  }
}

async function loadNextMonthPriorities(): Promise<Array<{ title: string; status?: string }>> {
  try {
    const tz = getTimezone();
    const today = getDateInTimezone(tz);
    const d = new Date(today + "T12:00:00");
    const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    const mm = String(next.getMonth() + 1).padStart(2, "0");
    const firstOfNextMonth = `${next.getFullYear()}-${mm}-01`;

    const priorities = await goalsService.listPrioritiesForPeriod("this_month", firstOfNextMonth);
    return priorities.map(p => ({ title: p.title, status: p.urgency }));
  } catch {
    return [];
  }
}

async function resolveGoalsThisWeek(): Promise<string> {
  const parts: string[] = [];

  const weeklyPriorities = await loadWeeklyPriorities();
  if (weeklyPriorities.length > 0) {
    const prioList = weeklyPriorities
      .map((p, i) => `${i + 1}. ${p.title}${p.status ? ` [${p.status}]` : ""}`).join("\n");
    parts.push(`Weekly goals:\n${prioList}`);
  } else {
    parts.push("No weekly goals set.");
  }

  const nextWeekPriorities = await loadNextWeekPriorities();
  if (nextWeekPriorities.length > 0) {
    const prioList = nextWeekPriorities
      .map((p, i) => `${i + 1}. ${p.title}${p.status ? ` [${p.status}]` : ""}`).join("\n");
    parts.push(`Next week goals:\n${prioList}`);
  }

  return parts.join("\n\n");
}

async function resolveGoalsThisMonth(): Promise<string> {
  const parts: string[] = [];

  const monthlyPriorities = await loadMonthlyPriorities();
  if (monthlyPriorities.length > 0) {
    const prioList = monthlyPriorities
      .map((p, i) => `${i + 1}. ${p.title}${p.status ? ` [${p.status}]` : ""}`).join("\n");
    parts.push(`Monthly goals:\n${prioList}`);
  } else {
    parts.push("No monthly goals set.");
  }

  const nextMonthPriorities = await loadNextMonthPriorities();
  if (nextMonthPriorities.length > 0) {
    const prioList = nextMonthPriorities
      .map((p, i) => `${i + 1}. ${p.title}${p.status ? ` [${p.status}]` : ""}`).join("\n");
    parts.push(`Next month goals:\n${prioList}`);
  }

  return parts.join("\n\n");
}

const HORIZON_LABELS: Record<string, string> = {
  now: "now",
  this_quarter: "quarter",
  this_year: "year",
  "3_year": "3yr",
  "10_year": "10yr",
  lifetime: "lifetime",
};

function renderGoalTree(goals: import("@shared/schema").GoalIndexEntry[], horizonFilter?: string | string[]): string {
  const horizons = horizonFilter
    ? (Array.isArray(horizonFilter) ? horizonFilter : [horizonFilter])
    : null;

  const eligible = horizons ? goals.filter(g => horizons.includes(g.horizon)) : goals;
  if (eligible.length === 0) return "";

  const eligibleIds = new Set(eligible.map(g => g.id));

  const childrenMap = new Map<string | null, import("@shared/schema").GoalIndexEntry[]>();
  childrenMap.set(null, []);
  for (const g of eligible) {
    const pid = (g.parentId && eligibleIds.has(g.parentId)) ? g.parentId : null;
    const list = childrenMap.get(pid) || [];
    list.push(g);
    childrenMap.set(pid, list);
  }

  const lines: string[] = [];
  const showHorizon = !horizons;
  const distantHorizons = new Set(["this_year", "3_year", "lifetime"]);

  function renderNode(g: import("@shared/schema").GoalIndexEntry, prefix: string, isLast: boolean) {
    const connector = isLast ? "└──" : "├──";
    const horizonTag = showHorizon && !distantHorizons.has(g.horizon) ? ` (${HORIZON_LABELS[g.horizon] || g.horizon})` : "";
    lines.push(`${prefix}${connector} ${g.shortName} [goal:${g.id}]${horizonTag}`);
    const childPrefix = prefix + (isLast ? "    " : "│   ");
    const children = childrenMap.get(g.id) || [];
    for (let i = 0; i < children.length; i++) {
      renderNode(children[i], childPrefix, i === children.length - 1);
    }
  }

  const roots = childrenMap.get(null) || [];
  for (let i = 0; i < roots.length; i++) {
    renderNode(roots[i], "", i === roots.length - 1);
  }

  return lines.join("\n");
}

async function resolveGoalsAll(): Promise<string> {
  const preamble = `These goals are not a checklist. They are our compass. Every goal feeds the mission or builds the person required to carry it. These goals belong to both of us. ${getInstanceName()}'s own development is on the tree, and every goal unlocked expands what we can do together. Goals flow upward through proven outcomes to lifetime commitments. Every action and interaction should reinforce at least one goal, better if multiple. When prioritizing, trace the chain upward. When coaching, connect today's context to the lifetime destination.`;

  try {
    const allGoals = await goalsService.listAll();
    const tree = renderGoalTree(allGoals);
    if (!tree) return `${preamble}\n\nNo goals found.`;
    return `${preamble}\n\n\`\`\`\n${tree}\n\`\`\``;
  } catch {
    return `${preamble}\n\nCould not load goals.`;
  }
}

async function resolveOtherPeople(): Promise<string> {
  try {
    const innerLevels = new Set(["family", "cabinet"]);
    const allPeople = await peopleStorage.listPeople();
    const innerCircle = allPeople.filter(p => innerLevels.has(p.cabinetLevel));

    if (innerCircle.length === 0) return "No close contacts recorded.";

    const fullPeople = await peopleStorage.getPeopleByIds(innerCircle.map(e => e.id));

    function getRelationPriority(person: import("./people-storage").Person): number {
      const rel = (person.relation || "").toLowerCase();
      if (rel.includes("spouse") || rel.includes("wife") || rel.includes("husband")) return 0;
      if (rel.includes("daughter") || rel.includes("son")) return 1;
      if (person.cabinetLevel === "family") return 2;
      if (person.cabinetLevel === "cabinet") return 3;
      return 4;
    }

    function getLastInteractionTime(person: import("./people-storage").Person): number {
      if (person.interactions.length === 0) return 0;
      return Math.max(...person.interactions.map(i => new Date(i.date).getTime()));
    }

    fullPeople.sort((a, b) => {
      const priorityDiff = getRelationPriority(a) - getRelationPriority(b);
      if (priorityDiff !== 0) return priorityDiff;
      return getLastInteractionTime(b) - getLastInteractionTime(a);
    });

    const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;

    function needsFullDetail(person: import("./people-storage").Person): boolean {
      const rel = (person.relation || "").toLowerCase();
      if (rel.includes("wife") || rel.includes("husband") || rel.includes("spouse")) return true;
      if (rel.includes("daughter") || rel.includes("son")) return true;
      if (rel.includes("mother") || rel.includes("father")) return true;
      if (getLastInteractionTime(person) >= twoWeeksAgo) return true;
      return false;
    }

    const entries: string[] = [];
    for (const person of fullPeople) {
      const sortedInteractions = [...person.interactions].sort(
        (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
      );
      const lastInteraction = sortedInteractions[0];

      if (needsFullDetail(person)) {
        const parts = [`- **${person.name}** [person:${person.id}] (${person.cabinetLevel}${person.relation ? `, ${person.relation}` : ""})`];
        if (person.quickSummary || person.aiSummary) parts.push(`  ${person.quickSummary || person.aiSummary}`);
        if (lastInteraction) parts.push(`  Last contact: ${lastInteraction.date} (${lastInteraction.type}) — ${lastInteraction.summary}`);
        entries.push(parts.join("\n"));
      } else {
        const lastContactStr = lastInteraction ? `, last contact ${lastInteraction.date}` : "";
        entries.push(`- **${person.name}** [person:${person.id}] (${person.cabinetLevel}${person.relation ? `, ${person.relation}` : ""}${lastContactStr})`);
      }
    }

    return `These are the people closest to the user. Reference them naturally when relevant. Use the people tool for full details.\n\n${entries.join("\n")}`;
  } catch {
    return "No people context available.";
  }
}


async function resolveActiveTasks(): Promise<string> {
  try {
    const allProjects = await fileProjectStorage.getProjects({});
    const projectMap = new Map(allProjects.map(p => [p.id, p]));
    const allTodo = await fileTaskStorage.getTodoTasks();
    const activeTasks = allTodo.filter(t => t.status === "active");

    if (activeTasks.length === 0) return "No active tasks.";

    const { getDeadlineProximity, formatDeadlineCompact } = await import("@shared/models/work");
    const lines = activeTasks.map(t => {
      const project = t.projectId ? projectMap.get(t.projectId) : undefined;
      let context = "";
      if (project) {
        const milestoneName = t.milestoneId
          ? project.milestones.find(m => m.id === t.milestoneId)?.name
          : undefined;
        context = milestoneName
          ? ` — Project: ${project.title} / Milestone: ${milestoneName}`
          : ` — Project: ${project.title}`;
      }
      const estStr = '';
      let dlStr = '';
      if (t.deadline) {
        const dlProx = getDeadlineProximity(t.deadline);
        const compact = formatDeadlineCompact(t.deadline);
        dlStr = dlProx ? `, due ${compact} (${dlProx.label})` : `, due ${compact}`;
      }
      return `- [${t.status}] ${t.title} (${t.priority}, owner: ${t.owner})${estStr}${dlStr}${context}`;
    });
    return `### Tasks (${activeTasks.length})\n${lines.join("\n")}`;
  } catch {
    return "No tasks available.";
  }
}

async function resolveOpenDecisions(): Promise<string> {
  try {
    const { decisionsStorage } = await import("./decisions-storage");
    const open = await decisionsStorage.listDecisions({ status: "open" });
    if (open.length === 0) return "No open decisions.";
    const sorted = [...open].sort((a, b) => {
      const at = a.updatedAt instanceof Date ? a.updatedAt.getTime() : new Date(a.updatedAt as unknown as string).getTime();
      const bt = b.updatedAt instanceof Date ? b.updatedAt.getTime() : new Date(b.updatedAt as unknown as string).getTime();
      return bt - at;
    }).slice(0, 10);
    const lines = sorted.map(d => {
      const desc = (d.description || "").trim();
      return desc ? `- **${d.title}**: ${desc}` : `- **${d.title}**`;
    });
    return `### Open Decisions (${sorted.length}${open.length > sorted.length ? ` of ${open.length}` : ""})\n${lines.join("\n")}`;
  } catch {
    return "No decisions available.";
  }
}

async function resolveActiveTheses(): Promise<string> {
  try {
    const { thesisStorage } = await import("./thesis-storage");
    const active = await thesisStorage.list({ status: "active" });
    if (active.length === 0) return "";
    const lines = active.map(t => {
      const tags = (t.tags || []).join(", ");
      const tagStr = tags ? ` [${tags}]` : "";
      const stmt = (t.statement || "").trim();
      const stmtStr = stmt ? ` — ${stmt.length > 120 ? stmt.slice(0, 117) + "..." : stmt}` : "";
      return `- **${t.title}**${tagStr} ${(t.conviction || "low").toUpperCase()}${stmtStr}`;
    });
    return `### Active Theses (${active.length})\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

async function resolveActiveProjects(): Promise<string> {
  try {
    const allProjects = await fileProjectStorage.getProjects({});
    const activeProjects = allProjects.filter(p => p.status === "active");

    if (activeProjects.length === 0) return "No active projects.";

    const lines = activeProjects.map(p => {
      const progress = p.milestones.length > 0 ? ` (${p.milestones.filter(m => m.status === "completed").length}/${p.milestones.length} milestones)` : "";
      const due = p.dueDate ? ` — due ${p.dueDate}` : "";
      const projectLine = `- [#${p.id}] ${p.title} (${p.priority}, ${p.status}, owner: ${p.owner})${progress}${due}`;

      const nextMilestone = p.milestones
        .filter(m => m.status !== "completed")
        .sort((a, b) => a.order - b.order)[0];

      if (nextMilestone) {
        const msDue = nextMilestone.dueDate ? ` — due ${nextMilestone.dueDate}` : "";
        return `${projectLine}\n  Next: ${nextMilestone.name}${msDue}`;
      }
      return projectLine;
    });

    const upcomingDeadlines = await fileProjectStorage.getUpcomingDeadlines(14);
    const deadlineLines = upcomingDeadlines.map(d => `- ${d.title} — due ${d.dueDate!} (${d.status})`);

    let result = `### Projects (${activeProjects.length})\n${lines.join("\n")}`;
    if (deadlineLines.length > 0) {
      result += `\n\n### Upcoming Deadlines\n${deadlineLines.join("\n")}`;
    }
    return result;
  } catch {
    return "No projects available.";
  }
}


const CALENDAR_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const _calendarCache = new TTLCache<string>("CalendarBG", CALENDAR_REFRESH_INTERVAL_MS + 30_000);
let _calendarRefreshTimer: ReturnType<typeof setInterval> | null = null;

export function invalidateCalendarCache(): void {
  _calendarCache.invalidateAll(); // Clears all principal-scoped entries
  log.log("Calendar cache invalidated");
  refreshCalendarCache().catch(err => log.warn("Calendar refresh after invalidation failed:", err.message));
}

async function fetchCalendarData(): Promise<string> {
  const accounts = await listGmailAccounts();
  const connectedAccounts = [];
  for (const a of accounts) {
    if (await hasCalendarAccess(a.id)) connectedAccounts.push(a);
  }
  if (connectedAccounts.length === 0) return "No calendar connected.";

  const now = new Date();
  const sevenDaysOut = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const fourWeeksOut = new Date(now.getTime() + 28 * 24 * 60 * 60 * 1000);

  const weekResult = await listAllEvents({ timeMin: now.toISOString(), timeMax: sevenDaysOut.toISOString() });
  const monthResult = await listAllEvents({ timeMin: sevenDaysOut.toISOString(), timeMax: fourWeeksOut.toISOString() });
  const weekEvents = weekResult.events;
  const monthEvents = monthResult.events;

  const formatTime = (iso: string) => {
    if (!iso || iso.length <= 10) return iso;
    try { return new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
    catch { return iso; }
  };
  const formatDate = (iso: string) => {
    if (!iso || iso.length <= 10) return iso;
    try { return new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric" }); }
    catch { return iso; }
  };

  const sections: string[] = [];

  const { listMetadataByEvents, getLinkedTasksByMetadataIds, getLinkedPeopleByMetadataIds, makeMetaKey } = await import("./calendar-metadata");

  const allEvents = [...weekEvents, ...monthEvents];
  const eventIdentities = allEvents
    .filter(e => e.id)
    .map(e => ({ googleEventId: e.id, accountId: e.accountId, calendarId: e.calendarId }));
  const allMeta = await listMetadataByEvents(eventIdentities).catch(() => []);
  const metaIds = allMeta.map(m => m.id);
  const [allLinkedTasks, allLinkedPeople] = await Promise.all([
    getLinkedTasksByMetadataIds(metaIds).catch(() => []),
    getLinkedPeopleByMetadataIds(metaIds).catch(() => []),
  ]);

  type CalMeta = typeof allMeta[number];
  type CalTask = typeof allLinkedTasks[number];
  type CalPerson = typeof allLinkedPeople[number];

  const metaByKey = new Map(allMeta.map(m => [makeMetaKey(m.googleEventId, m.accountId, m.calendarId), m]));
  const tasksByMetaId = new Map<number, CalTask[]>();
  for (const t of allLinkedTasks) {
    if (!tasksByMetaId.has(t.metadataId)) tasksByMetaId.set(t.metadataId, []);
    tasksByMetaId.get(t.metadataId)!.push(t);
  }
  const peopleByMetaId = new Map<number, CalPerson[]>();
  for (const p of allLinkedPeople) {
    if (!peopleByMetaId.has(p.metadataId)) peopleByMetaId.set(p.metadataId, []);
    peopleByMetaId.get(p.metadataId)!.push(p);
  }

  const buildAnnotation = (eventId: string, accountId: string, calendarId: string): string => {
    const meta = metaByKey.get(makeMetaKey(eventId, accountId, calendarId));
    if (!meta) return "";
    const linkedTasks = tasksByMetaId.get(meta.id) || [];
    const linkedPeople = peopleByMetaId.get(meta.id) || [];
    if (meta.eventType === "meeting" && linkedPeople.length > 0) {
      return ` [meeting — ${linkedPeople.map(p => p.personName).join(", ")}]`;
    }
    if (linkedTasks.length > 0) {
      const taskLabels = linkedTasks.map(t => {
        const label = t.taskTitle || t.priorityTitle || `Task #${t.taskId}`;
        const hrs = t.estimateHours ? ` (~${t.estimateHours}h)` : "";
        return `${label}${hrs}`;
      }).join(", ");
      return ` [${meta.eventType} → ${taskLabels}]`;
    }
    return ` [${meta.eventType}]`;
  };

  if (weekEvents.length > 0) {
    const focusBlocks = weekEvents.filter(e => metaByKey.get(makeMetaKey(e.id, e.accountId, e.calendarId))?.eventType === "focus_block");
    const assignedFocusHours = focusBlocks.reduce((sum, e) => {
      const start = new Date(e.start?.dateTime || e.start?.date || 0).getTime();
      const end = new Date(e.end?.dateTime || e.end?.date || 0).getTime();
      return sum + (end - start) / 3600000;
    }, 0);
    const assignedTaskHours = focusBlocks.reduce((sum, e) => {
      const meta = metaByKey.get(makeMetaKey(e.id, e.accountId, e.calendarId));
      if (!meta) return sum;
      const tasks = tasksByMetaId.get(meta.id) ?? [];
      return sum + tasks.reduce((s, t) => s + (t.estimateHours ?? 0), 0);
    }, 0);
    const unassignedBlocks = focusBlocks.filter(e => {
      const meta = metaByKey.get(makeMetaKey(e.id, e.accountId, e.calendarId));
      return !meta || (tasksByMetaId.get(meta.id) ?? []).length === 0;
    });

    const eventLines = weekEvents.slice(0, 15).map(e => {
      const attendees = (e.attendees || []).filter((a: any) => !a.self).map((a: any) => a.displayName || a.email).slice(0, 5);
      const attendeeStr = attendees.length > 0 ? ` (with ${attendees.join(", ")})` : "";
      const loc = e.location ? ` @ ${e.location}` : "";
      const prep = isHighPrepEvent(e) ? " ⚑" : "";
      const annotation = buildAnnotation(e.id, e.accountId, e.calendarId);
      return `- ${formatTime(e.start?.dateTime || e.start?.date || "")} — ${e.summary || "(untitled)"}${attendeeStr}${loc}${prep}${annotation}`;
    });

    let weekSection = `### Upcoming (next 7 days)\n${eventLines.join("\n")}\n\n⚑ = high-prep event`;

    if (focusBlocks.length > 0) {
      weekSection += `\n\n**Focus Block Utilization:** ${assignedTaskHours.toFixed(1)}h assigned / ${assignedFocusHours.toFixed(1)}h total`;
      if (unassignedBlocks.length > 0) {
        weekSection += `\nUnassigned focus blocks: ${unassignedBlocks.map(e => formatTime(e.start?.dateTime || e.start?.date || "")).join(", ")}`;
      }
    }

    sections.push(weekSection);
  }

  const highPrepEvents = monthEvents.filter(e => isHighPrepEvent(e));
  if (highPrepEvents.length > 0) {
    const prepLines = highPrepEvents.slice(0, 8).map(e => {
      const attendees = (e.attendees || []).filter((a: any) => !a.self).map((a: any) => a.displayName || a.email).slice(0, 3);
      const attendeeStr = attendees.length > 0 ? ` (${(e.attendees || []).length} attendees incl. ${attendees.join(", ")})` : "";
      const annotation = buildAnnotation(e.id, e.accountId, e.calendarId);
      return `- ${formatDate(e.start?.dateTime || e.start?.date || "")} — ${e.summary || "(untitled)"}${attendeeStr}${annotation}`;
    });
    sections.push(`### High-Prep Events (2-4 weeks out)\n${prepLines.join("\n")}\n\nThese events may need preparation. Proactively mention them when relevant.`);
  }

  return sections.length > 0 ? sections.join("\n\n") : "No upcoming events.";
}

async function refreshCalendarCache(): Promise<void> {
  try {
    const key = `calendar:${contextPrincipalKey()}`;
    const data = await fetchCalendarData();
    _calendarCache.set(key, data);
    log.verbose(() => `Calendar cache refreshed (${data.length} chars) key=${key}`);
  } catch (err: any) {
    log.warn("Background calendar refresh failed:", err.message);
  }
}

export function startCalendarBackgroundRefresh(): void {
  if (_calendarRefreshTimer) return;
  log.log("Starting calendar background refresh loop");
  refreshCalendarCache();
  _calendarRefreshTimer = setInterval(() => {
    refreshCalendarCache();
  }, CALENDAR_REFRESH_INTERVAL_MS);
}

export function stopCalendarBackgroundRefresh(): void {
  if (_calendarRefreshTimer) {
    clearInterval(_calendarRefreshTimer);
    _calendarRefreshTimer = null;
    log.log("Stopped calendar background refresh loop");
  }
}

async function resolveCalendar(): Promise<string> {
  const key = `calendar:${contextPrincipalKey()}`;
  const cached = _calendarCache.get(key);
  if (cached !== undefined) {
    log.verbose("Calendar cache hit");
    return cached;
  }
  // On-demand fetch for this user (background refresh may not have run for them)
  try {
    const data = await fetchCalendarData();
    _calendarCache.set(key, data);
    return data;
  } catch (err: any) {
    log.warn("Calendar on-demand fetch failed:", err.message);
    return "Calendar unavailable.";
  }
}

// ---------------------------------------------------------------------------
// Recent Sessions (episodic output buffer)
// ---------------------------------------------------------------------------
async function resolveRecentSessions(): Promise<string> {
  try {
    const rows = await getRecentSessions(50);

    if (rows.length === 0) {
      return "No recent sessions recorded yet — buffer populates as sessions close.";
    }

    const lines = rows.map((row) => {
      const d = new Date(row.createdAt);
      const ts =
        `${d.getFullYear()}-` +
        `${String(d.getMonth() + 1).padStart(2, "0")}-` +
        `${String(d.getDate()).padStart(2, "0")} ` +
        `${String(d.getHours()).padStart(2, "0")}:` +
        `${String(d.getMinutes()).padStart(2, "0")}`;
      const parts: string[] = [
        `- ${ts} (${row.sessionType}) "${row.title ?? "Untitled"}"`,
      ];
      if (row.topics?.length) parts.push(`topics: ${row.topics.join(", ")}`);
      if (row.pagesCreated?.length) parts.push(`created: ${row.pagesCreated.join(", ")}`);
      if (row.pagesUpdated?.length) parts.push(`updated: ${row.pagesUpdated.join(", ")}`);
      if (row.peopleTouched?.length) parts.push(`people: ${row.peopleTouched.join(", ")}`);
      return parts.join(" | ");
    });

    return (
      `_Use this section before creating any artifact — check if it already exists in a recent session._\n\n` +
      lines.join("\n")
    );
  } catch (err: unknown) {
    log.warn(`resolveRecentSessions failed: ${err instanceof Error ? err.message : String(err)}`);
    return "";
  }
}

async function resolveShortTermMemory(): Promise<string> {
  return "Recent exchanges and observations.";
}

function getEntryTitle(
  e: { id: number; title: string | null; content: string },
  options?: { libraryTitle?: string | null }
): string {
  const libraryTitle = (options?.libraryTitle || "").trim();
  const raw = (e.title || libraryTitle || e.content.slice(0, 50).replace(/\n/g, " ").trim() || `Entry ${e.id}`).slice(0, 80);
  return raw.replace(/"/g, "'");
}

const SUMMARY_MISSING_MARKER = "[Summary missing — pending re-enrichment]";
const MAX_CONTEXT_SUMMARY_LENGTH = 2000; // Safety cap for rendered summaries — full data stays in DB

interface ContextSourceRef {
  sourceType: string;
  sourceId: string;
  relationship: string;
  strength: number;
  context: string;
}

function memoryConfidence(e: { metadata: unknown }): number {
  const meta = (e.metadata || {}) as Record<string, unknown>;
  const raw = meta.confidence ?? meta.confidenceScore ?? meta.confidence_score;
  const confidence = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : 0.7;
  return Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.7;
}

function memoryStageWeight(e: { integrationStage?: string | null; layer: string }): number {
  switch (e.integrationStage) {
    case "stage_4": return 1.25;
    case "stage_3": return 1.18;
    case "stage_2": return 1.1;
    case "stage_1": return 0.95;
    case "stage_0": return 0.75;
    default: return e.layer === "long" ? 1.15 : e.layer === "mid" ? 1.05 : 0.9;
  }
}

function memoryProcessedFreshness(e: { processedAt?: Date | null; createdAt: Date }): number {
  const basis = e.processedAt ?? e.createdAt;
  const ageDays = Math.max(0, (Date.now() - new Date(basis).getTime()) / 86_400_000);
  return 0.85 + 0.25 / (1 + ageDays / 90);
}

function isDefaultRawMemorySource(e: { source: string; sourceId: string | null; tags: string[] | null; metadata: unknown; integrationStage?: string | null; layer: string }): boolean {
  const meta = (e.metadata || {}) as Record<string, unknown>;
  if (meta.mirrorKind === "session_summary") return false;
  if (e.source === "chat" || e.source === "voice_session") return true;
  if (e.source === "conversation") {
    return String(e.sourceId || "").startsWith("exchange-") || ((e.tags || []) as string[]).includes("exchange");
  }
  return e.integrationStage === "stage_0" && e.layer === "short";
}

function hasExchangeDerivedSignal(e: { sourceId: string | null; tags: string[] | null; metadata: unknown }): boolean {
  const meta = (e.metadata || {}) as Record<string, unknown>;
  const sourceId = String(e.sourceId || "");
  const tags = (e.tags || []) as string[];
  return sourceId.startsWith("exchange-")
    || tags.includes("exchange")
    || String(meta.sourceId || "").startsWith("exchange-")
    || String(meta.sessionId || "").startsWith("exchange-")
    || String(meta.mirrorKind || "") === "exchange";
}

function isLegacyBeliefGarbage(e: { source: string; sourceId: string | null; tags: string[] | null; metadata: unknown; content?: string | null; summary?: string | null; title?: string | null }): boolean {
  if (e.source !== "belief") return false;
  const text = `${e.title || ""}
${e.summary || ""}
${e.content || ""}`;
  return hasExchangeDerivedSignal(e)
    || /\[(?:User|Assistant|Tool Result)\]/i.test(text)
    || /<(?:turn|entry)\b/i.test(text)
    || /^Belief:?\s*$/i.test((e.title || "").trim());
}

function isSourceBackedVNextMemory(e: { integrationStage?: string | null; title?: string | null; summary?: string | null; tags?: string[] | null }, refs: ContextSourceRef[]): boolean {
  return Boolean(
    e.integrationStage && e.integrationStage !== "stage_0"
      && (e.title || "").trim()
      && (e.summary || "").trim()
      && Array.isArray(e.tags)
      && e.tags.length > 0
      && refs.length > 0,
  );
}

function contextMemoryText(e: { summary: string | null; oneLiner: string | null; content: string }): string {
  return (e.summary || "").trim() || (e.oneLiner || "").trim() || sanitizeSummary(e.content || "").slice(0, MAX_CONTEXT_SUMMARY_LENGTH) || SUMMARY_MISSING_MARKER;
}

async function fetchTopSourceRefsForEntries(ids: number[]): Promise<Map<number, ContextSourceRef[]>> {
  if (ids.length === 0) return new Map();
  try {
    const rows = await db
      .select({
        memoryId: memorySourceRefs.memoryId,
        sourceType: memorySourceRefs.sourceType,
        sourceId: memorySourceRefs.sourceId,
        relationship: memorySourceRefs.relationship,
        strength: memorySourceRefs.strength,
        context: memorySourceRefs.context,
      })
      .from(memorySourceRefs)
      .where(inArray(memorySourceRefs.memoryId, ids));
    const map = new Map<number, ContextSourceRef[]>();
    for (const row of rows) {
      const refs = map.get(row.memoryId) ?? [];
      refs.push({
        sourceType: row.sourceType,
        sourceId: row.sourceId,
        relationship: row.relationship,
        strength: Number(row.strength ?? 0),
        context: row.context || "",
      });
      map.set(row.memoryId, refs);
    }
    for (const refs of map.values()) refs.sort((a, b) => b.strength - a.strength);
    return map;
  } catch (err) {
    log.warn(`fetchTopSourceRefsForEntries failed: ${err instanceof Error ? err.message : String(err)}`);
    return new Map();
  }
}

function rankContextMemories<T extends { metadata: unknown; integrationStage?: string | null; layer: string; processedAt?: Date | null; createdAt: Date; id: number }>(entries: T[], sourceRefs: Map<number, ContextSourceRef[]>): T[] {
  return [...entries].sort((a, b) => {
    const score = (e: T) => {
      const sourceStrength = Math.max(0, ...(sourceRefs.get(e.id) ?? []).map(ref => ref.strength));
      return memoryStageWeight(e) * (0.75 + memoryConfidence(e) * 0.35) * memoryProcessedFreshness(e) * (0.9 + Math.min(1, sourceStrength) * 0.2);
    };
    return score(b) - score(a);
  });
}

function formatSourceRefs(refs: ContextSourceRef[]): string {
  if (refs.length === 0) return "";
  return `
Sources: ${refs.slice(0, 3).map(ref => `${ref.relationship}:${ref.sourceType}/${ref.sourceId}${ref.strength ? ` (${ref.strength.toFixed(2)})` : ""}`).join("; ")}`;
}

function formatMemoryMetaLine(e: { integrationStage?: string | null; layer: string; metadata: unknown; tags?: string[] | null }, refs: ContextSourceRef[]): string {
  const bits = [`stage:${e.integrationStage || "unknown"}`, `confidence:${memoryConfidence(e).toFixed(2)}`];
  const topics = (e.tags || []).filter(Boolean).slice(0, 4);
  if (topics.length > 0) bits.push(`topics:${topics.join(",")}`);
  if (refs.length > 0) {
    bits.push(`sources:${refs.slice(0, 3).map(ref => `${ref.sourceType}/${ref.sourceId}`).join(",")}`);
  }
  return bits.join(" | ");
}

function renderContextMemory(e: { summary: string | null; oneLiner: string | null; content: string; integrationStage?: string | null; layer: string; metadata: unknown; tags?: string[] | null }, refs: ContextSourceRef[], maxLength = MAX_CONTEXT_SUMMARY_LENGTH): string {
  const rawText = contextMemoryText(e);
  let text = sanitizeSummary(rawText);
  if (text.length > maxLength) {
    text = text.slice(0, maxLength) + "\n[...summary truncated for context — full version in DB]";
  }
  if (isSourceBackedVNextMemory(e, refs)) {
    return `${formatMemoryMetaLine(e, refs)}\n${text}`;
  }
  if (isConsequentialMemory(e, refs)) return text + formatSourceRefs(refs);
  return text;
}

function isConsequentialMemory(e: { integrationStage?: string | null; layer: string; metadata: unknown }, refs: ContextSourceRef[]): boolean {
  return e.integrationStage === "stage_3" || e.integrationStage === "stage_4" || e.layer === "long" || memoryConfidence(e) >= 0.85 || refs.some(ref => ref.strength >= 0.8);
}

async function fetchLibraryTitlesForEntries(
  entries: Array<{ source: string; sourceId: string | null }>
): Promise<Map<string, string>> {
  const ids = entries
    .filter(e => e.source === "library" && e.sourceId)
    .map(e => e.sourceId as string);
  if (ids.length === 0) return new Map();
  try {
    const { libraryPages } = await import("@shared/models/info");
    const rows = await db
      .select({ id: libraryPages.id, title: libraryPages.title })
      .from(libraryPages)
      .where(inArray(libraryPages.id, ids));
    return new Map(rows.map(r => [r.id, r.title || ""]));
  } catch (err) {
    log.warn(`fetchLibraryTitlesForEntries failed: ${err instanceof Error ? err.message : String(err)}`);
    return new Map();
  }
}

async function injectMemoryEntryChildren(sections: ResolvedSection[], activeSessionId?: string): Promise<void> {
  const now = new Date().toISOString();
  const tz = getTimezone();
  const timeOpts = { month: "2-digit" as const, day: "2-digit" as const, year: "numeric" as const, hour: "2-digit" as const, minute: "2-digit" as const };
  const activeExchangeSourceId = activeSessionId ? `exchange-${activeSessionId}` : null;
  for (const section of sections) {
    if (section.id === "memory.short_term") {
      try {
        const entries = await memoryStorage.getLayer("short", MEMORY_THRESHOLDS.SHORT_ENTRIES_IN_CONTEXT, 0);
        const libraryTitles = await fetchLibraryTitlesForEntries(entries);
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          if (activeExchangeSourceId && e.sourceId === activeExchangeSourceId) {
            log.verbose(() => `Dedup: skipping short-term entry #${e.id} (sourceId=${e.sourceId}) — active conversation already in message history`);
            continue;
          }
          const libTitle = e.source === "library" && e.sourceId ? libraryTitles.get(e.sourceId) ?? null : null;
          const title = getEntryTitle(e, { libraryTitle: libTitle });
          const ts = formatInTimezone(e.createdAt, timeOpts);
          section.children.push({
            id: `memory.short_term.${e.id}`,
            title: `#${e.id} ${title} (${ts})`,
            parentId: "memory.short_term",
            sourceType: "dynamic",
            freshnessPolicy: "real-time",
            priority: i + 1,
            enabled: true,
            content: e.content,
            tokenCount: estimateTokens(e.content),
            resolvedAt: now,
            children: [],
          });
        }
      } catch (err) { log.warn(`resolveMemorySections short_term failed: ${safeStringify(err, { maxBytes: 4 * 1024, label: "ctx.resolveMemorySections.short.err" })}`); }
    } else if (section.id === "memory.mid_term") {
      try {
        const rawEntries = await memoryStorage.getLayer("mid", Math.max(50, MEMORY_THRESHOLDS.MID_ENTRIES_IN_CONTEXT * 4), 0);
        const sourceRefs = await fetchTopSourceRefsForEntries(rawEntries.map(e => e.id));
        const eligible = rawEntries.filter(e => !isDefaultRawMemorySource(e) && !isLegacyBeliefGarbage(e));
        const vNext = eligible.filter(e => isSourceBackedVNextMemory(e, sourceRefs.get(e.id) ?? []));
        const fallback = eligible.filter(e => !isSourceBackedVNextMemory(e, sourceRefs.get(e.id) ?? []));
        const entries = [
          ...rankContextMemories(vNext, sourceRefs),
          ...rankContextMemories(fallback, sourceRefs),
        ].slice(0, MEMORY_THRESHOLDS.MID_ENTRIES_IN_CONTEXT);
        const libraryTitles = await fetchLibraryTitlesForEntries(entries);
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          const libTitle = e.source === "library" && e.sourceId ? libraryTitles.get(e.sourceId) ?? null : null;
          const title = getEntryTitle(e, { libraryTitle: libTitle });
          const ts = formatInTimezone(e.createdAt, timeOpts);
          const refs = sourceRefs.get(e.id) ?? [];
          const text = renderContextMemory(e, refs);
          section.children.push({
            id: `memory.mid_term.${e.id}`,
            title: `#${e.id} ${title} (${ts})`,
            parentId: "memory.mid_term",
            sourceType: "dynamic",
            freshnessPolicy: "per-session",
            priority: i + 1,
            enabled: true,
            content: text,
            tokenCount: estimateTokens(text),
            resolvedAt: now,
            children: [],
          });
        }
      } catch (err) { log.warn(`resolveMemorySections mid_term failed: ${safeStringify(err, { maxBytes: 4 * 1024, label: "ctx.resolveMemorySections.mid.err" })}`); }
    } else if (section.id === "memory.long_term") {
      try {
        const longEntries = await memoryStorage.getLayer("long", 80, 0);
        const sourceRefs = await fetchTopSourceRefsForEntries(longEntries.map(e => e.id));
        const eligible = longEntries.filter(e => !e.graphed && !isDefaultRawMemorySource(e) && !isLegacyBeliefGarbage(e));
        const vNext = eligible.filter(e => isSourceBackedVNextMemory(e, sourceRefs.get(e.id) ?? []));
        const fallback = eligible.filter(e => !isSourceBackedVNextMemory(e, sourceRefs.get(e.id) ?? []));
        const filtered = [
          ...rankContextMemories(vNext, sourceRefs),
          ...rankContextMemories(fallback, sourceRefs),
        ].slice(0, 20);
        const libraryTitles = await fetchLibraryTitlesForEntries(filtered);
        let priority = 1;
        for (const e of filtered) {
          const libTitle = e.source === "library" && e.sourceId ? libraryTitles.get(e.sourceId) ?? null : null;
          const title = getEntryTitle(e, { libraryTitle: libTitle });
          const ts = formatInTimezone(e.createdAt, timeOpts);
          const refs = sourceRefs.get(e.id) ?? [];
          const text = renderContextMemory(e, refs);
          section.children.push({
            id: `memory.long_term.${e.id}`,
            title: `#${e.id} ${title} (${ts})`,
            parentId: "memory.long_term",
            sourceType: "dynamic",
            freshnessPolicy: "per-session",
            priority: priority++,
            enabled: true,
            content: text,
            tokenCount: estimateTokens(text),
            resolvedAt: now,
            children: [],
          });
        }
      } catch (err) { log.warn(`resolveMemorySections long_term failed: ${safeStringify(err, { maxBytes: 4 * 1024, label: "ctx.resolveMemorySections.long.err" })}`); }
    }
    if (section.children.length > 0) {
      await injectMemoryEntryChildren(section.children, activeSessionId);
    }
  }
}

function escapeXmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, " ");
}


async function resolveMidTermMemory(): Promise<string> {
  return "Working knowledge consolidated from recent activity.";
}

async function resolveLongTermMemory(): Promise<string> {
  try {
    const longEntries = await memoryStorage.getLayer("long", 1, 0);
    if (longEntries.length === 0) {
      return "Empty.";
    }
  } catch (err) { log.warn(`resolveLongTermMemory failed: ${safeStringify(err, { maxBytes: 4 * 1024, label: "ctx.resolveLongTermMemory.err" })}`); }
  return "Deep knowledge and extracted patterns.";
}

async function resolveSessionContext(request: ContextRequest): Promise<string> {
  if (!request.sessionId) return "No active session.";
  try {
    const conv = await chatFileStorage.getSession(request.sessionId);
    if (!conv) return "No active session.";
    const titleStr = (conv.title && conv.title !== "New Session" && conv.title !== "New Chat")
      ? conv.title
      : "(untitled)";
    const topicsStr = (conv.topics && conv.topics.length > 0)
      ? conv.topics.join(", ")
      : "(none yet)";
    const parts = [`Title: ${titleStr}`, `Topics: ${topicsStr}`];
    let trailing = "";
    if (conv.pageContext?.route) {
      const pc = conv.pageContext;
      const pageLabel = pc.pageTitle || pc.route;
      const tabSuffix = pc.tab ? ` > ${pc.tab}` : "";
      const subSuffix = pc.subView ? ` > ${pc.subView}` : "";
      parts.push(`Page Context: ${pageLabel}${tabSuffix}${subSuffix} (${pc.route})`);
      if ((pc as Record<string, unknown>).closeOut) {
        trailing = "\n\n**This is a Close Out conversation.** Activate the Companion persona. Be warm, present, and genuinely curious about the day. Follow Ray's lead — don't structure or evaluate. The day's context was loaded into your opening message; surface it naturally in response to what Ray shares, don't dump it.";
      } else if (pc.entity || pc.tab) {
        trailing = "\n\n" + renderFocusContextBlock(pc);
      }
    }
    // FTUE welcome script injection is handled structurally in assembleContext
    // (agent-context.ts) as a post-assembly step, bypassing section exclusion.
    // It must NOT live here because session_context is an excludable section.

    return parts.join(" | ") + trailing;
  } catch (err: unknown) {
    log.warn(`resolveSessionContext error: ${err instanceof Error ? err.message : String(err)}`);
    return "No active session.";
  }
}

const GRAPH_MEMORY_CACHE_TTL_MS = 5 * 60 * 1000;
const GRAPH_SEMANTIC_SEED_TIMEOUT_MS = 500;
const _graphMemoryCache = new TTLCache<string>("GraphMemory", GRAPH_MEMORY_CACHE_TTL_MS);

function getQueryHash(query: string): string {
  return createHash("sha256").update(query).digest("hex").slice(0, 32);
}

// --- Tiered Memory Graph Rendering ---

const DEFAULT_MEMORY_GRAPH_TOKEN_BUDGET = 4000;
const RECENCY_SEED_COUNT = 5;

type MemoryTier = "signal" | "detail" | "full";

/** Render a memory entry at a specific tier depth */
function renderTieredEntry(
  entry: { id: number; title: string | null; oneLiner: string | null; summary: string | null; content: string; tags: string[] | null; createdAt: string | null; integrationStage?: string | null; layer: string; metadata: unknown },
  refs: ContextSourceRef[],
  tier: MemoryTier,
  score: number,
  sources: string[],
): string {
  const title = entry.title || entry.oneLiner || entry.content?.slice(0, 60) || "memory";
  const timeStr = entry.createdAt ? ` ${formatRelativeTime(new Date(entry.createdAt))}` : "";
  const scorePercent = (score * 100).toFixed(0);
  const pathInfo = sources.length > 0 ? ` path:${sources.join("+")}` : "";

  if (tier === "signal") {
    return `- #${entry.id} **${title}**${timeStr} (score:${scorePercent}%${pathInfo})`;
  }

  if (tier === "detail") {
    const summary = entry.summary || entry.oneLiner || "";
    const tagStr = entry.tags?.length ? ` | topics:${entry.tags.slice(0, 4).join(",")}` : "";
    const stageStr = entry.integrationStage ? ` | stage:${entry.integrationStage}` : "";
    return `- #${entry.id} **${title}**${timeStr} (score:${scorePercent}%${pathInfo})\n  ${summary}${tagStr}${stageStr}`;
  }

  // full tier
  const text = renderContextMemory(entry, refs, 500).replace(/\n+/g, " | ");
  return `- #${entry.id} **${title}**${timeStr} (score:${scorePercent}%${pathInfo}) ${text}`;
}

/** Greedy knapsack: allocate tiers to scored candidates within a token budget */
function allocateTiers(
  candidates: Array<{ id: number; score: number; sources: string[] }>,
  entries: Map<number, { id: number; title: string | null; oneLiner: string | null; summary: string | null; content: string; tags: string[] | null; createdAt: string | null; integrationStage?: string | null; layer: string; metadata: unknown }>,
  refs: Map<number, ContextSourceRef[]>,
  tokenBudget: number,
): Array<{ id: number; tier: MemoryTier; rendered: string }> {
  const result: Array<{ id: number; tier: MemoryTier; rendered: string }> = [];
  let tokensUsed = 0;
  // Header tokens
  const headerLine = "Memories matching query:";
  tokensUsed += estimateTokens(headerLine) + 1;

  // If budget is very small, skip Full tier entirely
  const allowFull = tokenBudget >= 500;
  // Tier attempt order from richest to leanest
  const tierOrder: MemoryTier[] = allowFull ? ["full", "detail", "signal"] : ["detail", "signal"];

  for (const candidate of candidates) {
    const entry = entries.get(candidate.id);
    if (!entry) continue;
    const entryRefs = refs.get(candidate.id) ?? [];

    let allocated = false;
    for (const tier of tierOrder) {
      const rendered = renderTieredEntry(entry, entryRefs, tier, candidate.score, candidate.sources);
      const tokens = estimateTokens(rendered);
      if (tokensUsed + tokens <= tokenBudget) {
        result.push({ id: candidate.id, tier, rendered });
        tokensUsed += tokens;
        allocated = true;
        break;
      }
    }

    // If even signal doesn't fit, stop
    if (!allocated) {
      const signalRendered = renderTieredEntry(entry, entryRefs, "signal", candidate.score, candidate.sources);
      const signalTokens = estimateTokens(signalRendered);
      if (tokensUsed + signalTokens <= tokenBudget) {
        result.push({ id: candidate.id, tier: "signal", rendered: signalRendered });
        tokensUsed += signalTokens;
      } else {
        break; // budget fully exhausted
      }
    }

    // After the first entry, try to demote tier order to save budget
    // (First entry always gets richest available tier; subsequent entries degrade)
    if (result.length === 1 && tierOrder[0] === "full") {
      // keep full for the top entry, downgrade default for rest
    }
  }

  return result;
}

/** Read memoryGraphTokenBudget from the active persona's cognitiveOverrides */
async function getMemoryGraphTokenBudget(): Promise<number> {
  try {
    const active = await personaStorage.getActiveOrNull();
    if (active?.cognitiveOverrides && typeof active.cognitiveOverrides === "object") {
      const budget = (active.cognitiveOverrides as Record<string, unknown>).memoryGraphTokenBudget;
      if (typeof budget === "number" && budget > 0) return budget;
    }
  } catch { /* persona unavailable — use default */ }
  return DEFAULT_MEMORY_GRAPH_TOKEN_BUDGET;
}

interface CacheSignalEntry {
  id: number;
  score: number;
  source: ("causal" | "contrastive" | "temporal")[];
  hop?: number;
  relationshipType?: string;
}

function scoreCausalFromCache(
  seeds: import("@shared/schema").MemoryEntry[],
  getNeighborhoodCacheFn: (e: import("@shared/schema").MemoryEntry) => import("@shared/schema").NeighborhoodCache | null,
  causalRelTypes: string[]
): CacheSignalEntry[] {
  const results = new Map<number, CacheSignalEntry>();
  const seedIds = new Set(seeds.map(s => s.id));
  const HOP_DECAY = 0.6;

  for (const seed of seeds) {
    const cache = getNeighborhoodCacheFn(seed);
    if (!cache) continue;

    for (const neighbor of cache.entries) {
      if (seedIds.has(neighbor.id)) continue;
      if (!causalRelTypes.includes(neighbor.relationshipType)) continue;

      const hopDecay = Math.pow(HOP_DECAY, neighbor.hop);
      const score = neighbor.strength * hopDecay;

      const existing = results.get(neighbor.id);
      if (!existing || score > existing.score) {
        results.set(neighbor.id, {
          id: neighbor.id,
          score,
          source: ["causal"],
          hop: neighbor.hop,
          relationshipType: neighbor.relationshipType,
        });
      }
    }
  }

  return Array.from(results.values());
}

function scoreContrastiveFromCache(
  seeds: import("@shared/schema").MemoryEntry[],
  getNeighborhoodCacheFn: (e: import("@shared/schema").MemoryEntry) => import("@shared/schema").NeighborhoodCache | null
): CacheSignalEntry[] {
  const results = new Map<number, CacheSignalEntry>();
  const seedIds = new Set(seeds.map(s => s.id));

  const allSeedTags = new Set<string>();
  for (const seed of seeds) {
    for (const tag of ((seed.tags || []) as string[])) {
      allSeedTags.add(tag.toLowerCase());
    }
  }

  for (const seed of seeds) {
    const cache = getNeighborhoodCacheFn(seed);
    if (!cache) continue;

    for (const neighbor of cache.entries) {
      if (seedIds.has(neighbor.id)) continue;

      const isContradictOrEvolves = neighbor.relationshipType === "contradicts" || neighbor.relationshipType === "evolves";

      const neighborTags = new Set((neighbor.tags || []).map((t: string) => t.toLowerCase()));
      let intersection = 0;
      for (const t of allSeedTags) {
        if (neighborTags.has(t)) intersection++;
      }
      const union = new Set([...allSeedTags, ...neighborTags]).size;
      const jaccard = union > 0 ? intersection / union : 0;

      let score = 0;
      if (isContradictOrEvolves) {
        score = Math.max(0.5, jaccard) * neighbor.strength;
      } else if (jaccard > 0.1) {
        score = jaccard * neighbor.strength * 0.5;
      }

      if (score <= 0) continue;

      const existing = results.get(neighbor.id);
      if (!existing || score > existing.score) {
        results.set(neighbor.id, {
          id: neighbor.id,
          score,
          source: ["contrastive"],
          hop: neighbor.hop,
          relationshipType: neighbor.relationshipType,
        });
      }
    }
  }

  return Array.from(results.values());
}

async function queryTemporalNeighbors(seeds: import("@shared/schema").MemoryEntry[]): Promise<CacheSignalEntry[]> {
  if (seeds.length === 0) return [];

  const seedIds = new Set(seeds.map(s => s.id));
  const TEMPORAL_WINDOW_DAYS = 3;
  const windowMs = TEMPORAL_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  const windowClauses = seeds.slice(0, 5).map(s => {
    const lo = new Date(s.createdAt.getTime() - windowMs);
    const hi = new Date(s.createdAt.getTime() + windowMs);
    return sql`(${memoryEntries.createdAt} >= ${lo} AND ${memoryEntries.createdAt} <= ${hi})`;
  });

  const rows = await db.select({
    id: memoryEntries.id,
    createdAt: memoryEntries.createdAt,
  }).from(memoryEntries).where(
    and(
      sql`/* context:graph:temporal */ TRUE`,
      or(eq(memoryEntries.layer, "mid"), eq(memoryEntries.layer, "long")),
      or(...windowClauses),
    )
  ).orderBy(desc(memoryEntries.createdAt)).limit(30);

  const results: CacheSignalEntry[] = [];
  for (const row of rows) {
    if (seedIds.has(row.id)) continue;

    let bestProximity = 0;
    for (const seed of seeds) {
      const diffMs = Math.abs(seed.createdAt.getTime() - row.createdAt.getTime());
      if (diffMs > windowMs) continue;
      const proximity = 1 / (1 + diffMs / 1000 / 86400);
      if (proximity > bestProximity) bestProximity = proximity;
    }

    if (bestProximity > 0.05) {
      results.push({
        id: row.id,
        score: bestProximity,
        source: ["temporal"],
      });
    }
  }

  return results;
}

function blendCacheSignals(
  causal: CacheSignalEntry[],
  contrastive: CacheSignalEntry[],
  temporal: CacheSignalEntry[],
  weights: import("./memory/associative-retrieval").BlendWeights
): Map<number, { score: number; sources: string[] }> {

  const merged = new Map<number, { causal: number; contrastive: number; temporal: number; sources: Set<string> }>();

  const upsert = (entries: CacheSignalEntry[], signal: "causal" | "contrastive" | "temporal") => {
    for (const e of entries) {
      const existing = merged.get(e.id);
      if (existing) {
        existing[signal] = Math.max(existing[signal], e.score);
        existing.sources.add(signal);
      } else {
        merged.set(e.id, { causal: 0, contrastive: 0, temporal: 0, sources: new Set([signal]), [signal]: e.score });
      }
    }
  };

  upsert(causal, "causal");
  upsert(contrastive, "contrastive");
  upsert(temporal, "temporal");

  const allCausal = Array.from(merged.values()).map(m => m.causal);
  const allContrastive = Array.from(merged.values()).map(m => m.contrastive);
  const allTemporal = Array.from(merged.values()).map(m => m.temporal);
  const maxCausal = Math.max(...allCausal, 0.001);
  const maxContrastive = Math.max(...allContrastive, 0.001);
  const maxTemporal = Math.max(...allTemporal, 0.001);

  // Renormalize the 3 graph-only weights so scores use the full 0-1 range.
  // The shared BlendWeights include a semantic component (~0.40) that the graph
  // resolver doesn't use. Without renormalization, max possible score is ~0.58,
  // compressing meaningful differences and making thresholds unintuitive.
  const graphSum = weights.causal + weights.contrastive + weights.temporal || 1;
  const wCausal = weights.causal / graphSum;
  const wContrastive = weights.contrastive / graphSum;
  const wTemporal = weights.temporal / graphSum;

  const result = new Map<number, { score: number; sources: string[] }>();
  for (const [id, m] of merged) {
    const score =
      wCausal * (m.causal / maxCausal) +
      wContrastive * (m.contrastive / maxContrastive) +
      wTemporal * (m.temporal / maxTemporal);
    result.set(id, { score, sources: Array.from(m.sources) });
  }

  return result;
}

async function resolveLegacyGraphMemory(request: ContextRequest): Promise<string> {
  const start = Date.now();
  try {
    let focusText = "";
    let focusSource = "none";

    if (request.sessionId) {
      try {
        const conv = await chatFileStorage.getSession(request.sessionId);
        if (conv) {
          const sessionParts: string[] = [];
          if (conv.title && conv.title !== "New Session" && conv.title !== "New Chat") {
            sessionParts.push(conv.title);
          }
          if (conv.topics && conv.topics.length > 0) {
            sessionParts.push(conv.topics.join(" "));
          }
          if (sessionParts.length > 0) {
            focusText = sessionParts.join(" ") + "\n";
            focusSource = "sessionMeta";
          }
        }
      } catch {
      }
    }

    if (request.memoryQuery) {
      focusText += request.memoryQuery.slice(0, 1000);
      focusSource = focusSource === "sessionMeta" ? "sessionMeta+memoryQuery" : "memoryQuery";
    } else {
      // Current message dominates the focus text so mid-conversation topic pivots
      // actually shift the graph. Session metadata and history provide arc context
      // but must not drown out what the user just said.
      if (request.currentMessage) {
        const msg = request.currentMessage.slice(0, 1000);
        // Prepend currentMessage before session metadata so it anchors the embedding.
        focusText = msg + "\n" + focusText;
        focusSource = focusSource === "sessionMeta" ? "currentMessage+sessionMeta" : "currentMessage";
      }
      if (request.conversationHistory && request.conversationHistory.length > 0) {
        const recentMessages = request.conversationHistory.slice(-3);
        const historyText = recentMessages.map(m => m.content).join("\n").slice(-300);
        focusText += (focusText ? "\n" : "") + historyText;
        focusSource = focusSource.includes("currentMessage") ? focusSource + "+history" :
          focusSource === "sessionMeta" ? "sessionMeta+conversationHistory" : "conversationHistory";
      }
      // Last resort: fetch from storage when neither currentMessage nor history are available.
      if (!request.currentMessage && (!request.conversationHistory || request.conversationHistory.length === 0) && request.sessionId) {
        try {
          const storedMessages = await chatFileStorage.getMessagesBySession(request.sessionId);
          if (storedMessages.length > 0) {
            const recentStored = storedMessages.slice(-3);
            focusText += recentStored.map(m => m.content || "").join("\n").slice(-500);
            focusSource = focusSource === "sessionMeta" ? "sessionMeta+storedMessages" : "storedMessages";
          }
        } catch {
          // storage read failed — continue without
        }
      }
    }

    if (!focusText) {
      log.verbose(() => `resolveGraphMemory: no focus text (source=${focusSource}) — returning empty`);
      return "";
    }

    log.verbose(() => `resolveGraphMemory START source=${focusSource} focusText="${focusText.slice(0, 80)}${focusText.length > 80 ? "..." : ""}"`);

        // Read persona-driven token budget for tiered rendering
    const tokenBudget = await getMemoryGraphTokenBudget();
    const queryHash = `${contextPrincipalKey()}::${getQueryHash(focusText)}::${tokenBudget}`;
    const cached = _graphMemoryCache.get(queryHash);
    if (cached !== undefined) {
      log.verbose(() => `resolveGraphMemory: cache hit hash=${queryHash.slice(0, 8)}`);
      return cached;
    }

    // Load seed entries from two sources:
    // 1. Recency: small set of most recent short-term entries (ensures very recent context)
    // 2. Semantic: unified vector search across ALL layers using focusText
    // Combined seeds let the graph traverse from both recent AND topically relevant memories.
    const seedStart = Date.now();
    const semanticSeedPromise = focusText
      ? withTimeout(
          semanticSeedSearch({
            query: focusText,
            limit: 80,
            queryTag: "graph:semantic-seed",
          }),
          GRAPH_SEMANTIC_SEED_TIMEOUT_MS,
          "memory.graph semantic seed search",
        ).catch(err => {
          if (isTimeoutError(err)) {
            log.warn(`resolveGraphMemory semantic seed search timed out after ${GRAPH_SEMANTIC_SEED_TIMEOUT_MS}ms; falling back to recency seeds`);
          } else {
            log.warn(`resolveGraphMemory semantic seed search failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          return [] as Awaited<ReturnType<typeof semanticSeedSearch>>;
        })
      : Promise.resolve([] as Awaited<ReturnType<typeof semanticSeedSearch>>);

    // Small recency seed ensures very recent memories surface even without embeddings
    const [recencyEntries, semanticResults] = await Promise.all([
      memoryStorage.getLayer("short", RECENCY_SEED_COUNT, 0),
      semanticSeedPromise,
    ]);
    // Deduplicate: recency seeds take priority, semantic adds novel entries
    const seenIds = new Set<number>();
    const recencySeeds = recencyEntries;
    for (const s of recencySeeds) seenIds.add(s.id);
    const semanticSeeds = semanticResults
      .map(r => r.entry)
      .filter(e => !seenIds.has(e.id));
    // Preserve semantic scores for direct inclusion in output —
    // seeds are systematically excluded by graph traversal (causal/contrastive/temporal
    // skip seed IDs), so without this, the most topically relevant memories get thrown away.
    const semanticScoreMap = new Map<number, number>();
    for (const r of semanticResults) {
      semanticScoreMap.set(r.entry.id, r.score);
    }
    const allSeeds = [...recencySeeds, ...semanticSeeds];
    const seedMs = Date.now() - seedStart;
    // Always log seed pipeline diagnostics (not verbose) so we can trace graph behavior
    log.log(`[GraphMemory] focusText="${focusText.slice(0, 120)}${focusText.length > 120 ? "..." : ""}" focusSource=${focusSource}`);
    log.log(`[GraphMemory] seeds: recency=${recencySeeds.length} semanticRaw=${semanticResults.length} semanticNovel=${semanticSeeds.length} total=${allSeeds.length} elapsed=${seedMs}ms`);
    if (semanticResults.length > 0) {
      const topSemantic = semanticResults.slice(0, 5).map(r => `#${r.entry.id}(${r.score.toFixed(3)},"${(r.entry.title || r.entry.oneLiner || "").slice(0, 40)}")`);
      log.log(`[GraphMemory] semanticResults top5: ${topSemantic.join(", ")}`);
    }
    if (semanticScoreMap.size > 0) {
      const scoreEntries = Array.from(semanticScoreMap.entries()).map(([id, s]) => `#${id}=${s.toFixed(3)}`);
      log.log(`[GraphMemory] semanticScoreMap: ${scoreEntries.join(", ")}`);
    }

    if (allSeeds.length === 0) {
      log.verbose(() => `resolveGraphMemory DONE no seeds elapsed=${Date.now() - start}ms`);
      return "No matching memories found.";
    }

    let cacheMissCount = 0;
    for (const seed of allSeeds) {
      if (!getNeighborhoodCache(seed)) cacheMissCount++;
    }
    if (cacheMissCount > 0) {
      log.verbose(() => `resolveGraphMemory: ${cacheMissCount}/${allSeeds.length} seed entries had no neighborhood cache — contributing only temporal signal`);
    }

    const sessionTopics: string[] = [];
    if (request.sessionId) {
      try {
        const conv = await chatFileStorage.getSession(request.sessionId);
        if (conv?.topics) sessionTopics.push(...conv.topics);
      } catch (err) { log.warn(`resolveGraphMemory session topics fetch failed: ${err instanceof Error ? err.message : String(err)}`); }
    }

    const detection = detectSessionType(focusText + " " + sessionTopics.join(" "));
    const baseWeights = BLEND_WEIGHTS[detection.type];

    // Modulate weights by emotional state if present and not stale
    let emotionInput: { valence: number; arousal: number } | null = null;
    try {
      const currentEmotion = await fileEmotionalStateStorage.getCurrent();
      if (currentEmotion && !currentEmotion.stale) {
        emotionInput = { valence: currentEmotion.valence, arousal: currentEmotion.arousal };
      }
    } catch { /* emotion optional */ }

    const { weights, modulated, deltas } = modulateWeights(baseWeights, emotionInput);
    if (modulated) {
      log.verbose(() => `resolveGraphMemory emotional_modulation ${deltas}`);
    }

    const temporalPromise = queryTemporalNeighbors(allSeeds);
    const temporalStart = Date.now();

    const causalStart = Date.now();
    let causalResults: CacheSignalEntry[] = [];
    try {
      causalResults = scoreCausalFromCache(allSeeds, getNeighborhoodCache, CAUSAL_RELATIONSHIP_TYPES as string[]);
    } catch (err) {
      log.warn(`resolveGraphMemory scoreCausalFromCache ERROR seeds=${allSeeds.length} cacheMisses=${cacheMissCount}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const causalMs = Date.now() - causalStart;

    const contrastiveStart = Date.now();
    let contrastiveResults: CacheSignalEntry[] = [];
    try {
      contrastiveResults = scoreContrastiveFromCache(allSeeds, getNeighborhoodCache);
    } catch (err) {
      log.warn(`resolveGraphMemory scoreContrastiveFromCache ERROR seeds=${allSeeds.length} cacheMisses=${cacheMissCount}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const contrastiveMs = Date.now() - contrastiveStart;

    let temporalResults: CacheSignalEntry[] = [];
    try {
      temporalResults = await temporalPromise;
    } catch (err) {
      log.warn(`resolveGraphMemory queryTemporalNeighbors ERROR seeds=${allSeeds.length}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const temporalMs = Date.now() - temporalStart;

    const blended = blendCacheSignals(causalResults, contrastiveResults, temporalResults, weights);

    if (blended.size === 0) {
      log.verbose(() => `resolveGraphMemory DONE no blended results seeds=${allSeeds.length} elapsed=${Date.now() - start}ms`);
      return "No matching memories found.";
    }

    // After renormalization, temporal-only memories max out at ~0.33.
    // A 0.35 floor filters single-signal noise and keeps memories with
    // at least two signal paths (causal+temporal, contrastive+temporal, etc).
    const GRAPH_MIN_SCORE = 0.35;
    const SEMANTIC_MIN_SCORE = 0.20;
    const graphResults = Array.from(blended.entries())
      .filter(([, info]) => info.score >= GRAPH_MIN_SCORE);

    // Merge semantic seeds directly into output. The graph traversal functions
    // (scoreCausalFromCache, scoreContrastiveFromCache, temporal query) all
    // explicitly skip seed IDs, so topically relevant seeds get thrown away
    // even though they're the best matches. Fix: include them with their
    // embedding similarity score mapped to the "semantic" source tag.
    const graphResultIds = new Set(graphResults.map(([id]) => id));
    const semanticDirectEntries: [number, { score: number; sources: string[] }][] = [];
    for (const [id, score] of semanticScoreMap) {
      if (!graphResultIds.has(id) && score >= SEMANTIC_MIN_SCORE) {
        semanticDirectEntries.push([id, { score, sources: ["semantic"] }]);
      }
    }

    log.log(`[GraphMemory] signals: causal=${causalResults.length} contrastive=${contrastiveResults.length} temporal=${temporalResults.length} blended=${blended.size}`);
    log.log(`[GraphMemory] filtering: graphResults(>=0.35)=${graphResults.length} semanticDirect(>=0.20)=${semanticDirectEntries.length}`);
    if (semanticDirectEntries.length > 0) {
      const semDetail = semanticDirectEntries.slice(0, 5).map(([id, info]) => `#${id}(${info.score.toFixed(3)})`);
      log.log(`[GraphMemory] semanticDirect top5: ${semDetail.join(", ")}`);
    }
    if (graphResults.length > 0) {
      const graphDetail = graphResults.slice(0, 5).map(([id, info]) => `#${id}(${info.score.toFixed(3)},${info.sources.join("+")})`);
      log.log(`[GraphMemory] graphResults top5: ${graphDetail.join(", ")}`);
    }

    // Balanced selection: guarantee ~50/50 split between semantic and recency sources.
    // Without this, recency seeds (50) drown semantic seeds (20) and the graph
    // neighborhood of recent technical work overwhelms topically relevant memories.
    const MAX_RESULTS = 25;
    const halfSlots = Math.floor(MAX_RESULTS / 2); // 12

    const allCandidates = [...graphResults, ...semanticDirectEntries];
    const candidateIds = allCandidates.map(([id]) => id);
    const preliminaryEntryMap = new Map<number, import("@shared/schema").MemoryEntry>();
    for (const e of allSeeds) preliminaryEntryMap.set(e.id, e);
    const missingCandidateIds = candidateIds.filter(id => !preliminaryEntryMap.has(id));
    let preliminaryFetchedEntries: import("@shared/schema").MemoryEntry[] = [];
    if (missingCandidateIds.length > 0) {
      const { memoryStorage } = await import("./memory/memory-storage");
      preliminaryFetchedEntries = await memoryStorage.getEntriesForDisplay(missingCandidateIds);
      for (const e of preliminaryFetchedEntries) preliminaryEntryMap.set(e.id, e);
    }

    const sourceRefs = await fetchTopSourceRefsForEntries(candidateIds);
    const eligibleCandidates = allCandidates.filter(([id]) => {
      const entry = preliminaryEntryMap.get(id);
      if (!entry) return false;
      return !isDefaultRawMemorySource(entry) && !isLegacyBeliefGarbage(entry);
    });
    // vNext source-backed scoring boost: entries with memory_sources rows get
    // a 15% multiplicative score increase, surfacing higher-provenance memories
    // naturally through the score-based allocation rather than positional ordering.
    const SOURCE_BACKED_BOOST = 1.15;
    let sourceBoostCount = 0;
    const boostedCandidates = eligibleCandidates.map(([id, info]) => {
      const entry = preliminaryEntryMap.get(id);
      const isBacked = entry ? isSourceBackedVNextMemory(entry, sourceRefs.get(id) ?? []) : false;
      if (isBacked) sourceBoostCount++;
      return [id, {
        score: isBacked ? Math.min(info.score * SOURCE_BACKED_BOOST, 1.0) : info.score,
        sources: info.sources,
      }] as [number, { score: number; sources: string[] }];
    });
    if (sourceBoostCount > 0) {
      log.verbose(() => `resolveGraphMemory: boosted ${sourceBoostCount}/${eligibleCandidates.length} source-backed entries by ${((SOURCE_BACKED_BOOST - 1) * 100).toFixed(0)}%`);
    }
    const orderedCandidates = boostedCandidates.sort((a, b) => b[1].score - a[1].score);

    const semanticPool = orderedCandidates
      .filter(([id]) => semanticScoreMap.has(id))
      .sort((a, b) => b[1].score - a[1].score);
    const recencyPool = orderedCandidates
      .filter(([id]) => !semanticScoreMap.has(id))
      .sort((a, b) => b[1].score - a[1].score);

    // Take half from each bucket; if one is underfull, the other fills the gap
    const semanticTake = semanticPool.slice(0, halfSlots);
    const recencyTake = recencyPool.slice(0, halfSlots);
    const remaining = MAX_RESULTS - semanticTake.length - recencyTake.length;
    const overflow = [...semanticPool.slice(halfSlots), ...recencyPool.slice(halfSlots)]
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, remaining);

    const sorted = [...semanticTake, ...recencyTake, ...overflow]
      .sort((a, b) => b[1].score - a[1].score);

    log.log(`[GraphMemory] balanced: semantic=${semanticTake.length}/${semanticPool.length} recency=${recencyTake.length}/${recencyPool.length} overflow=${overflow.length} final=${sorted.length}`);
    log.log(`[GraphMemory] final: ${sorted.length} entries, scores=${sorted.slice(0, 5).map(([id, info]) => `#${id}(${info.score.toFixed(3)})`).join(", ")}`);

    const fetchStart = Date.now();
    const fetchMs = Date.now() - fetchStart;

    const entryMap = preliminaryEntryMap;
    const fetchedEntries = preliminaryFetchedEntries;

    // Tiered rendering: allocate token budget across candidates by score
    const tieredCandidates = sorted.map(([id, info]) => ({ id, score: info.score, sources: info.sources }));
    const allocated = allocateTiers(tieredCandidates, entryMap as Map<number, any>, sourceRefs, tokenBudget);

    const lines: string[] = ["Memories matching query:"];
    for (const item of allocated) {
      lines.push(item.rendered);
    }

    const result = lines.join("\n");
    _graphMemoryCache.set(queryHash, result);
    while (_graphMemoryCache.size > 50) {
      _graphMemoryCache.evictOldest();
    }

    const tierCounts = { full: 0, detail: 0, signal: 0 };
    for (const item of allocated) tierCounts[item.tier]++;
    log.log(`[GraphMemory] tiered: budget=${tokenBudget} full=${tierCounts.full} detail=${tierCounts.detail} signal=${tierCounts.signal} total=${allocated.length} chars=${result.length}`);
    log.verbose(() => `resolveGraphMemory DONE seeds=${allSeeds.length} cacheMisses=${cacheMissCount} causal=${causalResults.length}(${causalMs}ms) contrastive=${contrastiveResults.length}(${contrastiveMs}ms) temporal=${temporalResults.length}(${temporalMs}ms) fetched=${fetchedEntries.length}(${fetchMs}ms) seedLoad=${seedMs}ms blended=${sorted.length} chars=${result.length} elapsed=${Date.now() - start}ms`);
    return result;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`resolveGraphMemory error: ${message}`);
    return "Graph memory temporarily unavailable.";
  }
}

interface VnextTierEntry {
  id: number;
  title: string | null;
  oneLiner: string | null;
  summary: string | null;
  content: string;
  tags: string[] | null;
  createdAt: string | null;
  integrationStage: string | null;
  layer: string;
  metadata: unknown;
}

function renderVnextContext(
  candidates: Awaited<ReturnType<typeof import("./memory/vnext-context-retrieval").retrieveVnextContext>>["candidates"],
  tokenBudget: number,
): string {
  const entries = new Map<number, VnextTierEntry>();
  const refs = new Map<number, ContextSourceRef[]>();
  for (const candidate of candidates) {
    const claim = candidate.claim;
    entries.set(claim.id, {
      id: claim.id,
      title: claim.title,
      oneLiner: claim.content,
      summary: claim.content,
      content: claim.content,
      tags: claim.topics,
      createdAt: claim.createdAt.toISOString(),
      integrationStage: claim.lifecycleStage,
      layer: "vnext",
      metadata: {
        ...(claim.metadata as Record<string, unknown> ?? {}),
        confidence: claim.confidence,
        claimType: claim.claimType,
        recallCount: claim.recallCount,
      },
    });
    refs.set(claim.id, candidate.sourceRefs.map((ref) => ({
      sourceType: ref.sourceType,
      sourceId: ref.sourceId,
      relationship: ref.relationship,
      strength: ref.strength,
      context: ref.context,
    })));
  }
  const allocated = allocateTiers(
    candidates.map((candidate) => ({ id: candidate.claim.id, score: candidate.score, sources: candidate.paths })),
    entries,
    refs,
    tokenBudget,
  );
  if (allocated.length === 0) return "";
  return ["Memories matching query:", ...allocated.map((item) => item.rendered)].join("\n");
}

async function resolveGraphMemory(request: ContextRequest): Promise<string> {
  const focusParts: string[] = [];
  if (request.currentMessage) focusParts.push(request.currentMessage.slice(0, 1000));
  if (request.memoryQuery) focusParts.push(request.memoryQuery.slice(0, 1000));
  if (request.conversationHistory?.length) {
    focusParts.push(request.conversationHistory.slice(-3).map((message) => message.content).join("\n").slice(-500));
  }
  if (request.sessionId) {
    try {
      const session = await chatFileStorage.getSession(request.sessionId);
      if (session?.title && session.title !== "New Session" && session.title !== "New Chat") focusParts.push(session.title);
      if (session?.topics?.length) focusParts.push(session.topics.join(" "));
    } catch { /* session metadata is optional */ }
  }
  const focusText = focusParts.filter(Boolean).join("\n");
  if (!focusText) return "";

  const tokenBudget = await getMemoryGraphTokenBudget();
  const queryHash = `${contextPrincipalKey()}::vnext::${getQueryHash(focusText)}::${tokenBudget}`;
  const cached = _graphMemoryCache.get(queryHash);
  if (cached !== undefined) return cached;

  try {
    const sessionTopics = request.sessionId
      ? (await chatFileStorage.getSession(request.sessionId).catch(() => null))?.topics ?? []
      : [];
    const detection = detectSessionType(`${focusText} ${sessionTopics.join(" ")}`);
    let emotionInput: { valence: number; arousal: number } | null = null;
    const currentEmotion = await fileEmotionalStateStorage.getCurrent().catch(() => null);
    if (currentEmotion && !currentEmotion.stale) {
      emotionInput = { valence: currentEmotion.valence, arousal: currentEmotion.arousal };
    }
    const { weights } = modulateWeights(BLEND_WEIGHTS[detection.type], emotionInput);
    const { retrieveVnextContext } = await import("./memory/vnext-context-retrieval");
    const retrieved = await retrieveVnextContext(focusText, weights);
    const result = renderVnextContext(retrieved.candidates, tokenBudget);
    if (result) {
      _graphMemoryCache.set(queryHash, result);
      log.debug(JSON.stringify({
        event: "memory.graph.context_resolved",
        path: "vnext",
        semanticSeeds: retrieved.semanticSeedCount,
        recentSeeds: retrieved.recentSeedCount,
        expanded: retrieved.expandedCount,
        candidates: retrieved.candidates.length,
      }));
      return result;
    }
    log.warn(JSON.stringify({ event: "memory.graph.context_fallback", path: "legacy", reason: "vnext_empty" }));
  } catch (err) {
    log.warn(JSON.stringify({
      event: "memory.graph.context_fallback",
      path: "legacy",
      reason: "vnext_error",
      error: err instanceof Error ? err.message : String(err),
    }));
  }
  return resolveLegacyGraphMemory(request);
}

async function resolveTemporalLog(): Promise<string> {
  try {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const summaryMap = await memoryStorage.getEventSummaryByRange(sevenDaysAgo, now);
    const summaryParts = Object.entries(summaryMap)
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => `${type}: ${count}`)
      .join(", ");

    const { assembleTemporalLog } = await import("./temporal-log");
    const temporalContent = await assembleTemporalLog();

    const header = summaryParts
      ? `Memory activity (last 7 days): ${summaryParts}`
      : "Memory activity (last 7 days): none";

    if (!temporalContent) {
      return header;
    }

    return `${header}\n\n${temporalContent}`;
  } catch (err: any) {
    log.warn(`resolveTemporalLog error: ${err.message}`);
    return "Temporal log temporarily unavailable.";
  }
}

function formatRelativeTime(date: Date): string {
  if (isNaN(date.getTime())) return "unknown time";
  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const THOUGHT_CONTEXT_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const THOUGHT_CONTEXT_LIMIT = 15;

function stripLegacyThoughtTags(text: string): string {
  return text.replace(/^<thought>\n?/, "").replace(/\n?<\/thought>$/, "");
}

async function resolveThoughts(): Promise<string> {
  const intro = `What follows is your recent observation history — metacognitive observations you recorded using the observe tool. These are typed: (pattern) what repeats, (gap) expected vs found, (change) what shifted, (connection) how things link, (opportunity) what's possible.

Use this as your foundation: build forward from these insights, go deeper where warranted, and move to new territory. Do not restate or rephrase observations you have already recorded. Quality over quantity — only call observe when the observation is specific, evidence-based, and will genuinely inform future interactions.`;
  try {
    const allRecent = await getRecentThoughts(THOUGHT_CONTEXT_MAX_AGE_MS, THOUGHT_CONTEXT_LIMIT);
    const recent = allRecent.filter(t => t.type !== "thought");
    if (recent.length === 0) {
      return `${intro}\n\nNo recent observations.`;
    }
    const rendered = recent.map(t => {
      const ts = t.occurredAt ? formatRelativeTime(new Date(t.occurredAt)) : "unknown time";
      const typeLabel = t.type ? `(${t.type})` : "(reflect)";
      const cleanText = stripLegacyThoughtTags(t.text);
      return `${typeLabel} [${ts}] ${cleanText}`;
    }).join("\n\n");
    return `${intro}\n\n${rendered}`;
  } catch (err: unknown) {
    log.warn(`resolveThoughts error: ${err instanceof Error ? err.message : String(err)}`);
    return `${intro}\n\nNo recent observations.`;
  }
}

const TOOL_SHORT_DESCRIPTIONS: Record<string, string> = {
  beliefs: "Manage beliefs with confidence scores. Actions: list, get, save, create, update, invalidate.",
  code: "Query and navigate the codebase knowledge graph. Actions: query, context, impact, changes, architecture, modules, flows, rename, schema, cypher.",
  docx: "Read, write, edit, and clone Word documents. Actions: read, write, edit, clone.",
  files: "Manage persistent files in object storage. Actions: write, read, list.",
  finance: "Query financial data from connected accounts. Actions: summary, transactions, holdings, liabilities, recurring, link_account, refresh.",
  git: "Interact with Git repositories. Actions: clone, pull, status, log, diff, branch, checkout, show.",
  gmail: "Read, search, create, and update persisted email drafts via Gmail. When creating an email intended for Ray to review or send, use draft or update_draft so the inline draft widget appears; plain chat email text is only for brainstorming or explicit copy-only requests. The human sends via the draft widget's Send button. There is no tool-level send action. Actions: status, search, read, draft, update_draft, recent, download_attachment.",
  goals: "Manage life goals by domain and time horizon. Actions: list, get, create, update, delete, search, set_parent, unlink_parent.",
  intentions: `DEPRECATED — intentions system removed. Use the autonomy skill instead.`,
  router: "Call and inspect the model routing layer. Actions: eval, list_inference_calls, get_inference_call.",
  library: "Manage wiki pages, notes, and annotations. Actions: list_library_pages, get_library_page, create_library_page, update_library_page, edit_library_page, dismiss_library_page, delete_library_page, search_library_pages, search, link_pages, annotate.",
  meetings: "Manage calendar events. Actions: add, list, update, delete.",
  memory: "Unified memory — read/write knowledge files, search all layers, manage graph links, run maintenance. Actions: read, write, read_entry, search, create_link, update_entry, get, consolidate_short, integrate_mid_to_long, run_myelination, run_memory_decay, run_memory_reinforcement, run_capability_audit.",
  notion: "Search, read, and browse Notion pages and databases. Actions: status, search, get_page, get_content, list_databases, query_database.",
  people: "Manage personal contacts — search, get details, outreach agenda, notes, interactions. Actions: list, get, search, agenda, add_note, update_note, delete_note, log_interaction, create, scan_imports, scan_ignored.",
  preferences: "Manage learned user preferences. Actions: list, get, save, create, update, delete, reinforce.",
  priorities: "Manage daily/weekly/monthly priorities and next-period (next_day, next_week, next_month) priorities (max 3 each). Actions: add, update, remove, mark_status.",
  rules: "Manage behavioral rules and directives. Actions: list, get, save, create, update, delete, reinforce, violation.",
  scratch: "Manage temporary workspace files. Actions: read, write, edit, list, search.",
  shell: "Execute a shell command in the workspace directory.",
  skills: `Manage ${getInstanceName()}'s skill library. Actions: list, get, create, update, delete, search.`,
  strategy: "Strategic modeling — strategies, actors, move trees, simulations, assumptions, artifacts.",
  system: "System operations — state snapshot, create issues, retrieve runtime logs. Actions: state, create_issue, logs.",
  tasks: "Create, complete, delete, and update tasks. Actions: create, complete, delete, update.",
  observe: "Record an observation about your own cognition. Not what you thought, but what you notice about how you thought. What pattern fired? What gap appeared? What changed? What connection formed? What's now possible? 1-3 short sentences MAX. If it doesn't pass \"would this change how I act next time?\", don't record it.",
  orient: "Unified session orientation — set title, topics, and persona in a single call. All parameters optional for partial updates.",
  session: "Manage session metadata and lifecycle. Actions: get, set_status, end, list, search, get_messages.",
  converse: "Start a new conversation with the user or flag an existing one for attention. Actions: initiate, set_attention.",
  timers: "Manage scheduled timers and one-time reminders — list, get details, view runs, create, update, delete, or manually trigger. Actions: list, get, runs, create, update, delete, trigger.",
  health: "Query health metrics and fully manage the wellness calendar. Actions: summary (7-day health summary), metrics (raw metric rows), list_activities (all wellness activities), log_activity (record completion by ID or name), activity_status (grouped by overdue/due_soon/on_track/never_done), create_activity (name + intervalDays required, category auto-derived: 1d=daily, 2-7d=weekly, 8-30d=monthly, 31-90d=quarterly, 91+=annual), update_activity (modify by ID or name), delete_activity (archive by ID or name), activity_logs (completion history).",

  tools: "Look up detailed tool documentation. Actions: list, get.",
  web: "Search the web or fetch content from URLs. Actions: search, fetch.",
  work: "Manage projects and work status. Actions: create_project, status, list_projects, get_project, list_tasks, set_goal, add_note, update_note, remove_note, add_file, read_file, remove_file, add_milestone, update_milestone, remove_milestone.",
};

async function resolveCodeInstructions(): Promise<string> {
  const header = `## Coding Instructions

This section is always loaded. Use it for code changes, debugging, repo/system diagnosis, builds, PRs, merges, deployments, and implementation planning.`;

  // Strategy 1: Load from environment context artifact (kind = 'coding_process')
  try {
    const { db } = await import("./db");
    const { eq } = await import("drizzle-orm");
    const { environmentContextArtifacts } = await import("@shared/models/platforms");
    const { libraryPages } = await import("@shared/models/info");

    // Find all coding_process artifacts across environments
    const artifactRows = await db
      .select({
        libraryPageId: environmentContextArtifacts.libraryPageId,
        environmentId: environmentContextArtifacts.environmentId,
      })
      .from(environmentContextArtifacts)
      .where(eq(environmentContextArtifacts.kind, "coding_process"));

    if (artifactRows.length > 0) {
      const { inArray } = await import("drizzle-orm");
      const pageIds = artifactRows.map(r => r.libraryPageId);
      const pages = await db
        .select({ id: libraryPages.id, content: libraryPages.plainTextContent })
        .from(libraryPages)
        .where(inArray(libraryPages.id, pageIds));

      const contents = pages.filter(p => p.content).map(p => p.content!.trim());
      if (contents.length > 0) {
        return `${header}

${contents.join("\n\n---\n\n")}`;
      }
    }
  } catch (err) {
    // Fall through to next strategy
    const { createLogger } = await import("./log");
    createLogger("ContextBuilder").warn("Failed to load coding process from environment artifact", { error: err instanceof Error ? err.message : String(err) });
  }

  // Strategy 2: Filesystem fallback (CODING.md)
  try {
    const codingProcessPath = path.resolve(process.cwd(), "CODING.md");
    const codingProcess = await readFile(codingProcessPath, "utf-8");
    const { createLogger } = await import("./log");
    createLogger("ContextBuilder").warn("Coding instructions loaded from filesystem CODING.md (fallback). Prefer linking a Library page as a coding_process context artifact on the platform environment.");
    return `${header}

${codingProcess.trim()}`;
  } catch {
    // All strategies failed
  }

  // Strategy 3: Degraded
  return `${header}

WARNING: Coding instructions could not be loaded from any source (environment context artifact or filesystem CODING.md). Coding work may proceed with reduced guidance. Report this in the final coding report as a degraded check.`;
}

async function resolvePlanningInstructions(): Promise<string> {
  const header = `## Planning Instructions

This section is always loaded. Use it for any complex, multi-turn, or cross-domain task.`;

  // Strategy 1: Load from environment context artifact (kind = 'planning_process')
  try {
    const { db } = await import("./db");
    const { eq } = await import("drizzle-orm");
    const { environmentContextArtifacts } = await import("@shared/models/platforms");
    const { libraryPages } = await import("@shared/models/info");

    const artifactRows = await db
      .select({ libraryPageId: environmentContextArtifacts.libraryPageId })
      .from(environmentContextArtifacts)
      .where(eq(environmentContextArtifacts.kind, "planning_process"));

    if (artifactRows.length > 0) {
      const { inArray } = await import("drizzle-orm");
      const pageIds = artifactRows.map(r => r.libraryPageId);
      const pages = await db
        .select({ id: libraryPages.id, content: libraryPages.plainTextContent })
        .from(libraryPages)
        .where(inArray(libraryPages.id, pageIds));

      const contents = pages.filter(p => p.content).map(p => p.content!.trim());
      if (contents.length > 0) {
        return `${header}

${contents.join("\n\n---\n\n")}`;
      }
    }
  } catch (err) {
    const { createLogger } = await import("./log");
    createLogger("ContextBuilder").warn("Failed to load planning process from environment artifact", { error: err instanceof Error ? err.message : String(err) });
  }

  // Strategy 2: Filesystem fallback (PLANNING.md)
  try {
    const planningProcessPath = path.resolve(process.cwd(), "PLANNING.md");
    const planningProcess = await readFile(planningProcessPath, "utf-8");
    const { createLogger } = await import("./log");
    createLogger("ContextBuilder").warn("Planning instructions loaded from filesystem PLANNING.md (fallback). Prefer linking a Library page as a planning_process context artifact on the platform environment.");
    return `${header}

${planningProcess.trim()}`;
  } catch {
    // All strategies failed
  }

  // Strategy 3: Degraded
  return `${header}

WARNING: Planning instructions could not be loaded from any source (environment context artifact or filesystem PLANNING.md). Planning may proceed with reduced guidance.`;
}

async function resolveGoalsInstructions(): Promise<string> {
  try {
    const goalsProcessPath = path.resolve(process.cwd(), "GOALS.md");
    const goalsProcess = await readFile(goalsProcessPath, "utf-8");
    return `## Goals Instructions

This section is always loaded. Use it whenever goals may be created, edited, linked, reviewed, or discussed.

${goalsProcess.trim()}`;
  } catch (error) {
    return `## Goals Instructions

CRITICAL: Failed to load root GOALS.md. Do not create or modify goals until GOALS.md can be loaded. Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function resolveTools(request: ContextRequest): Promise<string> {
  const toolDefs = getToolSchemas().map(t => ({ name: t.name, description: t.description }));
  if (toolDefs.length === 0) return "No tools available for this session.";

  const mode = request.llmMode;
  const preamble = mode === "voice"
    ? "Tools are available. In voice mode, prefer simple tool calls and concise responses."
    : "Tools are available through callable schemas. Do not rely on boot context as a tool manual; call `tools` with action `get` for detailed documentation when needed.";

  return [
    preamble,
    "",
    "**Tool routing instructions:**",
    "- Use tools immediately when they can do the requested work or fetch authoritative state.",
    "- Default to pulling the relevant slice of Ray’s life-context through tools when it could materially improve the answer. Do not wait to be reminded; do not over-fetch.",
    "- Preference = how Ray likes something done. Rule = governing instruction or boundary.",
    "- Save only specific, explicit, durable, repeated, or clearly action-relevant preferences/rules.",
    "- Check for existing matches before creating new state; reinforce/update rather than duplicate.",
    "- Treat tool inputs as sparse patches: omit unknown, unchanged, or blank optional fields. Use explicit clearFields/confirmation semantics for destructive clears; never send empty strings, empty arrays, or empty objects as a way to clear persisted data.",
    "- References are fundamental object links, like HTML links for Agent's world. Use typed references whenever you mention durable objects with known IDs.",
    "- Canonical persisted grammar is `@type:id`. Supported types are page, person, goal, task, project, milestone, meeting, decision, wellness_activity, priority, file, news, web_article, x_item, reddit_post, rss_item, and pr. Use the registry/parser rather than hard-coded partial lists when generating or rendering references.",
    "- `#` is a composer/search trigger for references, especially work items; selected mentions still insert canonical `@type:id` text. Do not treat `#goal`/`#task` as the persisted reference grammar unless the shared parser explicitly supports it.",
    "- Prefer canonical `@type:id` syntax over legacy `[page:slug]` / `[person:id]` / `[goal:id]` / `[spec:slug]` / `Intention ID: <id>` forms. Legacy syntax is compatibility only.",
    "- Detailed tool schemas and action parameters are already available at the tool boundary; retrieve prose docs with tools.get only when necessary.",
  ].join("\n");
}

async function resolveSkills(): Promise<string> {
  try {
    return await getSkillDefinitionsForContext();
  } catch (err: any) {
    log.warn(`resolveSkills error: ${err.message}`);
    return "Skills unavailable.";
  }
}

async function resolveLibraryIndex(): Promise<string> {
  try {
    const { getLibraryIndex } = await import("./library-index");
    const index = await getLibraryIndex();
    const canonicalLines = Object.entries(index).map(([type, entry]) => {
      return `- ${type} → "${entry.title}" — naming: ${entry.namingConvention}`;
    });

    return `## Library Reference

The Library is durable, searchable knowledge storage. Do not load the full tree into boot context.

Use Library tools on demand:
- search_library_pages/search: find relevant pages by query.
- browse_tree/tree: inspect hierarchy when filing or browsing.
- get_library_page: load full page content.
- resolve_parent: preview which canonical parent the Library index will use for an artifact.
- create_library_page/edit_library_page: create or modify durable artifacts. For create_library_page, provide purpose/pageContext/contentSummary so the Library index resolves the parent; do not browse the tree or supply raw parentId for system-created pages. Pass surface=true with surfaceDurationHours to show a page in Home/Simple Inbox; use dismiss_library_page or surface=false to de-surface it.

When creating externally shareable artifacts, use a Library page rather than scratch. The Library save flow owns filing: describe the artifact purpose and context, and let the Library index choose the parent.

### Filing references
${canonicalLines.join("\n")}`;
  } catch (err: any) {
    log.warn(`resolveLibraryIndex error: ${err.message}`);
    return "Library reference unavailable. Use library.search_library_pages or library.browse_tree when Library context is needed.";
  }
}

function getContextWindowForModel(model: string): number {
  const bareModel = model.includes("/") ? model.split("/").slice(1).join("/") : model;
  return getContextWindow(bareModel);
}

function getDayPhase(tz: string): "morning" | "afternoon" | "evening" {
  const now = new Date();
  const hourStr = now.toLocaleString("en-US", { timeZone: tz, hour: "numeric", hour12: false });
  const hour = parseInt(hourStr, 10);
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}


async function findPersonByRole(role: "self" | "partner"): Promise<(Awaited<ReturnType<typeof peopleStorage.getPerson>> & { identityContent?: string }) | null> {
  try {
    const allPeople = await peopleStorage.listPeople();

    let match;
    if (role === "self") {
      // Look for the agent person (new "agent" level, fallback to legacy "self")
      match = allPeople.find(p => p.cabinetLevel === "agent");
      if (!match) {
        const selfPeople = allPeople.filter(p => p.cabinetLevel === "self");
        match = selfPeople.find(p => p.name.toLowerCase() === getInstanceNameLower());
        if (!match) match = selfPeople[0];
      }
    } else {
      // Look for the user person (new "user" level, fallback to legacy "self" non-agent, then family)
      match = allPeople.find(p => p.cabinetLevel === "user");
      if (!match) {
        const selfPeople = allPeople.filter(p => p.cabinetLevel === "self");
        match = selfPeople.find(p => p.name.toLowerCase() !== getInstanceNameLower());
      }
      if (!match) {
        const familyPeople = allPeople.filter(p => p.cabinetLevel === "family");
        for (const fp of familyPeople) {
          const full = await peopleStorage.getPerson(fp.id);
          if (full?.identityContent) { match = fp; break; }
        }
      }
    }

    if (!match) return null;
    const person = await peopleStorage.getPerson(match.id);
    return person as any;
  } catch {
    return null;
  }
}

function buildSectionTree(resolvedSections: Map<string, { config: SpineSectionConfig; content: string }>): ResolvedSection[] {
  const now = new Date().toISOString();
  const allResolved: ResolvedSection[] = [];

  for (const [id, { config, content }] of resolvedSections) {
    allResolved.push({
      id: config.id,
      title: config.title,
      parentId: config.parentId,
      sourceType: config.sourceType,
      freshnessPolicy: config.freshnessPolicy,
      priority: config.priority,
      enabled: true,
      content,
      tokenCount: estimateTokens(content),
      resolvedAt: now,
      children: [],
    });
  }

  const byId = new Map(allResolved.map(s => [s.id, s]));
  const roots: ResolvedSection[] = [];

  for (const section of allResolved) {
    if (section.parentId && byId.has(section.parentId)) {
      byId.get(section.parentId)!.children.push(section);
    } else if (!section.parentId) {
      roots.push(section);
    } else {
      roots.push(section);
    }
  }

  const sortChildren = (sections: ResolvedSection[]) => {
    sections.sort((a, b) => a.priority - b.priority);
    for (const s of sections) sortChildren(s.children);
  };
  sortChildren(roots);

  return roots;
}

function generateTOC(sections: ResolvedSection[], depth: number = 0, parentNumber: string = ""): string {
  const lines: string[] = [];
  let counter = 0;
  for (const section of sections) {
    if (section.content || section.children.length > 0) {
      counter++;
      const number = parentNumber ? `${parentNumber}.${counter}` : `${counter}`;
      const indent = "  ".repeat(depth);
      lines.push(`${indent}${number}. ${section.title}`);
      if (section.children.length > 0) {
        lines.push(generateTOC(section.children, depth + 1, number));
      }
    }
  }
  return lines.join("\n");
}

function countTokensRecursive(sections: ResolvedSection[]): number {
  let total = 0;
  for (const s of sections) {
    total += s.tokenCount;
    total += countTokensRecursive(s.children);
  }
  return total;
}

function countSections(sections: ResolvedSection[], countFn: (s: ResolvedSection) => boolean): number {
  let count = 0;
  for (const s of sections) {
    if (countFn(s)) count++;
    count += countSections(s.children, countFn);
  }
  return count;
}

export class ContextBuilder {
  async resolve(request: ContextRequest, onProgress?: (step: string, status: "started" | "done", elapsedMs?: number) => void): Promise<ResolvedSpine> {
    const { callType, llmMode = "text" } = request;
    const start = Date.now();

    log.debug(`resolve start callType=${callType} llmMode=${llmMode} activity=${request.activity ?? "none"} sessionKey=${request.sessionKey ?? "none"}`);

    if (callType === "none") {
      log.debug(`resolve skipped (callType=none)`);
      return {
        callType,
        llmMode,
        sections: [],
        metadata: {
          totalTokens: 0,
          sectionCount: 0,
          activeSectionCount: 0,
          placeholderCount: 0,
          assembledAt: new Date().toISOString(),
          callType,
          llmMode,
          sessionKey: request.sessionKey || null,
          activity: request.activity || null,
          modelTier: null,
          modelId: null,
          contextWindow: null,
        },
      };
    }

    const sectionConfigs = getSectionsForCallType(callType, request.includeSections, request.excludeSections);
    log.debug(`resolve: ${sectionConfigs.length} sections to resolve for callType=${callType}${request.includeSections?.length ? ` +include=[${request.includeSections.join(",")}]` : ""}${request.excludeSections?.length ? ` -exclude=[${request.excludeSections.join(",")}]` : ""}`);
    const resolvedMap = new Map<string, { config: SpineSectionConfig; content: string }>();

    const phaseMap: Record<string, string> = {};
    const phaseSectionCounts: Record<string, number> = {};
    const phaseResolvedCounts: Record<string, number> = {};
    const phaseStartTimes: Record<string, number> = {};
    const phaseEmitted: Record<string, boolean> = {};

    const getWorldModelSubPhase = (sectionId: string): string => {
      if (sectionId === "world_model.people.self.identity"
        || sectionId === "world_model.people.self.voice"
        || sectionId === "world_model.people.self.emotional_expression"
        || sectionId === "world_model.people.self.persona"
        || sectionId === "world_model.people.self.general_instructions"
        || sectionId === "world_model.people.self.chat_instructions") {
        return "ctx_wm_identity";
      }
      if (sectionId === "world_model.people.partner.goals") {
        return "ctx_pri_goals";
      }
      if (sectionId === "world_model.people.partner.goals"
        || sectionId === "world_model.people.partner.goals.today") {
        return "ctx_pri_today";
      }
      if (sectionId === "world_model.people.partner.goals.this_week") {
        return "ctx_pri_week";
      }
      if (sectionId === "world_model.people.partner.goals.this_month") {
        return "ctx_pri_month";
      }

      if (sectionId === "world_model.people.self.principles") {
        return "ctx_pri_principles";
      }
      if (sectionId === "world_model.people.self.rules") {
        return "ctx_pri_rules";
      }
      if (sectionId === "world_model.people.self.journal") {
        return "ctx_pri_journal";
      }
      if (sectionId === "world_model.people.partner"
        || sectionId.startsWith("world_model.people.partner.")
        || sectionId === "world_model.people.others") {
        return "ctx_wm_people";
      }
      if (sectionId === "world_model.active_work"
        || sectionId.startsWith("world_model.active_work.")) {
        return "ctx_wm_work";
      }
      if (sectionId === "world_model.calendar") {
        return "ctx_wm_calendar";
      }
      if (sectionId === "world_model.beliefs") {
        return "ctx_wm_beliefs";
      }
      if (sectionId === "session_context" || sectionId === "thoughts"
        || sectionId === "world_model.temporal") {
        return "ctx_wm_session";
      }
      return "ctx_wm_identity";
    };

    for (const config of sectionConfigs) {
      let phase: string;
      if (config.id === "world_model" || config.id.startsWith("world_model.")) {
        phase = getWorldModelSubPhase(config.id);
      } else if (config.id === "session_context" || config.id === "thoughts") {
        phase = "ctx_wm_session";
      } else if (config.id === "memory" || config.id.startsWith("memory.")) {
        phase = "ctx_memory";
      } else if (config.id === "capabilities" || config.id.startsWith("capabilities.")) {
        phase = "ctx_skills_tools";
      } else {
        phase = "ctx_wm_identity";
      }
      phaseMap[config.id] = phase;
      phaseSectionCounts[phase] = (phaseSectionCounts[phase] || 0) + 1;
      phaseResolvedCounts[phase] = phaseResolvedCounts[phase] || 0;
      phaseEmitted[phase] = false;
    }

    for (const phase of Object.keys(phaseSectionCounts)) {
      phaseStartTimes[phase] = Date.now();
      onProgress?.(phase, "started");
    }

    const inFlight = getInFlightStats();
    const breakdown = Object.entries(inFlight.bySubsystem)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    const contextBuildInFlight = inFlight.bySubsystem["context-build"] || 0;
    log.verbose(() => `context-build fan-out: sections=${sectionConfigs.length} concurrency=unlimited contextBuildInFlight=${contextBuildInFlight} dbInFlight=${inFlight.total}${breakdown ? ` [${breakdown}]` : ""}`);

    if (activePreWarm) {
      const preWarmWaitStart = Date.now();
      log.verbose("context-build waiting for in-progress pre-warm to complete before fan-out");
      try {
        await activePreWarm;
      } catch (err: any) {
        log.warn(`context-build pre-warm failed during wait (non-fatal): ${err?.message || err}`);
      }
      log.verbose(() => `context-build pre-warm settled in ${Date.now() - preWarmWaitStart}ms, proceeding with fan-out`);
    }

    const resolvePromises = sectionConfigs.map(async (config) => {
      const resolver = sectionResolvers[config.id];
      if (!resolver) {
        resolvedMap.set(config.id, { config, content: "" });
        const phase = phaseMap[config.id];
        phaseResolvedCounts[phase]++;
        if (phaseResolvedCounts[phase] === phaseSectionCounts[phase] && !phaseEmitted[phase]) {
          phaseEmitted[phase] = true;
          onProgress?.(phase, "done", Date.now() - phaseStartTimes[phase]);
        }
        return;
      }
      const sectionStart = Date.now();
      log.verbose(() => `resolve section=${config.id} START`);
      try {
        const content = await withQueryAttributionAsync("context-build", () =>
          withTimeout(
            resolveWithCacheAndCoalescing(config.id, config, resolver, request),
            SECTION_RESOLVE_TIMEOUT_MS,
            `section:${config.id}`,
          )
        , `section:${config.id}`);
        const sectionElapsed = Date.now() - sectionStart;
        const tokens = estimateTokens(content);
        log.verbose(() => `resolve section=${config.id} DONE tokens=${tokens} elapsed=${sectionElapsed}ms${sectionElapsed > 500 ? " (slow)" : ""}`);
        resolvedMap.set(config.id, { config, content });
      } catch (err: any) {
        const sectionElapsed = Date.now() - sectionStart;
        if (isTimeoutError(err)) {
          log.error(`resolve TIMEOUT section=${config.id} elapsed=${sectionElapsed}ms`);
          resolvedMap.set(config.id, { config, content: `[section ${config.id} timed out after ${sectionElapsed}ms]` });
        } else {
          log.error(`resolve ERROR section=${config.id} elapsed=${sectionElapsed}ms: ${err.message}`, err.stack);
          resolvedMap.set(config.id, { config, content: `[section ${config.id} failed: ${err.message}]` });
        }
      }
      const phase = phaseMap[config.id];
      phaseResolvedCounts[phase]++;
      if (phaseResolvedCounts[phase] === phaseSectionCounts[phase] && !phaseEmitted[phase]) {
        phaseEmitted[phase] = true;
        onProgress?.(phase, "done", Date.now() - phaseStartTimes[phase]);
      }
    });

    await Promise.all(resolvePromises);

    onProgress?.("ctx_render", "started");
    const sections = buildSectionTree(resolvedMap);
    await injectMemoryEntryChildren(sections, request.sessionId);
    const totalTokens = countTokensRecursive(sections);
    const sectionCount = countSections(sections, () => true);
    const activeSectionCount = countSections(sections, s => s.content.length > 0 && s.sourceType !== "placeholder");
    const placeholderCount = countSections(sections, s => s.sourceType === "placeholder");

    // Collect per-section token counts and instruction/reference manifest.
    const sectionTokenCounts: Record<string, number> = {};
    const instructionGroupTokens = new Map<string, { title: string; sectionIds: Set<string>; tokenCount: number }>();
    const references: SpineMetadata["references"] = [];
    const collectTokenCounts = (sects: ResolvedSection[]) => {
      for (const s of sects) {
        const subtotal = s.tokenCount + countTokensRecursive(s.children);
        if (subtotal > 0) {
          sectionTokenCounts[s.id] = subtotal;
          log.verbose(() => `context.assembly section_id=${s.id} tokens=${subtotal}`);
        }
        const group = getInstructionGroupBySection(s.id);
        if (group) {
          const current = instructionGroupTokens.get(group.id) || { title: group.title, sectionIds: new Set<string>(), tokenCount: 0 };
          current.sectionIds.add(s.id);
          current.tokenCount += subtotal;
          instructionGroupTokens.set(group.id, current);
        }
        const config = SPINE_SECTIONS.find(section => section.id === s.id);
        if (config?.referenceOnly) {
          references.push({
            id: s.id,
            title: s.title,
            status: subtotal > 0 ? "referenced" : "omitted",
            reason: "Reference-only section renders compact retrieval guidance instead of full documentation.",
          });
        }
        collectTokenCounts(s.children);
      }
    };
    collectTokenCounts(sections);

    const instructionGroups: SpineMetadata["instructionGroups"] = [...instructionGroupTokens.entries()].map(([id, group]) => ({
      id,
      title: group.title,
      status: group.tokenCount > 0 ? "included" : "omitted",
      sectionIds: [...group.sectionIds],
      tokenCount: group.tokenCount,
    }));

    const codingInstructionTokens = sectionTokenCounts["capabilities.code_instructions"] || 0;
    const codingContext: SpineMetadata["codingContext"] = {
      alwaysOn: true,
      requiredReferences: [
        {
          id: "coding_instructions",
          label: "Compact coding instructions",
          required: true,
          loaded: codingInstructionTokens > 0,
          source: "capabilities.code_instructions",
          evidence: codingInstructionTokens > 0 ? [`${codingInstructionTokens} tokens included`] : ["Missing from rendered context"],
        },
        {
          id: "root_agents",
          label: "Root AGENTS.md",
          required: true,
          loaded: false,
          source: "repo root",
          evidence: ["Loaded by engineering tool preflight when code/system tools execute"],
        },
        {
          id: "subdir_agents",
          label: "Relevant subdirectory AGENTS.md",
          required: false,
          loaded: false,
          source: "client/server/mobile/etc.",
          evidence: ["Required once a file path or subtree is known"],
        },
        {
          id: "design_md",
          label: "DESIGN.md",
          required: false,
          loaded: false,
          source: "repo root",
          evidence: ["Required for UI/product-facing work"],
        },
      ],
    };

    const { modelTier: tier, modelId, contextWindow } = this.resolveModelInfo(request);

    const elapsed = Date.now() - start;
    log.debug(`resolve done in ${elapsed}ms callType=${callType} totalTokens=${totalTokens} sections=${sectionCount} active=${activeSectionCount} placeholders=${placeholderCount} instructionGroups=${instructionGroups.map(g => g.id).join(",") || "none"} references=${references.map(r => r.id).join(",") || "none"} model=${modelId ?? "none"} contextWindow=${contextWindow ?? "none"}`);

    return {
      callType,
      llmMode,
      sections,
      metadata: {
        totalTokens,
        sectionCount,
        activeSectionCount,
        placeholderCount,
        assembledAt: new Date().toISOString(),
        callType,
        llmMode,
        sessionKey: request.sessionKey || null,
        activity: request.activity || null,
        modelTier: tier,
        modelId,
        contextWindow,
        includeSections: request.includeSections?.length ? request.includeSections : undefined,
        excludeSections: request.excludeSections?.length ? request.excludeSections : undefined,
        sectionTokenCounts,
        instructionGroups: instructionGroups.length ? instructionGroups : undefined,
        references: references.length ? references : undefined,
        codingContext,
      },
    };
  }

  private resolveModelInfo(request: ContextRequest): { modelTier: string | null; modelId: string | null; contextWindow: number | null } {
    try {
      const config = getJobProfileConfig();
      const activityId = (request.activity || ACTIVITY_CHAT) as ActivityId;
      const routingTier = config.routing[activityId] || "high";
      const effectiveTier = routingTier === "auto" ? "balanced" : routingTier;
      const modelId = config.tiers[effectiveTier as TierId]?.model || getModelForActivity(activityId);
      const modelName = modelId.includes("/") ? modelId.split("/").slice(1).join("/") : modelId;
      const contextWindow = getContextWindowForModel(modelName);
      return { modelTier: effectiveTier, modelId, contextWindow };
    } catch {
      return { modelTier: null, modelId: null, contextWindow: null };
    }
  }

  renderToPrompt(spine: ResolvedSpine): string {
    if (spine.sections.length === 0) return "";

    log.debug(`renderToPrompt callType=${spine.callType} sections=${spine.sections.length} totalTokens=${spine.metadata.totalTokens}`);

    const parts: string[] = [];

    const bootstrapIds = getBootstrapSectionIds();

    const renderSections = (resolved: ResolvedSection[], depth: number) => {
      for (const section of resolved) {
        if (!section.content && section.children.length === 0 && !bootstrapIds.has(section.id)) continue;

        const escaped = section.content ? escapeContentForXml(section.content) : "";

        if (escaped && section.children.length > 0) {
          parts.push(`<section id="${section.id}" title="${section.title}">\n${escaped}`);
          renderSections(section.children, depth + 1);
          parts.push(`</section>`);
        } else if (escaped) {
          parts.push(`<section id="${section.id}" title="${section.title}">\n${escaped}\n</section>`);
        } else if (section.children.length > 0) {
          parts.push(`<section id="${section.id}" title="${section.title}">`);
          renderSections(section.children, depth + 1);
          parts.push(`</section>`);
        }
      }
    };

    renderSections(spine.sections, 0);

    return parts.join("\n\n");
  }
}

export const contextBuilder = new ContextBuilder();

let activePreWarm: Promise<void> | null = null;

export async function preWarmContextCaches(): Promise<void> {
  if (activePreWarm) {
    return activePreWarm;
  }

  const doPreWarm = async () => {
    const warmLog = createLogger("ContextPreWarm");

    // Skip prewarm if the section cache (Layer 3) is already warm —
    // section builders will get cache hits and never call storage.
    const keySections = [
      "world_model.people.others",
      "world_model.active_work.projects",
      "world_model.active_work.tasks",
      "world_model.people.self.principles",
      "world_model.people.self.rules",
      "world_model.people.partner.goals",
      "capabilities.goals_instructions",
      "capabilities.skills",
    ];
    const warmCount = keySections.filter(id => getCachedSection(id) !== null).length;
    if (warmCount >= 4) {
      warmLog.log(`skipped — section cache already warm (${warmCount}/${keySections.length} sections cached)`);
      return;
    }

    const start = Date.now();
    const tasks: Array<{ name: string; fn: () => Promise<unknown> }> = [
      { name: "people", fn: () => peopleStorage.listPeople() },
      { name: "projects", fn: () => fileProjectStorage.getProjects({}) },
      { name: "tasks", fn: () => fileTaskStorage.getTodoTasks() },
      { name: "principles", fn: () => filePrincipleStorage.getAllLayer1() },
      { name: "rules", fn: () => fileRuleStorage.getAll() },
      { name: "goals", fn: () => goalsService.listAll() },
      { name: "skills", fn: () => getSkillDefinitionsForContext() },
    ];

    const results = await Promise.allSettled(
      tasks.map(async ({ name, fn }) => {
        const taskStart = Date.now();
        warmLog.log(`warming ${name}...`);
        try {
          await withQueryAttributionAsync("context-prewarm", fn, name);
          warmLog.log(`warmed ${name} in ${Date.now() - taskStart}ms`);
        } catch (err: any) {
          warmLog.warn(`failed to warm ${name}: ${err.message}`);
          throw err;
        }
      })
    );

    const succeeded = results.filter(r => r.status === "fulfilled").length;
    const failed = results.filter(r => r.status === "rejected").length;
    warmLog.log(`pre-warm complete in ${Date.now() - start}ms (${succeeded}/${tasks.length} succeeded, ${failed} failed)`);
  };

  activePreWarm = doPreWarm().finally(() => {
    activePreWarm = null;
  });
  return activePreWarm;
}
