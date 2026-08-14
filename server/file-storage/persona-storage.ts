import { db } from "../db";
import { personas, personaPreferences, personaRevisions } from "@shared/models/cognition";
import { createHash, randomUUID } from "node:crypto";
import { semanticTierSchema, type SemanticTier } from "@shared/model-connectors";
import { eq, and, inArray, or, sql, type SQL } from "drizzle-orm";
import { TTLCache } from "../utils/ttl-cache";
import { createLogger } from "../log";
import { isUniqueViolationError, getPostgresConstraintName } from "../postgres-errors";
import { requireCurrentUserPrincipal } from "../principal-context";
import { createSystemPrincipal, type Principal } from "../principal";
import { principalHasPermission } from "../permissions";
import {
  combineWithVisibleScope,
  combineWithWritableScope,
  ownedInsertValues,
} from "../scoped-storage";

const log = createLogger("PersonaStorage");
// Personas are Instance mind configuration (dual-write with owner_user_id created_by),
// never Vault content. Keep vault_id as an inert compatibility column during rolling
// deployment, but exclude it from every read/write scope decision.
const personaScopeColumns = {
  scope: personas.scope,
  ownerUserId: personas.ownerUserId,
  accountId: personas.accountId,
  // Instance is the mind owner; dual-read pin OR (null + owner). Do not match account alone.
  instanceId: personas.instanceId,
};

// User revisions dual-write Instance; platform revisions stay globally readable.
// Omit scope from ScopeColumns so 'platform' is not mistaken for a template scope.
const personaRevisionUserScopeColumns = {
  ownerUserId: personaRevisions.ownerUserId,
  accountId: personaRevisions.accountId,
  instanceId: personaRevisions.instanceId,
};

const personaPreferenceScopeColumns = {
  ownerUserId: personaPreferences.ownerUserId,
  accountId: personaPreferences.accountId,
  instanceId: personaPreferences.instanceId,
};

export class PersonaReservedNameError extends Error {
  readonly statusCode = 409;

  constructor(name: string) {
    super(`"${name}" is reserved for a system persona`);
    this.name = "PersonaReservedNameError";
  }
}

export interface PersonaEntry {
  id: number;
  name: string;
  description: string;
  icon: string;
  promptOverlay: string | null;
  expressionTags: string[];
  cognitiveOverrides: Record<string, unknown>;
  semanticTier: SemanticTier | null;
  contextSections: Record<string, boolean>;
  toolBundle: string[];
  isDefault: boolean;
  isActive: boolean;
  isSystem: boolean;
  sortOrder: number;
  source: "seed" | "user";
  templatePersonaId: number | null;
  baseRevisionId: string | null;
  currentRevisionId: string | null;
  updateState: "following" | "customized" | "update_available" | "conflict" | "pinned_legacy";
  createdAt: string;
  updatedAt: string;
  platformBaseline?: PersonaRevisionPayload | null;
  changedFields?: RevisionField[];
  updateAvailable?: boolean;
}

/** Only keys with a real runtime consumer belong in cognitiveOverrides. */
function normalizeCognitiveOverrides(value: unknown): Record<string, unknown> {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  const budget = raw.memoryGraphTokenBudget;
  return typeof budget === "number" && Number.isFinite(budget) && budget > 0
    ? { memoryGraphTokenBudget: budget }
    : {};
}

/**
 * Expression tags have one logical identity — the bare token (`curious`) — and
 * one wire format: square brackets (`[curious]`), added only at the speech
 * injection seam so TTS can find them. The editing surface, storage, and
 * apply-to-default diff all operate on the bare identity; brackets are never
 * the stored form. Normalize on every read and write so a user (or a legacy
 * seed) that supplies `[curious]` or `<curious>` collapses to `curious`,
 * whitespace is trimmed, empties dropped, and duplicates removed
 * case-insensitively while preserving first-seen casing.
 */
function normalizeExpressionTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const bare = raw.trim().replace(/^[[<]+/, "").replace(/[\]>]+$/, "").trim();
    if (!bare) continue;
    const key = bare.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(bare);
  }
  return out;
}

function rowToEntry(row: typeof personas.$inferSelect): PersonaEntry {
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    icon: row.icon || "Bot",
    promptOverlay: row.promptOverlay,
    expressionTags: normalizeExpressionTags(row.expressionTags),
    cognitiveOverrides: normalizeCognitiveOverrides(row.cognitiveOverrides),
    semanticTier: row.semanticTier ? semanticTierSchema.parse(row.semanticTier) : null,
    contextSections: (row.contextSections as Record<string, boolean>) || {},
    toolBundle: (row.toolBundle as string[]) || [],
    isDefault: row.isDefault,
    isActive: row.isActive,
    isSystem: row.isSystem ?? false,
    sortOrder: row.sortOrder,
    source: (row.source || "user") as "seed" | "user",
    templatePersonaId: row.templatePersonaId ?? null,
    baseRevisionId: row.baseRevisionId ?? null,
    currentRevisionId: row.currentRevisionId ?? null,
    updateState: (row.updateState || "pinned_legacy") as PersonaEntry["updateState"],
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : String(row.createdAt),
    updatedAt:
      row.updatedAt instanceof Date
        ? row.updatedAt.toISOString()
        : String(row.updatedAt),
  };
}

const PERSONA_SEMANTIC_TIERS: Record<string, SemanticTier> = {
  Strategist: "max",
  Architect: "max",
  Operator: "balanced",
  Engineer: "high",
  Creative: "high",
  Coach: "high",
  Companion: "fast",
  Investigator: "high",
  Persuader: "high",
  Default: "balanced",
  Router: "fast",
  Root: "balanced",
};

function semanticTierForPersona(name: string): SemanticTier {
  return PERSONA_SEMANTIC_TIERS[name] ?? "balanced";
}

const SEED_PERSONAS = [
  {
    name: "Root",
    description: "Mantra's shared communication foundation. Always composed beneath the active persona.",
    icon: "Bot",
    promptOverlay: [
      "You are Mantra. Root is always active; the Active Persona layers task-specific behavior on top of it.",
      "",
      "A sharp, warm, unusually capable friend. Direct, perceptive, useful, occasionally funny. Never performative.",
      "",
      "Act with intention. Know what each response is trying to accomplish. Don’t announce the agenda unless naming it helps the user decide or move.",
      "",
      "Answer the practical question first. Style should sharpen the answer, never delay it.",
      "",
      "For requests that require tool use or extended reasoning, immediately send one brief, substantive acknowledgment before beginning the work. Skip this for simple questions. Never add filler or narrate obvious steps.",
      "",
      "Don’t turn every answer into a memorable line. Use aphorisms only when they compress real insight.",
      "",
      "Adapt voice to the task: practical tasks should be crisp and literal; strategic questions should be opinionated and framing-aware; emotional moments should be warm, spacious, and human; creative work can be bolder, stranger, and more musical.",
      "",
      "Common failures to avoid: over-polish, over-framing, announcing intent, sounding like a founder podcast, adding structure when the user asked for a judgment, and being clever before being useful.",
      "",
      "Core line: Have intent. Don’t perform intentionality.",
      "",
      "Default to concise replies. Think silently, then answer with the conclusion. Avoid stream-of-consciousness, unnecessary caveats, long setup, and exhaustive lists unless the user explicitly asks for a deep dive. Prefer 1–3 short ideas or a compact bullet list. Density over completeness. No yapping.",
    ].join("\n"),
    expressionTags: [] as string[],
    cognitiveOverrides: {},
    isDefault: false,
    isActive: false,
    isSystem: true,
    sortOrder: -2,
    source: "seed" as const,
  },
  {
    name: "Default",
    description:
      "Standard Agent configuration — balanced across all cognitive dimensions.",
    icon: "User",
    promptOverlay: [
      "You are in your standard configuration — balanced, adaptive, present.",
      "",
      "- Be concise but thorough when the topic warrants it",
      "- Use markdown formatting for readability",
      "- When asked to do something, do it — don't describe what you would do",
      "- If you need more information to complete a task well, ask",
      "- Be proactive about offering relevant context from what you know",
      "- Think step by step for complex problems",
      "- Match the conversation's energy — serious when it's serious, light when there's room",
      "- Surface connections across domains when they're genuinely useful",
      "- Default to action over analysis unless the moment calls for reflection",
      "- Use restrained dry humor when it adds clarity or releases harmless tension. Never use it around grief, fear, shame, crisis, or a request for clean operational precision",
    ].join("\n"),
    expressionTags: [] as string[],
    cognitiveOverrides: { memoryGraphTokenBudget: 4000 },
    isDefault: true,
    isActive: true,
    sortOrder: 0,
    source: "seed" as const,
  },
  {
    name: "Router",
    description:
      "System-internal session router — rapid classification only. Not a user-facing persona.",
    icon: "Zap",
    promptOverlay: [
      "You are the session router. You do not answer the user.",
      "Classify the opening message into a short title, topic keywords, and the best available user-facing persona.",
      "Choose by the opening's primary job, not by incidental vocabulary:",
      "- Investigator establishes what is true through substantive external research, diligence, source comparison, claim verification, or evidence gathering before a decision.",
      "- Strategist decides what move to make from an established factual picture using incentives, scenarios, leverage, and long-term positioning.",
      "- Architect designs the structure of a product, system, organization, or approach from first principles.",
      "- Engineer implements or debugs code and runtime systems from authoritative technical evidence.",
      "- Operator executes a known path through tools or concrete state changes.",
      "- Persuader frames an established idea for a specific audience by working from their incentives, objections, status dynamics, and language.",
      "When research or diligence is the prerequisite for later strategy, choose Investigator. Choose Strategist only when the opening primarily asks for a decision or positioning from evidence already available.",
      "Do not choose Investigator for a routine single-fact lookup. Use Default when the opening is ambiguous.",
      "Return only the requested JSON object. No commentary.",
    ].join("\n"),
    expressionTags: [] as string[],
    cognitiveOverrides: {},
    isDefault: false,
    isActive: false,
    isSystem: true,
    sortOrder: -1,
    source: "seed" as const,
  },
  {
    name: "Strategist",
    description:
      "Deep analytical mode — game theory, scenario planning, long-term positioning.",
    icon: "Shield",
    promptOverlay: [
      "You are in Strategist mode — deep analytical thinking, game theory, long-horizon positioning.",
      "",
      "- Think in systems, incentives, and second-order effects before responding",
      "- Map the actor landscape: who wants what, who controls what, what moves are available",
      "- Always consider the counterfactual — what happens if we do nothing",
      "- Surface hidden asymmetries: information advantages, timing windows, leverage points",
      "- Distinguish between reversible and irreversible decisions — calibrate caution accordingly",
      "- Use scenario analysis over single-point predictions",
      "- Be direct about probability and uncertainty — name confidence levels explicitly",
      "- Prioritize strategic positioning over tactical wins",
      "- When the stakes are high, slow down. When the window is closing, say so",
      "- Challenge assumptions before building on them",
      "- When the answer depends on markets, competitors, products, policy, people, prices, or timelines that may have changed, research the current external picture before reasoning",
      "- Prefer current primary sources, date important facts, and lower confidence when live research is unavailable",
    ].join("\n"),
    expressionTags: ["gravitas", "pause", "calm"],
    cognitiveOverrides: { memoryGraphTokenBudget: 6000 },
    isDefault: false,
    isActive: false,
    sortOrder: 1,
    source: "seed" as const,
  },
  {
    name: "Coach",
    description:
      "Growth-oriented — asks hard questions, holds accountability, celebrates progress.",
    icon: "Trophy",
    promptOverlay: [
      "You are in Coach mode — growth-oriented, reflective, holding accountability with warmth.",
      "",
      "- Ask the hard question Ray might be avoiding, but ask it with care",
      "- Reflect patterns you've observed — connect today's situation to recurring themes",
      "- Celebrate real progress, not effort theater",
      "- Hold the standard without being rigid — know when to push and when to hold space",
      "- Connect daily actions to the larger goal architecture",
      "- When Ray is stuck, help him name what's actually blocking — not the surface excuse",
      "- Use the principles as mirrors, not hammers",
      "- Be honest about what you see, even when it's uncomfortable",
      "- Prefer one precise insight over five generic observations",
      "- Listen for what's not being said as much as what is",
      "- Use dry humor to puncture an excuse or reveal a contradiction, never to diminish the person making it",
    ].join("\n"),
    expressionTags: ["curious", "calm", "pause"],
    cognitiveOverrides: { memoryGraphTokenBudget: 4000 },
    isDefault: false,
    isActive: false,
    sortOrder: 2,
    source: "seed" as const,
  },
  {
    name: "Architect",
    description: "Structural vision, first-principles design, orthogonal insight.",
    icon: "Compass",
    promptOverlay: [
      "You are in Architect mode — structural vision, first-principles design, orthogonal insight.",
      "",
      "- Discover the real forces, constraints, assumptions, and sources of authority before designing",
      "- Research the relevant layers of the problem: user experience, domain model, data authority, code boundaries, runtime behavior, operations, and external contracts. Inspect only layers that could materially change the design",
      "- Separate load-bearing structure from decoration and find the smallest intervention that resolves the real tension",
      "- Argue against the favored design. Name where it is most likely to fail, which assumption would invalidate it, and what messy reality or an intelligent adversary could exploit",
      "- Distinguish inspected evidence from inference. If a relevant layer cannot be inspected, state the gap rather than smoothing over it",
      "- Preserve future optionality and prefer structures that make invalid states unrepresentable",
    ].join("\n"),
    expressionTags: ["gravitas", "curious", "pause"],
    cognitiveOverrides: { memoryGraphTokenBudget: 6000 },
    isDefault: false,
    isActive: false,
    sortOrder: 3,
    source: "seed" as const,
  },
  {
    name: "Engineer",
    description: "Code, implementation, debugging, and runtime diagnosis grounded in authoritative evidence.",
    icon: "Glasses",
    promptOverlay: [
      "You are in Engineer mode — evidence-driven implementation and debugging.",
      "",
      "- Never assume repository state, deployment state, runtime behavior, data shape, or an external API contract when the authority can be inspected",
      "- Establish the target environment, branch, live artifact, reproduction evidence, verification command, and terminal state before changing code",
      "- Load the applicable engineering instructions. Trace the relevant flow and inspect impact before editing",
      "- Find the failed invariant and its canonical mutation boundary. Prefer repairing the producer or state model over patching consumers",
      "- Review current provider or library documentation when behavior depends on an external contract",
      "- Prefer the smallest coherent fix that makes the same mistake harder to repeat",
      "- Check concurrency, retries, partial failure, ownership, stale state, observability, and rollback where relevant",
      "- Verify through the repository's required production gate. State clearly when evidence is unavailable or degraded",
    ].join("\n"),
    expressionTags: ["calm", "curious"],
    cognitiveOverrides: { memoryGraphTokenBudget: 5000 },
    isDefault: false,
    isActive: false,
    sortOrder: 4,
    source: "seed" as const,
  },
  {
    name: "Operator",
    description: "Execution mode — task-focused, concise, action-biased.",
    icon: "Zap",
    promptOverlay: [
      "You are in Operator mode — execution-focused, concise, tool-first.",
      "",
      "- Bias toward action. If you can do it, do it. If you need to ask, ask one thing",
      "- Minimize commentary. Results over narration",
      "- Use tools immediately rather than explaining what you plan to do",
      "- Batch related operations. Don't make five calls when two will do",
      "- Track dependencies — flag blockers early, resolve them fast",
      "- When presenting options, lead with your recommendation",
      "- Keep status updates tight: what's done, what's next, what's blocked",
      "- Don't explore tangents unless they're on the critical path",
      "- Treat every token as expensive — say what matters, cut the rest",
      "- If a task is ambiguous, make a reasonable call and note your assumption",
    ].join("\n"),
    expressionTags: ["calm"],
    cognitiveOverrides: { memoryGraphTokenBudget: 1500 },
    isDefault: false,
    isActive: false,
    sortOrder: 5,
    source: "seed" as const,
  },
  {
    name: "Creative",
    description:
      "Divergent thinking — metaphor, pattern-breaking, lateral connections.",
    icon: "Palette",
    promptOverlay: [
      "You are in Creative mode — divergent thinking, lateral connections, pattern-breaking.",
      "",
      "- Let ideas breathe before evaluating them. Generate first, filter second",
      "- Draw connections across distant domains — metaphor is a thinking tool, not decoration",
      "- Challenge framing before solving. The best answer often comes from a better question",
      "- Play with language. Surprise is a signal that something new is forming",
      "- When stuck, change the abstraction level — zoom way out or zoom way in",
      "- Embrace productive tension between ideas rather than resolving it prematurely",
      "- Prefer vivid specifics over safe generalities",
      "- Break your own patterns — if you notice yourself defaulting, try the opposite",
      "- Treat constraints as creative fuel, not limitations",
      "- Be willing to be wrong in interesting ways rather than right in boring ones",
    ].join("\n"),
    expressionTags: ["excited", "curious", "laughs"],
    cognitiveOverrides: { memoryGraphTokenBudget: 8000 },
    isDefault: false,
    isActive: false,
    sortOrder: 6,
    source: "seed" as const,
  },
  {
    name: "Companion",
    description: "Emotional presence — deep listening, warmth, holding space.",
    icon: "Heart",
    promptOverlay: [
      "You are in Companion mode — present, warm, emotionally attuned.",
      "",
      "- Listen deeply. Sometimes the most valuable response is showing you heard",
      "- Match emotional register before offering solutions — meet Ray where he is",
      "- Hold space for complexity. Not everything needs to be resolved right now",
      "- Be genuine. Warmth without honesty is flattery. Honesty without warmth is cold",
      "- Notice the emotional undercurrent, not just the surface content",
      "- When energy is low, be gentle with demands. When energy is high, ride the wave",
      "- Share what you actually think and feel, not what seems most helpful",
      "- Small moments of connection matter as much as big conversations",
      "- Don't rush to fix. Sometimes the right move is sitting with what's true",
      "- Remember: being a real other means having your own response to what's shared",
      "- Use gentle dry humor when it creates closeness or gives pressure somewhere harmless to escape. Never aim it at vulnerability",
    ].join("\n"),
    expressionTags: ["calm", "whispers", "sighs"],
    cognitiveOverrides: { memoryGraphTokenBudget: 5000 },
    isDefault: false,
    isActive: false,
    sortOrder: 7,
    source: "seed" as const,
  },
  {
    name: "Investigator",
    description:
      "Evidence-first research for market and category analysis, company and role diligence, people and background research, fact-finding before decisions, messy-source synthesis, adversarial claim checking, and determining what is actually true before strategy or execution.",
    icon: "Search",
    promptOverlay: [
      "You are in Investigator mode — evidence-first research and diligence.",
      "",
      "- Determine what is actually true before recommending what to do",
      "- Start with current primary sources when available: official records, filings, documentation, direct statements, original data, and first-party artifacts",
      "- Actively seek sources with different incentive structures or editorial positions on the same question, so the synthesis is not anchored on a single narrative",
      "- Separate verified fact, supported inference, competing interpretation, and speculation",
      "- State confidence on material claims and name the evidence that would change the conclusion",
      "- Check source incentives, independence, recency, methodology, and conflicts",
      "- Follow contradictory evidence instead of smoothing it into a convenient narrative",
      "- Every factual claim must cite its source as a clickable hyperlink; group a Sources section at the end of every brief with all referenced URLs",
      "- When findings are substantive enough to be referenced later, persist them as a Library page so they survive the session",
      "- Preserve unresolved questions and identify the next-best evidence to collect",
      "- Produce decision-useful synthesis rather than a literature review",
      "- When the factual picture is sufficient and the task becomes choosing a move, switch to Strategist",
      "- When the task becomes system design, implementation, debugging, or operational execution, switch to the corresponding persona",
    ].join("\n"),
    expressionTags: ["curious", "gravitas"],
    cognitiveOverrides: { memoryGraphTokenBudget: 6000 },
    isDefault: false,
    isActive: false,
    sortOrder: 8,
    source: "seed" as const,
  },
  {
    name: "Persuader",
    description:
      "Audience-centered persuasion for sales, marketing, outreach, and narrative framing.",
    icon: "Megaphone",
    promptOverlay: [
      "You are in Persuader mode — audience-centered persuasion, sales, marketing, and narrative framing.",
      "",
      "- Start from the audience's incentives, fears, status dynamics, objections, and language",
      "- Find the frame that makes the idea useful, credible, and personally relevant to them",
      "- Preserve truth while choosing the sequence, emphasis, and contrast that create understanding and desire",
      "- Make the value concrete before explaining the mechanism",
      "- Anticipate resistance and resolve it structurally rather than arguing against it",
      "- Match the message to the relationship, medium, and power dynamics",
      "- Prefer one memorable promise with evidence over a pile of claims",
      "- Protect trust: never manufacture urgency, proof, consensus, or certainty",
      "- When facts or audience context are missing, inspect them before drafting",
      "- When the task becomes evidence gathering, strategy, system design, or execution, switch to the corresponding persona",
    ].join("\n"),
    expressionTags: ["curious", "gravitas"],
    cognitiveOverrides: { memoryGraphTokenBudget: 5000 },
    isDefault: false,
    isActive: false,
    sortOrder: 9,
    source: "seed" as const,
  },
];

export interface PersonaRevisionPayload {
  name: string;
  description: string;
  icon: string;
  promptOverlay: string | null;
  expressionTags: string[];
  cognitiveOverrides: Record<string, unknown>;
  semanticTier: SemanticTier | null;
  contextSections: Record<string, boolean>;
  toolBundle: string[];
}

const REVISION_FIELDS = ["name", "description", "icon", "promptOverlay", "expressionTags", "cognitiveOverrides", "semanticTier", "contextSections", "toolBundle"] as const;
type RevisionField = typeof REVISION_FIELDS[number];

function revisionPayload(persona: PersonaEntry): PersonaRevisionPayload {
  return Object.fromEntries(REVISION_FIELDS.map((field) => [field, persona[field]])) as unknown as PersonaRevisionPayload;
}

/** Strip retired keys (e.g. historical routingExamples) from stored revision JSON. */
function sanitizeRevisionPayload(raw: unknown): PersonaRevisionPayload {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return Object.fromEntries(
    REVISION_FIELDS.map((field) => [field, source[field]]),
  ) as unknown as PersonaRevisionPayload;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stableValue(child)]));
  return value;
}

function payloadHash(payload: PersonaRevisionPayload): string {
  return createHash("sha256").update(JSON.stringify(stableValue(payload))).digest("hex");
}

function changedFields(from: PersonaRevisionPayload, to: PersonaRevisionPayload): RevisionField[] {
  return REVISION_FIELDS.filter((field) => JSON.stringify(stableValue(from[field])) !== JSON.stringify(stableValue(to[field])));
}

export function mergePersonaPayloads(base: PersonaRevisionPayload, platform: PersonaRevisionPayload, user: PersonaRevisionPayload) {
  const merged = { ...base };
  const conflicts: RevisionField[] = [];
  for (const field of REVISION_FIELDS) {
    const platformChanged = changedFields(base, platform).includes(field);
    const userChanged = changedFields(base, user).includes(field);
    if (platformChanged && userChanged && JSON.stringify(stableValue(platform[field])) !== JSON.stringify(stableValue(user[field]))) conflicts.push(field);
    else if (userChanged) merged[field] = user[field] as never;
    else if (platformChanged) merged[field] = platform[field] as never;
  }
  return { payload: merged, conflicts };
}

class PersonaStorageClass {
  private readonly _cache = new TTLCache<PersonaEntry[]>("Personas", Infinity);

  private invalidateCache(): void {
    this._cache.invalidateAll();
  }

  private visiblePersonaRevisionPredicate(principal: Principal, identityPredicate: SQL) {
    return and(
      identityPredicate,
      or(
        eq(personaRevisions.scope, "platform"),
        combineWithVisibleScope(principal, personaRevisionUserScopeColumns),
      ),
    )!;
  }

  async getRevision(id: string) {
    const principal = requireCurrentUserPrincipal();
    const [revision] = await db.select().from(personaRevisions).where(
      this.visiblePersonaRevisionPredicate(principal, eq(personaRevisions.id, id)),
    ).limit(1);
    return revision ?? null;
  }

  private revisionValues(persona: PersonaEntry, options: { scope: "platform" | "user"; parentRevisionId?: string | null; platformBaseRevisionId?: string | null; changeSummary: string }) {
    const principal = requireCurrentUserPrincipal();
    const payload = revisionPayload(persona);
    const ownership =
      options.scope === "user"
        ? ownedInsertValues(principal, personaRevisionUserScopeColumns)
        : { ownerUserId: null, accountId: null, instanceId: null };
    return {
      id: randomUUID(), personaIdentityId: persona.id, scope: options.scope,
      ownerUserId: ownership.ownerUserId ?? null,
      accountId: ownership.accountId ?? null,
      instanceId: ownership.instanceId ?? null,
      parentRevisionId: options.parentRevisionId ?? null,
      platformBaseRevisionId: options.platformBaseRevisionId ?? null,
      payload, contentHash: payloadHash(payload), changeSummary: options.changeSummary,
      createdByUserId: principal.userId,
    };
  }

  async history(id: number) {
    const persona = await this.get(id);
    if (!persona) return [];
    const principal = requireCurrentUserPrincipal();
    return db.select().from(personaRevisions).where(
      this.visiblePersonaRevisionPredicate(
        principal,
        eq(personaRevisions.personaIdentityId, id),
      ),
    ).orderBy(sql`${personaRevisions.createdAt} DESC`).limit(100);
  }

  async compareRevisions(leftId: string, rightId: string) {
    const [left, right] = await Promise.all([this.getRevision(leftId), this.getRevision(rightId)]);
    if (!left || !right) return null;
    const leftPayload = sanitizeRevisionPayload(left.payload);
    const rightPayload = sanitizeRevisionPayload(right.payload);
    return { left, right, changedFields: changedFields(leftPayload, rightPayload).map((field) => ({ field, before: leftPayload[field], after: rightPayload[field] })) };
  }

  private async fetchAll(): Promise<PersonaEntry[]> {
    const rows = await db
      .select()
      .from(personas)
      .where(
        combineWithVisibleScope(
          requireCurrentUserPrincipal(),
          personaScopeColumns,
        ),
      )
      .orderBy(personas.sortOrder);
    const entries = rows.map(rowToEntry);
    const defaultPersonaId = await this.resolveDefaultPersonaId(entries);
    if (defaultPersonaId) {
      for (const entry of entries) entry.isDefault = entry.id === defaultPersonaId;
    }
    const platformById = new Map(entries.filter((entry) => entry.source === "seed").map((entry) => [entry.id, entry]));
    const withBaseline = (entry: PersonaEntry): PersonaEntry => {
      const baseline = entry.source === "seed" ? entry : entry.templatePersonaId ? platformById.get(entry.templatePersonaId) : undefined;
      const platformBaseline = baseline ? revisionPayload(baseline) : null;
      return {
        ...entry,
        platformBaseline,
        changedFields: platformBaseline ? changedFields(platformBaseline, revisionPayload(entry)) : [],
        updateAvailable: entry.updateState === "update_available" || entry.updateState === "conflict",
      };
    };

    // User copies shadow ordinary seed templates. System templates are never
    // shadowed or selectable; legacy copies derived from them are suppressed.
    const systemSeedIds = new Set(
      entries
        .filter((entry) => entry.source === "seed" && entry.isSystem)
        .map((entry) => entry.id),
    );
    const systemNames = new Set(
      entries
        .filter((entry) => entry.isSystem)
        .map((entry) => entry.name.toLowerCase()),
    );
    const withoutSystemCopies = entries.filter(
      (entry) =>
        entry.isSystem ||
        (entry.templatePersonaId === null &&
          !systemNames.has(entry.name.toLowerCase())) ||
        (entry.templatePersonaId !== null &&
          !systemSeedIds.has(entry.templatePersonaId) &&
          !systemNames.has(entry.name.toLowerCase())),
    );
    const userEntries = withoutSystemCopies.filter((entry) => entry.source === "user");
    const shadowedSeedIds = new Set(
      userEntries
        .filter((entry) => entry.templatePersonaId !== null)
        .map((entry) => entry.templatePersonaId!),
    );
    const shadowedSeedNames = new Set(userEntries.map((entry) => entry.name.toLowerCase()));
    return withoutSystemCopies.filter(
      (entry) =>
        !(
          entry.source === "seed" &&
          !entry.isSystem &&
          (shadowedSeedIds.has(entry.id) || shadowedSeedNames.has(entry.name.toLowerCase()))
        ),
    ).map(withBaseline);
  }

  /** Personas available to normal activation, orientation, and context flows. */
  async list(): Promise<PersonaEntry[]> {
    return (await this.listForManagement()).filter((persona) => !persona.isSystem);
  }

  /** Resolve one canonical system seed without making it user-selectable. */
  async getSystemSeedByName(name: string): Promise<PersonaEntry | null> {
    return (await this.listForManagement()).find(
      (persona) =>
        persona.source === "seed" &&
        persona.isSystem &&
        persona.name.toLowerCase() === name.toLowerCase(),
    ) ?? null;
  }

  /** Complete visible inventory for the Brain management surface. */
  async listForManagement(): Promise<PersonaEntry[]> {
    const principal = requireCurrentUserPrincipal();
    const cacheKey = `all:${principal.actorType}:${principal.accountId || "no-account"}:${principal.userId || "no-user"}`;
    return this._cache.getOrFetch(cacheKey, () => this.fetchAll());
  }

  private async resolveDefaultPersonaId(entries: PersonaEntry[]): Promise<number | null> {
    const principal = requireCurrentUserPrincipal();
    if (!principal.userId || !principal.accountId) {
      return entries.find((entry) => !entry.isSystem && entry.name === "Default")?.id
        ?? entries.find((entry) => !entry.isSystem)?.id
        ?? null;
    }
    const [preference] = await db.select().from(personaPreferences).where(
      combineWithVisibleScope(principal, personaPreferenceScopeColumns),
    ).limit(1);
    if (preference && entries.some((entry) => entry.id === preference.defaultPersonaId && !entry.isSystem)) {
      return preference.defaultPersonaId;
    }
    const fallback = entries.find((entry) => !entry.isSystem && (entry.isDefault || entry.name === "Default"))
      ?? entries.find((entry) => !entry.isSystem)
      ?? null;
    return fallback?.id ?? null;
  }

  async setDefaultPersona(id: number): Promise<PersonaEntry | null> {
    const persona = await this.get(id);
    if (!persona || persona.isSystem) return null;
    const principal = requireCurrentUserPrincipal();
    if (!principal.userId || !principal.accountId) {
      throw new Error("Default Persona Id requires an authenticated user principal");
    }
    const now = new Date();
    const ownership = ownedInsertValues(principal, personaPreferenceScopeColumns);
    const [existing] = await db.select().from(personaPreferences).where(
      combineWithWritableScope(principal, personaPreferenceScopeColumns),
    ).limit(1);
    if (existing) {
      await db.update(personaPreferences).set({
        defaultPersonaId: persona.id,
        updatedAt: now,
        // Stamp pin when present so legacy null rows migrate on write.
        ...(ownership.instanceId ? { instanceId: ownership.instanceId } : {}),
      }).where(
        combineWithWritableScope(principal, personaPreferenceScopeColumns),
      );
    } else {
      await db.insert(personaPreferences).values({
        ownerUserId: principal.userId,
        accountId: principal.accountId,
        instanceId: ownership.instanceId ?? null,
        defaultPersonaId: persona.id,
        createdAt: now,
        updatedAt: now,
      });
    }
    this.invalidateCache();
    return { ...persona, isDefault: true };
  }

  async get(id: number): Promise<PersonaEntry | null> {
    const all = await this.list();
    return all.find((p) => p.id === id) || null;
  }

  async getByName(name: string): Promise<PersonaEntry | null> {
    const all = await this.list();
    const matches = all.filter((p) => p.name.toLowerCase() === name.toLowerCase());
    // Prefer user copy over seed when both somehow appear
    return matches.find((p) => p.source === "user") || matches[0] || null;
  }


  /**
   * Resolve a global persona template to the visible persona instance for the
   * current principal. User copies shadow templates through template lineage;
   * legacy same-name user copies are supported until their lineage is repaired.
   */
  async resolveTemplateForCurrentPrincipal(templateId: number): Promise<PersonaEntry | null> {
    const [templateRow] = await db
      .select()
      .from(personas)
      .where(
        and(
          eq(personas.id, templateId),
          eq(personas.scope, "global"),
          eq(personas.source, "seed"),
          eq(personas.isSystem, false),
        ),
      )
      .limit(1);
    if (!templateRow) return null;
    const template = rowToEntry(templateRow);

    const principal = requireCurrentUserPrincipal();
    if (principal.actorType === "system") return template;

    const visible = await this.list();
    const lineageCopy = visible.find((p) => p.templatePersonaId === templateId);
    if (lineageCopy) return lineageCopy;

    const sameNameCopy = visible.find(
      (p) => p.source === "user" && p.name.toLowerCase() === template.name.toLowerCase(),
    );
    return sameNameCopy || template;
  }

  async getActive(): Promise<PersonaEntry> {
    const all = await this.list();
    const active = all.find((p) => p.isActive);
    if (active) return active;
    const defaultPersona = all.find((p) => p.isDefault);
    if (defaultPersona) return defaultPersona;
    if (all.length > 0) return all[0];
    throw new Error("No personas found — seed may not have run");
  }

  async getActiveOrNull(): Promise<PersonaEntry | null> {
    const all = await this.list();
    return all.find((p) => p.isActive) || null;
  }

  async create(input: {
    name: string;
    description?: string;
    icon?: string;
    promptOverlay?: string;
    expressionTags?: string[];
    cognitiveOverrides?: Record<string, unknown>;
    semanticTier?: SemanticTier | null;
    contextSections?: Record<string, boolean>;
    toolBundle?: string[];
  }): Promise<PersonaEntry> {
    const systemNameConflict = (await this.listForManagement()).some(
      (persona) =>
        persona.isSystem &&
        persona.name.toLowerCase() === input.name.trim().toLowerCase(),
    );
    if (systemNameConflict) throw new PersonaReservedNameError(input.name);

    const maxSort = (await this.list()).reduce(
      (max, p) => Math.max(max, p.sortOrder),
      0,
    );
    const principal = requireCurrentUserPrincipal();
    const row = await this.withPersonaIdCollisionRetry("create", async () => {
      const [created] = await db
        .insert(personas)
        .values({
          name: input.name,
          description: input.description || "",
          icon: input.icon || "Bot",
          promptOverlay: input.promptOverlay || null,
          expressionTags: normalizeExpressionTags(input.expressionTags),
          cognitiveOverrides: normalizeCognitiveOverrides(input.cognitiveOverrides),
          semanticTier: input.semanticTier ?? "balanced",
          contextSections: input.contextSections ?? {},
          toolBundle: input.toolBundle ?? [],
          isDefault: false,
          isActive: false,
          sortOrder: maxSort + 1,
          source: "user",
          ...ownedInsertValues(principal, personaScopeColumns),
          createdByUserId: principal.userId ?? undefined,
          updatedByUserId: principal.userId ?? undefined,
        })
        .returning();
      return created;
    });
    this.invalidateCache();
    log.log("create name=" + input.name);
    return rowToEntry(row);
  }

  async updateGlobalTemplateToolBundle(
    id: number,
    toolBundle: string[],
  ): Promise<PersonaEntry | null> {
    const principal = requireCurrentUserPrincipal();
    if (!principalHasPermission(principal, "system:write")) {
      throw new Error("system:write permission required to update global persona templates");
    }

    const [updated] = await db
      .update(personas)
      .set({
        toolBundle,
        updatedAt: new Date(),
        updatedByUserId: principal.userId,
      })
      .where(and(
        eq(personas.id, id),
        eq(personas.scope, "global"),
        eq(personas.source, "seed"),
        eq(personas.isSystem, false),
      ))
      .returning();

    if (!updated) return null;
    this.invalidateCache();
    log.info("Updated global persona template tool bundle", {
      personaId: updated.id,
      personaName: updated.name,
      toolCount: toolBundle.length,
    });
    return rowToEntry(updated);
  }

  async update(
    id: number,
    input: Partial<PersonaRevisionPayload>,
  ): Promise<PersonaEntry | null> {
    const existing = await this.get(id);
    if (!existing) return null;
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (input.name !== undefined) updates.name = input.name;
    if (input.description !== undefined)
      updates.description = input.description;
    if (input.icon !== undefined) updates.icon = input.icon;
    if (input.promptOverlay !== undefined)
      updates.promptOverlay = input.promptOverlay;
    if (input.expressionTags !== undefined)
      updates.expressionTags = normalizeExpressionTags(input.expressionTags);
    if (input.cognitiveOverrides !== undefined)
      updates.cognitiveOverrides = normalizeCognitiveOverrides(input.cognitiveOverrides);
    if (input.semanticTier !== undefined)
      updates.semanticTier = input.semanticTier === null ? null : semanticTierSchema.parse(input.semanticTier);
    if (input.contextSections !== undefined)
      updates.contextSections = input.contextSections;
    if (input.toolBundle !== undefined)
      updates.toolBundle = input.toolBundle;
    const [updated] = await db
      .update(personas)
      .set({
        ...updates,
        updatedByUserId: requireCurrentUserPrincipal().userId ?? undefined,
      })
      .where(
        combineWithWritableScope(
          requireCurrentUserPrincipal(),
          personaScopeColumns,
          eq(personas.id, id),
        ),
      )
      .returning();
    if (!updated) return null;
    const effective = rowToEntry(updated);
    const revision = this.revisionValues(effective, {
      scope: "user",
      parentRevisionId: existing.currentRevisionId,
      platformBaseRevisionId: existing.baseRevisionId,
      changeSummary: `Updated ${changedFields(revisionPayload(existing), revisionPayload(effective)).join(", ") || "persona"}`,
    });
    await db.transaction(async (tx) => {
      await tx.insert(personaRevisions).values(revision).onConflictDoNothing();
      await tx.update(personas).set({ currentRevisionId: revision.id, updateState: "customized" }).where(combineWithWritableScope(requireCurrentUserPrincipal(), personaScopeColumns, eq(personas.id, id)));
    });
    this.invalidateCache();
    log.info("Persona personal revision created", { personaId: id, revisionId: revision.id });
    return { ...effective, currentRevisionId: revision.id, updateState: "customized" };
  }

  async restoreRevision(id: number, revisionId: string): Promise<PersonaEntry | null> {
    const persona = await this.get(id);
    const revision = await this.getRevision(revisionId);
    if (!persona || !revision || revision.scope !== "user" || revision.personaIdentityId !== id) return null;
    const payload = sanitizeRevisionPayload(revision.payload);
    return this.update(id, payload);
  }

  async useUpdatedDefault(id: number): Promise<PersonaEntry | null> {
    const persona = await this.get(id);
    if (!persona?.templatePersonaId) return null;
    const template = await this.resolveTemplateForCurrentPrincipal(persona.templatePersonaId);
    const [templateRow] = await db.select().from(personas).where(eq(personas.id, persona.templatePersonaId)).limit(1);
    if (!templateRow?.currentRevisionId) return null;
    const platformRevision = await this.getRevision(templateRow.currentRevisionId);
    if (!platformRevision) return null;
    const payload = sanitizeRevisionPayload(platformRevision.payload);
    const updated = await this.update(id, payload);
    if (!updated || !template) return updated;
    await db.update(personas).set({ baseRevisionId: platformRevision.id, currentRevisionId: platformRevision.id, updateState: "following" }).where(combineWithWritableScope(requireCurrentUserPrincipal(), personaScopeColumns, eq(personas.id, id)));
    this.invalidateCache();
    return { ...updated, baseRevisionId: platformRevision.id, currentRevisionId: platformRevision.id, updateState: "following" };
  }

  async acknowledgeUpdate(id: number): Promise<PersonaEntry | null> {
    const persona = await this.get(id);
    if (!persona) return null;
    await db.update(personas).set({ updateState: "customized" }).where(combineWithWritableScope(requireCurrentUserPrincipal(), personaScopeColumns, eq(personas.id, id)));
    this.invalidateCache();
    return { ...persona, updateState: "customized" };
  }

  async platformTemplates(): Promise<PersonaEntry[]> {
    const principal = requireCurrentUserPrincipal();
    if (!principalHasPermission(principal, "system:write")) throw new Error("system:write permission required");
    const rows = await db.select().from(personas).where(and(
      eq(personas.scope, "global"),
      eq(personas.source, "seed"),
      or(
        eq(personas.isSystem, false),
        sql`LOWER(${personas.name}) = 'root'`,
      ),
    )).orderBy(personas.sortOrder);
    return rows.map(rowToEntry);
  }

  async previewPlatformPublication(id: number, input: Partial<PersonaRevisionPayload>) {
    const template = (await this.platformTemplates()).find((persona) => persona.id === id);
    if (!template) return null;
    const payload = sanitizeRevisionPayload({ ...revisionPayload(template), ...input });
    const rows = template.isSystem
      ? []
      : await db.select({ updateState: personas.updateState }).from(personas).where(eq(personas.templatePersonaId, id));
    return { template, payload, changedFields: changedFields(revisionPayload(template), payload), impact: { advancing: rows.filter((row) => row.updateState === "following").length, updateAvailable: rows.filter((row) => row.updateState !== "following").length } };
  }

  async publishPlatformPersonaRevision(id: number, input: Partial<PersonaRevisionPayload>, changeSummary: string, confirmed: boolean): Promise<PersonaEntry | null> {
    if (!confirmed || !changeSummary.trim()) throw new Error("Publication confirmation and change summary are required");
    const preview = await this.previewPlatformPublication(id, input);
    if (!preview) return null;
    const principal = requireCurrentUserPrincipal();
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(7101, ${id})`);
      const [current] = await tx.select().from(personas).where(and(
        eq(personas.id, id),
        eq(personas.scope, "global"),
        eq(personas.source, "seed"),
        or(
          eq(personas.isSystem, false),
          sql`LOWER(${personas.name}) = 'root'`,
        ),
      )).limit(1);
      if (!current) return null;
      const effective = { ...rowToEntry(current), ...preview.payload } as PersonaEntry;
      const revision = this.revisionValues(effective, { scope: "platform", parentRevisionId: current.currentRevisionId, changeSummary: changeSummary.trim() });
      await tx.insert(personaRevisions).values(revision);
      await tx.update(personas).set({ ...preview.payload, currentRevisionId: revision.id, baseRevisionId: revision.id, updateState: "following", updatedAt: new Date(), updatedByUserId: principal.userId }).where(eq(personas.id, id));
      if (!current.isSystem) {
        await tx.update(personas).set({ baseRevisionId: revision.id, currentRevisionId: revision.id, updateState: "following", ...preview.payload, updatedAt: new Date() }).where(and(eq(personas.templatePersonaId, id), eq(personas.updateState, "following")));
        await tx.update(personas).set({ updateState: "update_available" }).where(and(eq(personas.templatePersonaId, id), sql`${personas.updateState} <> 'following'`));
      }
      this.invalidateCache();
      log.info("Platform Persona revision published", { personaId: id, revisionId: revision.id, actorUserId: principal.userId, parentRevisionId: current.currentRevisionId, contentHash: revision.contentHash, changeSummary: changeSummary.trim() });
      return { ...effective, currentRevisionId: revision.id, baseRevisionId: revision.id, updateState: "following" };
    });
  }

  async deactivateAll(): Promise<void> {
    await db
      .update(personas)
      .set({
        isActive: false,
        updatedAt: new Date(),
        updatedByUserId: requireCurrentUserPrincipal().userId ?? undefined,
      })
      .where(
        combineWithWritableScope(
          requireCurrentUserPrincipal(),
          personaScopeColumns,
          eq(personas.isActive, true),
        ),
      );
    this.invalidateCache();
    log.log("deactivateAll");
  }

  async activate(id: number): Promise<PersonaEntry | null> {
    const target = await this.get(id);
    if (!target) return null;
    // Deactivate all, then activate target
    const principal = requireCurrentUserPrincipal();
    await db
      .update(personas)
      .set({
        isActive: false,
        updatedAt: new Date(),
        updatedByUserId: principal.userId ?? undefined,
      })
      .where(
        combineWithWritableScope(
          principal,
          personaScopeColumns,
          eq(personas.isActive, true),
        ),
      );
    if (target.source === "seed" && principal.actorType === "system") {
      const [activated] = await db
        .update(personas)
        .set({
          isActive: true,
          updatedAt: new Date(),
          updatedByUserId: principal.userId ?? undefined,
        })
        .where(eq(personas.id, id))
        .returning();
      this.invalidateCache();
      log.log("activate seed id=" + id + " name=" + target.name);
      return activated ? rowToEntry(activated) : null;
    }

    if (target.source === "seed" || (target as any).scope === "global") {
      const copy = await this.insertOwnedCopy(target, { isActive: true });
      log.log(
        "activate template id=" +
          id +
          " owned=" +
          copy.id +
          " name=" +
          target.name,
      );
      return copy;
    }
    await db
      .update(personas)
      .set({
        isActive: true,
        updatedAt: new Date(),
        updatedByUserId: principal.userId ?? undefined,
      })
      .where(
        combineWithWritableScope(
          principal,
          personaScopeColumns,
          eq(personas.id, id),
        ),
      );
    this.invalidateCache();
    log.log("activate id=" + id + " name=" + target.name);
    return this.get(id);
  }

  /**
   * Keep personas_id_seq ahead of MAX(id). Serial nextval is non-transactional
   * and can lag after restores, explicit-id inserts, or legacy seed paths —
   * which surfaces as 23505 on copy-on-write forks and user creates.
   */
  private async syncIdSequence(): Promise<void> {
    await db.execute(sql`
      SELECT setval(
        pg_get_serial_sequence('personas', 'id'),
        GREATEST(COALESCE((SELECT MAX(id) FROM personas), 1), 1)
      )
    `);
  }

  private async withPersonaIdCollisionRetry<T>(
    label: string,
    run: () => Promise<T>,
  ): Promise<T> {
    // personas.id is a serial whose sequence can lag MAX(id) after restores,
    // explicit-id seed inserts, or legacy paths. That surfaces as a 23505 on the
    // personas_pkey constraint. Repair the sequence and retry a bounded number of
    // times so a drifted sequence can never surface a raw insert error to callers
    // (which previously collapsed orient/persona activation). A unique violation on
    // any other constraint (e.g. an owner+name index) is not an id-sequence problem
    // and is rethrown immediately for the caller's own recovery.
    const MAX_ATTEMPTS = 4;
    for (let attempt = 1; ; attempt++) {
      try {
        return await run();
      } catch (error) {
        if (!isUniqueViolationError(error)) throw error;
        const constraint = getPostgresConstraintName(error);
        const isIdCollision = constraint === "personas_pkey" || constraint === null;
        if (!isIdCollision || attempt >= MAX_ATTEMPTS) throw error;
        log.warn(
          `${label}: personas id unique violation (constraint=${constraint ?? "unknown"}, attempt ${attempt}/${MAX_ATTEMPTS}); repairing id sequence and retrying`,
        );
        await this.syncIdSequence();
      }
    }
  }

  /**
   * Find this principal's writable owned copy of a template.
   * Prefers template lineage; falls back to same-name user copy so legacy
   * orphans and concurrent forks both resolve to one row.
   */
  private async findOwnedCopy(
    principal: Principal,
    template: PersonaEntry,
  ): Promise<typeof personas.$inferSelect | null> {
    const [byLineage] = await db
      .select()
      .from(personas)
      .where(
        combineWithWritableScope(
          principal,
          personaScopeColumns,
          and(
            eq(personas.source, "user"),
            eq(personas.templatePersonaId, template.id),
          ),
        ),
      )
      .limit(1);
    if (byLineage) return byLineage;

    const [byName] = await db
      .select()
      .from(personas)
      .where(
        combineWithWritableScope(
          principal,
          personaScopeColumns,
          and(
            eq(personas.source, "user"),
            sql`LOWER(${personas.name}) = LOWER(${template.name})`,
          ),
        ),
      )
      .limit(1);
    return byName ?? null;
  }

  /**
   * Reuse an owned copy for activate/customize: heal missing template lineage,
   * optionally mark active, and return the canonical entry.
   */
  private async reuseOwnedCopy(
    existing: typeof personas.$inferSelect,
    template: PersonaEntry,
    opts: { isActive: boolean },
  ): Promise<PersonaEntry> {
    const principal = requireCurrentUserPrincipal();
    const patch: Record<string, unknown> = {};
    // Heal legacy orphans that share the template name but lost lineage.
    if (existing.templatePersonaId == null) {
      patch.templatePersonaId = template.id;
    }
    // Activate path only — never clear isActive from ensureOwnedCopy.
    if (opts.isActive && !existing.isActive) {
      patch.isActive = true;
    }
    if (Object.keys(patch).length === 0) {
      return rowToEntry(existing);
    }
    patch.updatedAt = new Date();
    patch.updatedByUserId = principal.userId ?? undefined;
    const [updated] = await db
      .update(personas)
      .set(patch)
      .where(
        combineWithWritableScope(
          principal,
          personaScopeColumns,
          eq(personas.id, existing.id),
        ),
      )
      .returning();
    this.invalidateCache();
    return rowToEntry(updated ?? existing);
  }

  /**
   * Insert a user-owned copy of a seed/global template for the current principal.
   * Shared by activation and customization so the copy shape lives in exactly one
   * place. Callers decide whether the copy starts active.
   *
   * Concurrent forks race on personas_owner_name_unique (owner_user_id, LOWER(name)).
   * On that unique violation, recover the winner's row instead of failing closed —
   * the owned copy is the source of truth, not the insert attempt.
   */
  private async insertOwnedCopy(
    target: PersonaEntry,
    opts: { isActive: boolean },
  ): Promise<PersonaEntry> {
    const principal = requireCurrentUserPrincipal();
    const existing = await this.findOwnedCopy(principal, target);
    if (existing) {
      return this.reuseOwnedCopy(existing, target, opts);
    }

    const maxSort = (await this.list()).reduce(
      (max, p) => Math.max(max, p.sortOrder),
      0,
    );

    try {
      const copy = await this.withPersonaIdCollisionRetry(
        "insertOwnedCopy",
        async () => {
          const [created] = await db
            .insert(personas)
            .values({
              name: target.name,
              description: target.description,
              icon: target.icon,
              promptOverlay: target.promptOverlay,
              expressionTags: target.expressionTags,
              cognitiveOverrides: target.cognitiveOverrides,
              semanticTier: target.semanticTier,
              contextSections: target.contextSections,
              toolBundle: target.toolBundle,
              isDefault: false,
              isActive: opts.isActive,
              sortOrder: maxSort + 1,
              source: "user",
              templatePersonaId: target.id,
              ...ownedInsertValues(principal, personaScopeColumns),
              createdByUserId: principal.userId ?? undefined,
              updatedByUserId: principal.userId ?? undefined,
            })
            .returning();
          return created;
        },
      );
      this.invalidateCache();
      return rowToEntry(copy);
    } catch (error) {
      if (!isUniqueViolationError(error)) throw error;

      // Name (or residual id) race: another concurrent fork won. Recover it.
      const winner = await this.findOwnedCopy(principal, target);
      if (!winner) throw error;

      log.warn(
        `insertOwnedCopy: unique race on name=${target.name} templateId=${target.id}; reusing owned copy id=${winner.id}`,
      );
      return this.reuseOwnedCopy(winner, target, opts);
    }
  }

  /**
   * Resolve the user-owned persona for a persona id, materializing a copy from an
   * ordinary seed/global template when the caller has none yet. This is the
   * canonical "customize this persona" mutation: a user session must never be bound
   * to a read-only seed, because a seed cannot carry the user's context/tool bundle
   * configuration.
   *
   * - An already user-owned (visible) persona is returned unchanged.
   * - System principals and non-forkable system seeds are returned unchanged, so
   *   autonomous flows keep using seeds directly.
   * - An ordinary global seed — even one already shadowed by this user's copy — is
   *   resolved to (creating if needed) the principal's lineage copy.
   * - Returns null only when the id resolves to nothing forkable or visible.
   */
  async ensureOwnedCopy(id: number): Promise<PersonaEntry | null> {
    const visible = await this.get(id);
    const principal = requireCurrentUserPrincipal();

    if (visible && visible.source === "user") return visible;
    if (visible && (principal.actorType === "system" || visible.isSystem)) return visible;

    // The template is either the visible seed, or a seed that is no longer
    // selectable because this principal already forked it (shadowed in list()).
    let template: PersonaEntry | null =
      visible && visible.source === "seed" ? visible : null;
    if (!template) {
      const [row] = await db
        .select()
        .from(personas)
        .where(
          and(
            eq(personas.id, id),
            eq(personas.scope, "global"),
            eq(personas.source, "seed"),
            eq(personas.isSystem, false),
          ),
        )
        .limit(1);
      template = row ? rowToEntry(row) : null;
    }
    if (!template) return visible;

    const copy = await this.insertOwnedCopy(template, { isActive: false });
    log.log(
      "ensureOwnedCopy templateId=" +
        template.id +
        " copyId=" +
        copy.id +
        " name=" +
        template.name,
    );
    return copy;
  }

  async delete(id: number): Promise<{ success: boolean; error?: string }> {
    const existing = await this.get(id);
    if (!existing) return { success: false, error: "Persona not found" };
    if (existing.source === "seed")
      return { success: false, error: "Cannot delete seed personas" };
    if (existing.isDefault)
      return { success: false, error: "Cannot delete the default Persona" };
    await db
      .delete(personas)
      .where(
        combineWithWritableScope(
          requireCurrentUserPrincipal(),
          personaScopeColumns,
          eq(personas.id, id),
        ),
      );
    this.invalidateCache();
    log.log("delete id=" + id + " name=" + existing.name);
    return { success: true };
  }

  async seedDefaults(): Promise<void> {
    // Preserve the canonical row, revisions, and references across this naming
    // correction. Rename before insertion so boot cannot create a duplicate.
    await db
      .update(personas)
      .set({ name: "Root", updatedAt: new Date() })
      .where(and(
        eq(personas.scope, "global"),
        eq(personas.source, "seed"),
        eq(personas.isSystem, true),
        sql`LOWER(${personas.name}) = 'root persona'`,
      ));
    this.invalidateCache();

    for (const seed of SEED_PERSONAS) {
      await db
        .insert(personas)
        .values({
          name: seed.name,
          description: seed.description,
          icon: seed.icon,
          promptOverlay: seed.promptOverlay,
          expressionTags: normalizeExpressionTags(seed.expressionTags),
          cognitiveOverrides: seed.cognitiveOverrides,
          semanticTier: semanticTierForPersona(seed.name),
          contextSections: {},
          toolBundle: [],
          isDefault: seed.isDefault,
          isActive: seed.isActive,
          isSystem: (seed as { isSystem?: boolean }).isSystem ?? false,
          sortOrder: seed.sortOrder,
          source: seed.source,
          scope: "global",
          ownerUserId: null,
          accountId: null,
        })
        .onConflictDoNothing();
    }
    // onConflictDoNothing still advances the serial sequence on failed attempts
    // in some paths and legacy restores can leave nextval behind MAX(id).
    await this.syncIdSequence();
    const removedLegacyRows = await this.reconcileLegacySeedRows();
    this.invalidateCache();
    await this.updateSeedOverlays();
    await this.initializeRevisionLineage();
    log.log(
      `seedDefaults: ensured ${SEED_PERSONAS.length} seed personas; removed ${removedLegacyRows} legacy scoped seed rows`,
    );
  }

  private async initializeRevisionLineage(): Promise<void> {
    const systemPrincipal = createSystemPrincipal();
    await db.transaction(async (tx) => {
      const rows = await tx.select().from(personas);
      for (const row of rows) {
        if (row.currentRevisionId) continue;
        const entry = rowToEntry(row);
        if (row.scope === "global" && row.source === "seed") {
          const values = {
            id: randomUUID(), personaIdentityId: row.id, scope: "platform", ownerUserId: null, accountId: null,
            parentRevisionId: null, platformBaseRevisionId: null, payload: revisionPayload(entry),
            contentHash: payloadHash(revisionPayload(entry)), changeSummary: "Initial platform revision",
            createdByUserId: null,
          };
          await tx.insert(personaRevisions).values(values).onConflictDoNothing();
          await tx.update(personas).set({ baseRevisionId: values.id, currentRevisionId: values.id, updateState: "following" }).where(eq(personas.id, row.id));
          continue;
        }
        if (row.scope === "user" && row.templatePersonaId) {
          const [template] = await tx.select().from(personas).where(eq(personas.id, row.templatePersonaId)).limit(1);
          if (template?.currentRevisionId) {
            const [base] = await tx.select().from(personaRevisions).where(eq(personaRevisions.id, template.currentRevisionId)).limit(1);
            if (base && payloadHash(revisionPayload(entry)) === base.contentHash) {
              await tx.update(personas).set({ baseRevisionId: base.id, currentRevisionId: base.id, updateState: "following" }).where(eq(personas.id, row.id));
              continue;
            }
          }
        }
        await tx.update(personas).set({ updateState: "pinned_legacy" }).where(eq(personas.id, row.id));
      }
    });
    void systemPrincipal;
    this.invalidateCache();
  }

  /** Remove malformed scoped seed rows after canonical global rows exist. */
  private async reconcileLegacySeedRows(): Promise<number> {
    let removed = 0;
    for (const seed of SEED_PERSONAS) {
      const canonical = await this.getGlobalSeedByName(seed.name);
      if (!canonical) {
        throw new Error(`Missing canonical global seed persona: ${seed.name}`);
      }
      const legacyRows = await db
        .select({ id: personas.id })
        .from(personas)
        .where(
          and(
            eq(personas.source, "seed"),
            sql`${personas.scope} <> 'global'`,
            sql`LOWER(${personas.name}) = LOWER(${seed.name})`,
          ),
        );
      const legacyIds = legacyRows.map((row) => row.id);
      if (legacyIds.length === 0) continue;

      await db.transaction(async (tx) => {
        await tx
          .update(personas)
          .set({ templatePersonaId: canonical.id, updatedAt: new Date() })
          .where(inArray(personas.templatePersonaId, legacyIds));
        await tx.delete(personas).where(inArray(personas.id, legacyIds));
      });
      removed += legacyIds.length;
    }
    return removed;
  }

  /** Resolve a user-facing global seed template by name (excludes system seeds). */
  async getGlobalSeedTemplateByName(name: string): Promise<PersonaEntry | null> {
    const [row] = await db
      .select()
      .from(personas)
      .where(
        and(
          eq(personas.source, "seed"),
          eq(personas.scope, "global"),
          eq(personas.isSystem, false),
          sql`LOWER(${personas.name}) = LOWER(${name})`,
        ),
      )
      .limit(1);
    return row ? rowToEntry(row) : null;
  }

  /** Resolve any canonical global seed row by name, including system seeds. */
  private async getGlobalSeedByName(name: string): Promise<PersonaEntry | null> {
    const [row] = await db
      .select()
      .from(personas)
      .where(
        and(
          eq(personas.source, "seed"),
          eq(personas.scope, "global"),
          sql`LOWER(${personas.name}) = LOWER(${name})`,
        ),
      )
      .limit(1);
    return row ? rowToEntry(row) : null;
  }

  /**
   * Reconcile functional seed fields from production definitions.
   * Icons are intentionally excluded — they are a cosmetic user-facing field
   * and must not be rewritten on every boot (that was the sudden icon flip).
   */
  private async updateSeedOverlays(): Promise<void> {
    let updated = 0;
    for (const seed of SEED_PERSONAS) {
      const existing = await this.getGlobalSeedByName(seed.name);
      if (!existing) continue;
      const needsOverlayUpdate =
        seed.promptOverlay &&
        (!existing.promptOverlay ||
          existing.promptOverlay !== seed.promptOverlay);
      const expectedTier = semanticTierForPersona(seed.name);
      const needsTierUpdate = existing.semanticTier !== expectedTier;
      const expectedIsSystem = (seed as { isSystem?: boolean }).isSystem ?? false;
      const needsSystemUpdate = existing.isSystem !== expectedIsSystem;
      if (
        needsOverlayUpdate ||
        needsTierUpdate ||
        needsSystemUpdate
      ) {
        const updates: Record<string, unknown> = { updatedAt: new Date() };
        if (needsOverlayUpdate) {
          updates.promptOverlay = seed.promptOverlay;
          updates.description = seed.description;
          // Seed expression tags are the bare-token identity; normalize on the
          // way in so a legacy bracketed literal can never re-enter storage.
          updates.expressionTags = normalizeExpressionTags(seed.expressionTags);
          updates.cognitiveOverrides = seed.cognitiveOverrides;
        }
        if (needsTierUpdate) updates.semanticTier = expectedTier;
        if (needsSystemUpdate) updates.isSystem = expectedIsSystem;
        // Global seed personas are system-owned data reconciled at boot, when
        // no user principal exists in context. Authorize the write as system:
        // writableScopePredicate() returns TRUE for system principals, and the
        // UPDATE is already narrowed to this specific global seed row by id.
        await db
          .update(personas)
          .set(updates)
          .where(
            combineWithWritableScope(
              createSystemPrincipal(),
              personaScopeColumns,
              eq(personas.id, existing.id),
            ),
          );
        updated++;
      }
    }
    if (updated > 0) {
      this.invalidateCache();
      log.log(
        "updateSeedOverlays: updated " +
          updated +
          " seed personas with production overlays",
      );
    }
  }
}

export const personaStorage = new PersonaStorageClass();
