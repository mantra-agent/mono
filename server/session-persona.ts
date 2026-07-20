import { createLogger } from "./log";
import { chatFileStorage } from "./chat-file-storage";
import { personaStorage, type PersonaEntry } from "./file-storage/persona-storage";
import type { PersonaSnapshot } from "@shared/models/chat";

const log = createLogger("SessionPersona");

function defaultPersona(personas: PersonaEntry[]): PersonaEntry | null {
  return personas.find((persona) => persona.isDefault)
    ?? personas.find((persona) => persona.name === "Default")
    ?? personas[0]
    ?? null;
}

/** Resolve the persona that governs one session, migrating legacy active state once. */
export async function resolveSessionPersona(
  sessionId?: string | null,
  options: { persistFallback?: boolean } = {},
): Promise<PersonaEntry | null> {
  if (sessionId) {
    const session = await chatFileStorage.getSession(sessionId);
    if (session?.personaId) {
      const persona = await personaStorage.get(session.personaId);
      if (persona) return persona;
      log.warn(`session=${sessionId} references missing personaId=${session.personaId}; using compatibility fallback`);
    }

    const personas = await personaStorage.list();
    const legacyActive = await personaStorage.getActiveOrNull();
    const fallback = legacyActive ?? defaultPersona(personas);
    if (fallback && options.persistFallback !== false) {
      await chatFileStorage.updateSessionPersona(sessionId, fallback.id);
      log.info(`session=${sessionId} migrated personaId=${fallback.id} source=${legacyActive ? "legacy-active" : "default"}`);
    }
    return fallback;
  }

  const personas = await personaStorage.list();
  return await personaStorage.getActiveOrNull() ?? defaultPersona(personas);
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
