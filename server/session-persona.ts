import { createLogger } from "./log";
import { chatFileStorage } from "./chat-file-storage";
import { personaStorage, type PersonaEntry, type PersonaRevisionPayload } from "./file-storage/persona-storage";
import type { PersonaSnapshot } from "@shared/models/chat";
import { unionRootContextSections, unionRootToolBundle } from "../shared/persona-context";

const log = createLogger("SessionPersona");

/**
 * Following user copies pin the seed's platform revision id (personaIdentityId =
 * template). User-authored revisions pin the copy itself. Both are valid
 * provenance; only foreign identities fail closed.
 */
function revisionBelongsToSelectedPersona(
  persona: PersonaEntry,
  revision: { personaIdentityId: number; scope: string },
): boolean {
  if (revision.personaIdentityId === persona.id) return true;
  return (
    revision.scope === "platform" &&
    persona.templatePersonaId != null &&
    revision.personaIdentityId === persona.templatePersonaId
  );
}

/** Resolve the persona that governs one session. Missing persona stays unset. */
export async function resolveSessionPersona(
  sessionId?: string | null,
  _options: { persistFallback?: boolean } = {},
): Promise<PersonaEntry | null> {
  if (sessionId) {
    const session = await chatFileStorage.getSession(sessionId);
    if (session?.personaId) {
      const persona = await personaStorage.get(session.personaId);
      if (persona && session.selectedPersonaRevisionId) {
        const revision = await personaStorage.getRevision(session.selectedPersonaRevisionId);
        if (!revision || !revisionBelongsToSelectedPersona(persona, revision)) {
          throw new Error(`Session ${sessionId} has invalid selected Persona revision provenance`);
        }
        return { ...persona, ...(revision.payload as PersonaRevisionPayload), currentRevisionId: revision.id };
      }
      if (persona) return persona;
      log.warn(`session=${sessionId} references missing personaId=${session.personaId}; leaving session unbound so orientation can retry`);
    }
    return null;
  }

  return await personaStorage.getActiveOrNull();
}

export async function resolveSessionPersonaComposition(
  sessionId?: string | null,
  options: { persistFallback?: boolean } = {},
): Promise<{
  persona: PersonaEntry | null;
  contextSections: Record<string, boolean>;
  toolBundle: string[] | null;
}> {
  const persona = await resolveSessionPersona(sessionId, options);
  const session = sessionId ? await chatFileStorage.getSession(sessionId) : null;
  const root = await personaStorage.resolveRootPayload(session?.rootRevisionId);
  return {
    persona,
    contextSections: unionRootContextSections(root?.contextSections, persona?.contextSections),
    toolBundle: unionRootToolBundle(root?.toolBundle, persona?.toolBundle),
  };
}

export async function setSessionPersona(
  sessionId: string,
  personaId: number,
): Promise<PersonaEntry | null> {
  const persona = await personaStorage.get(personaId);
  if (!persona) return null;
  await chatFileStorage.updateSessionPersona(sessionId, persona.id);
  return persona;
}

export async function setSessionPersonaIfUnset(
  sessionId: string,
  personaId: number,
): Promise<{ persona: PersonaEntry; applied: boolean } | null> {
  const requested = await personaStorage.get(personaId);
  if (!requested) return null;
  const selection = await chatFileStorage.setSessionPersonaIfUnset(sessionId, requested.id);
  if (!selection) return null;
  const persona = selection.personaId === requested.id
    ? requested
    : await personaStorage.get(selection.personaId);
  return persona ? { persona, applied: selection.applied } : null;
}

export async function resolveSessionPersonaSnapshot(
  sessionId?: string | null,
  options?: { persistFallback?: boolean },
): Promise<PersonaSnapshot | undefined> {
  const persona = await resolveSessionPersona(sessionId, options);
  return persona ? { id: persona.id, name: persona.name, icon: persona.icon } : undefined;
}
