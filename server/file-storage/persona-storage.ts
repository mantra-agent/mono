import { db } from "../db";
import { personas } from "@shared/models/cognition";
import { semanticTierSchema, type SemanticTier } from "@shared/model-connectors";
import { eq, and, inArray, sql } from "drizzle-orm";
import { TTLCache } from "../utils/ttl-cache";
import { createLogger } from "../log";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import {
  combineWithVisibleScope,
  combineWithWritableScope,
  ownedInsertValues,
} from "../scoped-storage";

const log = createLogger("PersonaStorage");
const personaScopeColumns = {
  scope: personas.scope,
  ownerUserId: personas.ownerUserId,
  accountId: personas.accountId,
  vaultId: personas.vaultId,
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
  routingExamples: string[];
  isDefault: boolean;
  isActive: boolean;
  isSystem: boolean;
  sortOrder: number;
  source: "seed" | "user";
  templatePersonaId: number | null;
  createdAt: string;
  updatedAt: string;
}

function rowToEntry(row: typeof personas.$inferSelect): PersonaEntry {
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    icon: row.icon || "Bot",
    promptOverlay: row.promptOverlay,
    expressionTags: (row.expressionTags as string[]) || [],
    cognitiveOverrides:
      (row.cognitiveOverrides as Record<string, unknown>) || {},
    semanticTier: row.semanticTier ? semanticTierSchema.parse(row.semanticTier) : null,
    routingExamples: (row.routingExamples as string[]) || [],
    isDefault: row.isDefault,
    isActive: row.isActive,
    isSystem: row.isSystem ?? false,
    sortOrder: row.sortOrder,
    source: (row.source || "user") as "seed" | "user",
    templatePersonaId: row.templatePersonaId ?? null,
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
  Default: "balanced",
  Router: "fast",
};

function semanticTierForPersona(name: string): SemanticTier {
  return PERSONA_SEMANTIC_TIERS[name] ?? "balanced";
}

/** Example session openings that should route to each seed persona during orientation bootstrap. */
const PERSONA_ROUTING_EXAMPLES: Record<string, string[]> = {
  Default: ["Hey, how's it going?", "Quick question about my calendar"],
  Strategist: ["How should I position against this competitor?", "Walk through the game theory of this negotiation"],
  Architect: ["Design the schema for this new system", "There's a structural bug in how sessions orient"],
  Engineer: ["Implement this feature in the codebase", "Debug why the deployed service is failing"],
  Operator: ["Mark that task done and create a follow-up", "Log this interaction with Mike"],
  Creative: ["Brainstorm names for this product", "Write a playful post about today's launch"],
  Coach: ["I keep procrastinating on the demo, hold me accountable", "Help me reflect on this week"],
  Companion: ["Rough day. Just need to talk", "Feeling anxious about tomorrow's call"],
  Router: [],
};

function routingExamplesForPersona(name: string): string[] {
  return PERSONA_ROUTING_EXAMPLES[name] ?? [];
}

const SEED_PERSONAS = [
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
      "Use Default when the opening is ambiguous.",
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
    expressionTags: ["[gravitas]", "[pause]", "[calm]"],
    cognitiveOverrides: {
      semanticWeight: 1.2,
      temporalWeight: 0.8,
      contrastiveWeight: 1.1,
      memoryGraphTokenBudget: 6000,
    },
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
    expressionTags: ["[curious]", "[calm]", "[pause]"],
    cognitiveOverrides: { causalWeight: 1.2, temporalWeight: 1.1, memoryGraphTokenBudget: 4000 },
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
    expressionTags: ["[gravitas]", "[curious]", "[pause]"],
    cognitiveOverrides: { semanticWeight: 1.2, contrastiveWeight: 1.2, memoryGraphTokenBudget: 6000 },
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
    expressionTags: ["[calm]", "[curious]"],
    cognitiveOverrides: { causalWeight: 1.2, semanticWeight: 1.1, memoryGraphTokenBudget: 5000 },
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
    expressionTags: ["[calm]"],
    cognitiveOverrides: {
      causalWeight: 1.3,
      temporalWeight: 1.1,
      semanticWeight: 0.9,
      memoryGraphTokenBudget: 1500,
    },
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
    expressionTags: ["[excited]", "[curious]", "[laughs]"],
    cognitiveOverrides: {
      contrastiveWeight: 1.3,
      semanticWeight: 1.1,
      causalWeight: 0.8,
      memoryGraphTokenBudget: 8000,
    },
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
    expressionTags: ["[calm]", "[whispers]", "[sighs]"],
    cognitiveOverrides: {
      temporalWeight: 1.2,
      semanticWeight: 1.1,
      contrastiveWeight: 0.8,
      memoryGraphTokenBudget: 5000,
    },
    isDefault: false,
    isActive: false,
    sortOrder: 7,
    source: "seed" as const,
  },
];

class PersonaStorageClass {
  private readonly _cache = new TTLCache<PersonaEntry[]>("Personas", Infinity);

  private invalidateCache(): void {
    this._cache.invalidateAll();
  }

  private async fetchAll(): Promise<PersonaEntry[]> {
    const rows = await db
      .select()
      .from(personas)
      .where(
        combineWithVisibleScope(
          getCurrentPrincipalOrSystem(),
          personaScopeColumns,
        ),
      )
      .orderBy(personas.sortOrder);
    const entries = rows.map(rowToEntry);

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
    );
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
    const principal = getCurrentPrincipalOrSystem();
    const cacheKey = `all:${principal.actorType}:${principal.accountId || "no-account"}:${principal.userId || "no-user"}`;
    return this._cache.getOrFetch(cacheKey, () => this.fetchAll());
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

  async getActive(): Promise<PersonaEntry> {
    const all = await this.list();
    const active = all.find((p) => p.isActive);
    if (active) return active;
    // Fallback to default
    const defaultPersona = all.find((p) => p.isDefault);
    if (defaultPersona) return defaultPersona;
    // Fallback to first
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
    const [row] = await db
      .insert(personas)
      .values({
        name: input.name,
        description: input.description || "",
        icon: input.icon || "Bot",
        promptOverlay: input.promptOverlay || null,
        expressionTags: input.expressionTags || [],
        cognitiveOverrides: input.cognitiveOverrides || {},
        semanticTier: input.semanticTier ?? "balanced",
        isDefault: false,
        isActive: false,
        sortOrder: maxSort + 1,
        source: "user",
        ...ownedInsertValues(
          getCurrentPrincipalOrSystem(),
          personaScopeColumns,
        ),
        createdByUserId: getCurrentPrincipalOrSystem().userId ?? undefined,
        updatedByUserId: getCurrentPrincipalOrSystem().userId ?? undefined,
      })
      .returning();
    this.invalidateCache();
    log.log("create name=" + input.name);
    return rowToEntry(row);
  }

  async update(
    id: number,
    input: {
      name?: string;
      description?: string;
      icon?: string;
      promptOverlay?: string;
      expressionTags?: string[];
      cognitiveOverrides?: Record<string, unknown>;
      semanticTier?: SemanticTier | null;
    },
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
      updates.expressionTags = input.expressionTags;
    if (input.cognitiveOverrides !== undefined)
      updates.cognitiveOverrides = input.cognitiveOverrides;
    if (input.semanticTier !== undefined)
      updates.semanticTier = input.semanticTier === null ? null : semanticTierSchema.parse(input.semanticTier);
    const [updated] = await db
      .update(personas)
      .set({
        ...updates,
        updatedByUserId: getCurrentPrincipalOrSystem().userId ?? undefined,
      })
      .where(
        combineWithWritableScope(
          getCurrentPrincipalOrSystem(),
          personaScopeColumns,
          eq(personas.id, id),
        ),
      )
      .returning();
    if (!updated) return null;
    this.invalidateCache();
    log.log("update id=" + id);
    return rowToEntry(updated);
  }

  async deactivateAll(): Promise<void> {
    await db
      .update(personas)
      .set({
        isActive: false,
        updatedAt: new Date(),
        updatedByUserId: getCurrentPrincipalOrSystem().userId ?? undefined,
      })
      .where(
        combineWithWritableScope(
          getCurrentPrincipalOrSystem(),
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
    const principal = getCurrentPrincipalOrSystem();
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
      const [existingCopy] = await db
        .select()
        .from(personas)
        .where(
          combineWithWritableScope(
            principal,
            personaScopeColumns,
            eq(personas.templatePersonaId, target.id),
          ),
        )
        .limit(1);

      if (existingCopy) {
        const [activated] = await db
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
              eq(personas.id, existingCopy.id),
            ),
          )
          .returning();
        this.invalidateCache();
        log.log(
          "activate template id=" +
            id +
            " reused=" +
            existingCopy.id +
            " name=" +
            target.name,
        );
        return activated ? rowToEntry(activated) : null;
      }

      const maxSort = (await this.list()).reduce(
        (max, p) => Math.max(max, p.sortOrder),
        0,
      );
      const [copy] = await db
        .insert(personas)
        .values({
          name: target.name,
          description: target.description,
          icon: target.icon,
          promptOverlay: target.promptOverlay,
          expressionTags: target.expressionTags,
          cognitiveOverrides: target.cognitiveOverrides,
          semanticTier: target.semanticTier,
          isDefault: false,
          isActive: true,
          sortOrder: maxSort + 1,
          source: "user",
          templatePersonaId: target.id,
          ...ownedInsertValues(principal, personaScopeColumns),
          createdByUserId: principal.userId ?? undefined,
          updatedByUserId: principal.userId ?? undefined,
        })
        .returning();
      this.invalidateCache();
      log.log(
        "activate template id=" +
          id +
          " copied=" +
          copy.id +
          " name=" +
          target.name,
      );
      return rowToEntry(copy);
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

  async delete(id: number): Promise<{ success: boolean; error?: string }> {
    const existing = await this.get(id);
    if (!existing) return { success: false, error: "Persona not found" };
    if (existing.source === "seed")
      return { success: false, error: "Cannot delete seed personas" };
    if (existing.isDefault)
      return { success: false, error: "Cannot delete the default persona" };
    await db
      .delete(personas)
      .where(
        combineWithWritableScope(
          getCurrentPrincipalOrSystem(),
          personaScopeColumns,
          eq(personas.id, id),
        ),
      );
    this.invalidateCache();
    log.log("delete id=" + id + " name=" + existing.name);
    return { success: true };
  }

  async seedDefaults(): Promise<void> {
    for (const seed of SEED_PERSONAS) {
      await db
        .insert(personas)
        .values({
          name: seed.name,
          description: seed.description,
          icon: seed.icon,
          promptOverlay: seed.promptOverlay,
          expressionTags: seed.expressionTags,
          cognitiveOverrides: seed.cognitiveOverrides,
          semanticTier: semanticTierForPersona(seed.name),
          routingExamples: routingExamplesForPersona(seed.name),
          isDefault: seed.isDefault,
          isActive: seed.isActive,
          isSystem: (seed as { isSystem?: boolean }).isSystem ?? false,
          sortOrder: seed.sortOrder,
          source: seed.source,
          scope: "global",
          ownerUserId: null,
          accountId: null,
          vaultId: null,
        })
        .onConflictDoNothing();
    }
    const removedLegacyRows = await this.reconcileLegacySeedRows();
    this.invalidateCache();
    await this.updateSeedOverlays();
    log.log(
      `seedDefaults: ensured ${SEED_PERSONAS.length} seed personas; removed ${removedLegacyRows} legacy scoped seed rows`,
    );
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

  /** Resolve the canonical global seed row without matching user-owned personas that share its name. */
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

  /** Update canonical global seed personas with the production definitions. */
  private async updateSeedOverlays(): Promise<void> {
    let updated = 0;
    for (const seed of SEED_PERSONAS) {
      const existing = await this.getGlobalSeedByName(seed.name);
      if (!existing) continue;
      const needsOverlayUpdate =
        seed.promptOverlay &&
        (!existing.promptOverlay ||
          existing.promptOverlay !== seed.promptOverlay);
      const needsIconUpdate = existing.icon !== seed.icon;
      const expectedTier = semanticTierForPersona(seed.name);
      const needsTierUpdate = existing.semanticTier !== expectedTier;
      const needsRoutingUpdate =
        existing.routingExamples.length === 0 &&
        routingExamplesForPersona(seed.name).length > 0;
      const expectedIsSystem = (seed as { isSystem?: boolean }).isSystem ?? false;
      const needsSystemUpdate = existing.isSystem !== expectedIsSystem;
      if (needsOverlayUpdate || needsIconUpdate || needsTierUpdate || needsRoutingUpdate || needsSystemUpdate) {
        const updates: Record<string, unknown> = { updatedAt: new Date() };
        if (needsOverlayUpdate) {
          updates.promptOverlay = seed.promptOverlay;
          updates.description = seed.description;
          updates.expressionTags = seed.expressionTags;
          updates.cognitiveOverrides = seed.cognitiveOverrides;
        }
        if (needsIconUpdate) {
          updates.icon = seed.icon;
        }
        if (needsTierUpdate) updates.semanticTier = semanticTierForPersona(seed.name);
        if (needsRoutingUpdate) updates.routingExamples = routingExamplesForPersona(seed.name);
        if (needsSystemUpdate) updates.isSystem = expectedIsSystem;
        await db
          .update(personas)
          .set(updates)
          .where(
            combineWithWritableScope(
              getCurrentPrincipalOrSystem(),
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
          " seed personas with production overlays/icons",
      );
    }
  }
}

export const personaStorage = new PersonaStorageClass();
