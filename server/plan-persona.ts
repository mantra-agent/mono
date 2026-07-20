export const PLAN_STEP_PERSONAS = ["Engineer", "Architect", "Default"] as const;

export type PlanStepPersona = typeof PLAN_STEP_PERSONAS[number];

export function isPlanStepPersona(value: unknown): value is PlanStepPersona {
  return typeof value === "string" && PLAN_STEP_PERSONAS.includes(value as PlanStepPersona);
}

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

  return "Default";
}

export function resolvePlanStepPersona(
  persona: string | null | undefined,
  title: string,
  instructions: string,
): { persona: PlanStepPersona; inferred: boolean } {
  return isPlanStepPersona(persona)
    ? { persona, inferred: false }
    : { persona: inferPlanStepPersona(title, instructions), inferred: true };
}
