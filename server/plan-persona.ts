import { personaStorage } from "./file-storage/persona-storage";

/** Durable Plan step identity stores the canonical name of any selectable persona. */
export type PlanStepPersona = string;

/** Compatibility inference for plans created before persona became explicit step state. */
export function inferPlanStepPersona(title: string, instructions: string): PlanStepPersona {
  const mission = `${title}\n${instructions}`.toLowerCase();
  const architectureOnlySignals = [
    /\bdo not (?:implement|write|change) code\b/, /\bno (?:code|implementation)\b/,
    /\bwritten (?:structural )?specification\b/, /\bdesign-only\b/,
    /\barchitecture (?:analysis|review|proposal)\b/,
  ];
  if (architectureOnlySignals.some((signal) => signal.test(mission))) return "Architect";

  const engineeringSignals = [
    /\bcode(?:base)?\b/, /\bimplement(?:ation)?\b/, /\bdebug(?:ging)?\b/, /\bfix\b/,
    /\bmigrat(?:e|ion)\b/, /\brefactor\b/, /\bbuild\b/, /\bdeploy(?:ment)?\b/,
    /\bpull request\b/, /\bpr\b/, /\brepositor(?:y|ies)\b/, /\bruntime\b/, /\bschema\b/,
    /\bapi\b/, /\broute(?:s)?\b/, /\bserver\b/, /\bclient\b/, /\btypescript\b/,
    /agents\.md/, /coding\.md/, /npm run build/,
  ];
  if (engineeringSignals.some((signal) => signal.test(mission))) return "Engineer";

  const architectureSignals = [
    /\barchitect(?:ure|ural)?\b/, /\bdesign\b/, /\bspec(?:ification)?\b/,
    /\bdomain model\b/, /\bdecompos(?:e|ition)\b/, /\binvariant(?:s)?\b/,
    /\binterface(?:s)?\b/, /\bstructure|structural\b/, /\btrade-?offs?\b/,
    /\binformation architecture\b/,
  ];
  if (architectureSignals.some((signal) => signal.test(mission))) return "Architect";

  throw new Error("Plan steps require an explicit selectable persona");
}

export async function resolveExplicitPlanStepPersona(persona: unknown): Promise<PlanStepPersona> {
  if (typeof persona !== "string" || !persona.trim()) {
    throw new Error("Plan steps require a selectable persona name");
  }
  const visiblePersona = await personaStorage.getByName(persona.trim());
  if (!visiblePersona) {
    throw new Error(`Plan persona "${persona.trim()}" is not selectable for the current user`);
  }
  return visiblePersona.name;
}

export async function resolvePlanStepPersona(
  persona: string | null | undefined,
  title: string,
  instructions: string,
): Promise<{ persona: PlanStepPersona; inferred: boolean }> {
  const inferred = typeof persona !== "string" || !persona.trim();
  const requestedPersona = inferred
    ? inferPlanStepPersona(title, instructions)
    : persona;
  return {
    persona: await resolveExplicitPlanStepPersona(requestedPersona),
    inferred,
  };
}
