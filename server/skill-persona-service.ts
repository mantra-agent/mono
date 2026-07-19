import { and, eq } from "drizzle-orm";
import { db } from "./db";
import { createLogger } from "./log";
import { getCurrentPrincipalOrSystem } from "./principal-context";
import { personaStorage } from "./file-storage/persona-storage";
import { skillPersonaPreferences, skills } from "@shared/models/skills";
import { personas } from "@shared/models/cognition";
import type { Skill } from "@shared/models/skills";
import { combineWithVisibleScope } from "./scoped-storage";

const logger = createLogger("SkillPersonaService");

export type SkillPersonaSource =
  | "user_override"
  | "skill_persona_legacy"
  | "skill_recommendation";

export interface SkillPersonaResolution {
  personaId: number;
  personaName: string;
  source: SkillPersonaSource;
}

export interface SkillPersonaConfiguration {
  preferences: Record<string, number>;
  recommendations: Record<string, { templateId: number; name: string }>;
}

const skillScopeColumns = {
  scope: skills.scope,
  ownerUserId: skills.ownerUserId,
  accountId: skills.accountId,
  vaultId: skills.vaultId,
};

export async function listSkillPersonaConfiguration(): Promise<SkillPersonaConfiguration> {
  const principal = getCurrentPrincipalOrSystem();
  const preferenceRows = principal.userId && principal.accountId
    ? await db
        .select({
          skillId: skillPersonaPreferences.skillId,
          personaId: skillPersonaPreferences.personaId,
        })
        .from(skillPersonaPreferences)
        .where(
          and(
            eq(skillPersonaPreferences.ownerUserId, principal.userId),
            eq(skillPersonaPreferences.accountId, principal.accountId),
          ),
        )
    : [];

  const recommendationRows = await db
    .select({
      skillId: skills.id,
      templateId: skills.recommendedPersonaTemplateId,
      name: personas.name,
    })
    .from(skills)
    .innerJoin(personas, eq(skills.recommendedPersonaTemplateId, personas.id))
    .where(combineWithVisibleScope(principal, skillScopeColumns));

  return {
    preferences: Object.fromEntries(
      preferenceRows.map((row) => [row.skillId, row.personaId]),
    ),
    recommendations: Object.fromEntries(
      recommendationRows.flatMap((row) =>
        typeof row.templateId === "number"
          ? [[row.skillId, { templateId: row.templateId, name: row.name }]]
          : [],
      ),
    ),
  };
}

export async function setSkillPersonaPreference(
  skillId: string,
  personaId: number | null,
): Promise<{ skillId: string; personaId: number | null }> {
  const principal = getCurrentPrincipalOrSystem();
  if (!principal.userId || !principal.accountId) {
    throw new Error("A user principal with an account is required to set a skill persona preference");
  }

  // Enforce skill visibility at the canonical mutation boundary. Route and
  // tool callers may already resolve the skill, but no future caller can use
  // this service to create a preference for another user's private skill.
  const [visibleSkill] = await db
    .select({ id: skills.id })
    .from(skills)
    .where(
      combineWithVisibleScope(
        principal,
        skillScopeColumns,
        eq(skills.id, skillId),
      ),
    )
    .limit(1);
  if (!visibleSkill) {
    throw new Error("Skill not found or not visible to the current principal");
  }

  if (personaId === null) {
    await db
      .delete(skillPersonaPreferences)
      .where(
        and(
          eq(skillPersonaPreferences.skillId, skillId),
          eq(skillPersonaPreferences.ownerUserId, principal.userId),
          eq(skillPersonaPreferences.accountId, principal.accountId),
        ),
      );
    return { skillId, personaId: null };
  }

  const persona = await personaStorage.get(personaId);
  if (!persona) {
    throw new Error("Persona not found or not visible to the current principal");
  }

  await db
    .insert(skillPersonaPreferences)
    .values({
      skillId,
      personaId,
      ownerUserId: principal.userId,
      accountId: principal.accountId,
    })
    .onConflictDoUpdate({
      target: [
        skillPersonaPreferences.skillId,
        skillPersonaPreferences.ownerUserId,
        skillPersonaPreferences.accountId,
      ],
      set: {
        personaId,
        accountId: principal.accountId,
        updatedAt: new Date(),
      },
    });
  return { skillId, personaId };
}

/** Resolve the one persona a skill run should use for the current principal. */
export async function resolveSkillRunPersona(
  skill: Pick<Skill, "id" | "scope" | "personaId" | "recommendedPersonaTemplateId">,
): Promise<SkillPersonaResolution | null> {
  const principal = getCurrentPrincipalOrSystem();

  if (principal.userId && principal.accountId) {
    const [preference] = await db
      .select({ personaId: skillPersonaPreferences.personaId })
      .from(skillPersonaPreferences)
      .where(
        and(
          eq(skillPersonaPreferences.skillId, skill.id),
          eq(skillPersonaPreferences.ownerUserId, principal.userId),
          eq(skillPersonaPreferences.accountId, principal.accountId),
        ),
      )
      .limit(1);
    if (preference) {
      const persona = await personaStorage.get(preference.personaId);
      if (persona) {
        return {
          personaId: persona.id,
          personaName: persona.name,
          source: "user_override",
        };
      }
      logger.warn(
        `Ignoring invisible user override persona=${preference.personaId} skill=${skill.id} user=${principal.userId}`,
      );
    }
  }

  // Backward compatibility for user-owned skills configured before preferences.
  if (skill.scope === "user" && typeof skill.personaId === "number") {
    const persona = await personaStorage.get(skill.personaId);
    if (persona) {
      return {
        personaId: persona.id,
        personaName: persona.name,
        source: "skill_persona_legacy",
      };
    }
  }

  if (typeof skill.recommendedPersonaTemplateId === "number") {
    const persona = await personaStorage.resolveTemplateForCurrentPrincipal(
      skill.recommendedPersonaTemplateId,
    );
    if (persona) {
      return {
        personaId: persona.id,
        personaName: persona.name,
        source: "skill_recommendation",
      };
    }
    logger.warn(
      `Ignoring missing recommendation template=${skill.recommendedPersonaTemplateId} skill=${skill.id}`,
    );
  }

  return null;
}
