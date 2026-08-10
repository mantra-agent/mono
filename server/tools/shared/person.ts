import { createLogger } from "../../log";

const toolExec = createLogger("ToolExec");

/**
 * Resolve a person reference (explicit `id` or free-text `query`) to a
 * canonical `{ id, name }` through the peopleStorage boundary. This is the
 * single shared resolver used by every people-, calendar-, relationship-, and
 * cross-session handler that accepts a person argument, so id/name resolution
 * and ambiguity semantics stay identical across domains. It matches by exact
 * id, id-prefix, a bounded edit-distance fallback, then name search, and
 * returns null on no-match or genuine ambiguity (logged) rather than guessing.
 */
export async function resolvePersonId(args: Record<string, any>): Promise<{ id: string; name: string } | null> {
  const { peopleStorage } = await import("../../people-storage");
  const id = args.id;
  if (id) {
    const person = await peopleStorage.getPerson(id);
    if (person) return { id: person.id, name: person.name };
    const allPeople = await peopleStorage.listPeople();
    const fuzzy = allPeople.find(p => p.id.startsWith(id) || id.startsWith(p.id));
    if (fuzzy) return { id: fuzzy.id, name: fuzzy.name };
    const closeMatch = allPeople.find(p => {
      if (Math.abs(p.id.length - id.length) > 1) return false;
      let diffs = 0;
      for (let i = 0; i < Math.max(p.id.length, id.length); i++) {
        if (p.id[i] !== id[i]) diffs++;
      }
      return diffs <= 2;
    });
    if (closeMatch) return { id: closeMatch.id, name: closeMatch.name };
    const byName = await peopleStorage.searchPeople(id);
    if (byName.length === 1) return { id: byName[0].id, name: byName[0].name };
    if (byName.length > 1) {
      const exact = byName.find(r => r.name.toLowerCase() === id.toLowerCase());
      if (exact) return { id: exact.id, name: exact.name };
      toolExec.warn(`resolvePersonId: ambiguous match for "${id}" — ${byName.length} candidates: ${byName.map(r => `${r.name} (${r.id})`).join(", ")}`);
      return null;
    }
  }
  const name = args.query;
  if (name) {
    const results = await peopleStorage.searchPeople(name);
    if (results.length === 1) return { id: results[0].id, name: results[0].name };
    if (results.length > 1) {
      const exact = results.find(r => r.name.toLowerCase() === name.toLowerCase());
      if (exact) return { id: exact.id, name: exact.name };
      toolExec.warn(`resolvePersonId: ambiguous match for "${name}" — ${results.length} candidates: ${results.map(r => `${r.name} (${r.id})`).join(", ")}`);
      return null;
    }
  }
  return null;
}
