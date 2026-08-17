/**
 * Work accountability owner — Person is the only owner identity.
 * Not a grant subject, not row visibility (ownerUserId), not login.
 * All live Task / Project / Milestone owner writes cross resolveWorkOwnerPerson.
 */
import { ToolFailureError } from "./tool-failure";
import type { Principal } from "./principal";
import { requireCurrentUserPrincipal } from "./principal-context";
import { peopleStorage } from "./people-storage";
import { createLogger } from "./log";

const log = createLogger("WorkOwner");

export type WorkOwnerResolveMode = "create" | "update";

export interface ResolveWorkOwnerPersonInput {
  ownerPersonId?: string | null;
  mode: WorkOwnerResolveMode;
  /** Optional work vault — when set, prefer Persons who share a membership with it. */
  workVaultId?: string | null;
  principal?: Principal;
}

function parsePersonId(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const ref = trimmed.match(/^@person:([^\s]+)$/i);
  if (ref) return ref[1].trim() || null;
  // Reject retired enum tokens as Person ids.
  if (trimmed === "me" || trimmed === "agent" || trimmed === "xyz") return null;
  return trimmed;
}

/**
 * Cabinet user / agent Persons for the current principal's account.
 * Fail closed when missing — callers must not invent contacts.
 */
export async function getCabinetWorkOwnerPersons(principal?: Principal): Promise<{
  userPersonId: string;
  agentPersonId: string;
  userName: string;
  agentName: string;
}> {
  const p = principal ?? requireCurrentUserPrincipal();
  if (p.actorType !== "user" || !p.userId || !p.accountId) {
    throw new ToolFailureError("Work ownership requires an explicit user principal", {
      kind: "permission",
      code: "work_owner_principal_required",
      retryable: false,
    });
  }
  const people = await peopleStorage.listPeople();
  const user = people.find((entry) => entry.cabinetLevel === "user");
  const agent = people.find((entry) => entry.cabinetLevel === "agent");
  if (!user?.id) {
    throw new ToolFailureError("Cabinet user Person is missing; cannot assign work ownership", {
      kind: "internal",
      code: "work_owner_cabinet_user_missing",
      retryable: false,
    });
  }
  if (!agent?.id) {
    throw new ToolFailureError("Cabinet agent Person is missing; cannot assign work ownership", {
      kind: "internal",
      code: "work_owner_cabinet_agent_missing",
      retryable: false,
    });
  }
  return {
    userPersonId: user.id,
    agentPersonId: agent.id,
    userName: user.name,
    agentName: agent.name,
  };
}

/**
 * Live writer resolver. No enum input.
 * - ownerPersonId present → that visible Person
 * - omitted on create → cabinet user Person
 * - omitted on update → null (no change)
 * - empty / unknown / invisible → fail closed
 */
export async function resolveWorkOwnerPerson(
  input: ResolveWorkOwnerPersonInput,
): Promise<string | null> {
  const principal = input.principal ?? requireCurrentUserPrincipal();
  const raw = input.ownerPersonId;

  if (raw === undefined || raw === null) {
    if (input.mode === "update") return null;
    const cabinet = await getCabinetWorkOwnerPersons(principal);
    return cabinet.userPersonId;
  }

  if (typeof raw !== "string" || !raw.trim()) {
    throw new ToolFailureError("ownerPersonId cannot be empty; work always has a Person owner", {
      kind: "input",
      code: "work_owner_person_required",
      retryable: false,
    });
  }

  const personId = parsePersonId(raw);
  if (!personId) {
    throw new ToolFailureError(
      `Invalid ownerPersonId "${raw}". Pass a Person id or @person:{id}. me/agent are not accepted.`,
      {
        kind: "input",
        code: "work_owner_person_invalid",
        retryable: false,
      },
    );
  }

  const person = await peopleStorage.getPerson(personId);
  if (!person) {
    throw new ToolFailureError(`Person ${personId} not found or not visible`, {
      kind: "input",
      code: "work_owner_person_not_visible",
      retryable: false,
    });
  }

  if (input.workVaultId) {
    try {
      const memberships = await peopleStorage.listVaultMemberships(person.id);
      const vaultIds = memberships.map((m) => m.vaultId);
      if (vaultIds.length > 0 && !vaultIds.includes(input.workVaultId)) {
        log.debug("owner Person has vaults but not the work vault; allowing via People visibility", {
          personId: person.id,
          workVaultId: input.workVaultId,
        });
      }
    } catch {
      // Membership read is advisory; People visibility already passed.
    }
  }

  return person.id;
}

/** Display label for a Person id; never prints me/agent. */
export async function formatWorkOwnerLabel(ownerPersonId: string | null | undefined): Promise<string> {
  if (!ownerPersonId) return "unknown";
  try {
    const person = await peopleStorage.getPerson(ownerPersonId);
    if (person?.name) return person.name;
  } catch {
    // fall through
  }
  return `@person:${ownerPersonId}`;
}

/** Compact bridge/context form: Name (@person:id). */
export async function formatWorkOwnerReference(ownerPersonId: string | null | undefined): Promise<string> {
  if (!ownerPersonId) return "unknown";
  try {
    const person = await peopleStorage.getPerson(ownerPersonId);
    if (person?.name) return `${person.name} (@person:${ownerPersonId})`;
  } catch {
    // fall through
  }
  return `@person:${ownerPersonId}`;
}
