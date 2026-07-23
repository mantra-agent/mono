// Single source of truth for Person relationship vocabularies and Agent tag hygiene.
//
// Company affiliation is canonical through `companyId` + Company membership; the
// `company` name is a compatibility projection. Relationships must come from the
// predefined vocabularies below. The `Customer` professional relationship is
// human-only: a person may assign it through the UI/REST routes, but the Agent
// tool may not. Tag hygiene drops tags that merely duplicate a person's company
// or role — but only for Agent-originated writes; the human UI stays permissive.

export const PERSONAL_RELATION_OPTIONS: string[] = [
  "Mother", "Father", "Biological Father", "Step Mother", "Step Father",
  "Brother", "Sister", "Half Brother", "Half Sister", "Step Brother", "Step Sister",
  "Grandmother", "Grandfather", "Step Grandmother", "Step Grandfather",
  "Aunt", "Uncle", "Cousin", "Step Cousin",
  "Son", "Daughter", "Step Son", "Step Daughter",
  "Nephew", "Niece", "Husband", "Wife", "Spouse", "Ex-Spouse", "In-Law", "Other",
];

export const PROFESSIONAL_RELATION_OPTIONS: string[] = [
  "Partner", "Investor", "Advisor", "Colleague", "Employee", "Vendor", "Customer",
];

// Professional relationships that only a human may assign, never the Agent.
export const HUMAN_ONLY_PROFESSIONAL_RELATIONS: string[] = ["Customer"];

export const AGENT_PROFESSIONAL_RELATION_OPTIONS: string[] =
  PROFESSIONAL_RELATION_OPTIONS.filter(r => !HUMAN_ONLY_PROFESSIONAL_RELATIONS.includes(r));

export type RelationActor = "human" | "agent";

export interface RelationValidationResult {
  ok: boolean;
  error?: string;
}

const personalSet = new Set(PERSONAL_RELATION_OPTIONS.map(s => s.toLowerCase()));
const professionalSet = new Set(PROFESSIONAL_RELATION_OPTIONS.map(s => s.toLowerCase()));
const humanOnlySet = new Set(HUMAN_ONLY_PROFESSIONAL_RELATIONS.map(s => s.toLowerCase()));

export function isKnownPersonalRelation(value: string): boolean {
  return personalSet.has(value.trim().toLowerCase());
}

export function isKnownProfessionalRelation(value: string): boolean {
  return professionalSet.has(value.trim().toLowerCase());
}

export function validateRelation(value: string, _actor: RelationActor): RelationValidationResult {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true };
  if (!isKnownPersonalRelation(trimmed)) {
    return {
      ok: false,
      error: `Unknown relationship "${trimmed}". Choose one of the predefined personal relationships: ${PERSONAL_RELATION_OPTIONS.join(", ")}.`,
    };
  }
  return { ok: true };
}

export function validateProfessionalRelations(values: string[], actor: RelationActor): RelationValidationResult {
  for (const raw of values) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (!isKnownProfessionalRelation(trimmed)) {
      return {
        ok: false,
        error: `Unknown professional relationship "${trimmed}". Choose one of the predefined professional relationships: ${PROFESSIONAL_RELATION_OPTIONS.join(", ")}.`,
      };
    }
    if (actor === "agent" && humanOnlySet.has(trimmed.toLowerCase())) {
      return {
        ok: false,
        error: `The "${trimmed}" relationship can only be set by a person, not the Agent.`,
      };
    }
  }
  return { ok: true };
}

export interface TagFilterInput {
  tags: string[];
  companyName?: string | null;
  role?: string | null;
}

export interface IgnoredTag {
  tag: string;
  reason: string;
}

export interface TagFilterResult {
  savedTags: string[];
  ignoredTags: IgnoredTag[];
}

function normalizeTagToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/[&/_,\-]+/g, " ")
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

function tokenize(value: string): string[] {
  const normalized = normalizeTagToken(value);
  return normalized ? normalized.split(" ") : [];
}

// Drops tags that duplicate the linked company or role. Catches normalized
// variants ("Good Trouble" / "good-trouble") and single-word role components
// ("Founder & CEO" blocks both "founder" and "ceo"). Meaningful cross-cutting
// tags ("accessibility", "gaming") survive.
export function filterRedundantTags(input: TagFilterInput): TagFilterResult {
  const savedTags: string[] = [];
  const ignoredTags: IgnoredTag[] = [];
  const companyNorm = input.companyName ? normalizeTagToken(input.companyName) : "";
  const roleNorm = input.role ? normalizeTagToken(input.role) : "";
  const roleTokens = new Set(input.role ? tokenize(input.role) : []);
  const seen = new Set<string>();

  for (const raw of input.tags) {
    if (typeof raw !== "string") continue;
    const tag = raw.trim();
    if (!tag) continue;
    const norm = normalizeTagToken(tag);
    if (!norm) continue;
    if (seen.has(norm)) continue;
    if (companyNorm && norm === companyNorm) {
      ignoredTags.push({ tag, reason: "duplicates company" });
      continue;
    }
    if (roleNorm && norm === roleNorm) {
      ignoredTags.push({ tag, reason: "duplicates role" });
      continue;
    }
    const tagTokens = tokenize(tag);
    if (tagTokens.length === 1 && roleTokens.has(tagTokens[0])) {
      ignoredTags.push({ tag, reason: "duplicates role" });
      continue;
    }
    seen.add(norm);
    savedTags.push(tag);
  }

  return { savedTags, ignoredTags };
}
