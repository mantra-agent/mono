import type { Principal } from "../principal";
import type { Person } from "../people-storage";
import { createLogger } from "../log";

const log = createLogger("IntroducedByLinks");

/** Deterministic idempotency key so re-running the migration for the same
 *  (introducee, introducer) pair converges on one durable typed link. */
function introducedByIdempotencyKey(personId: string, introducerId: string): string {
  return `introduced_by:${personId}:${introducerId}`.slice(0, 200);
}

/**
 * Convert a Person's weak `introducedBy` text into a durable typed
 * `introduced_by` address link when — and only when — the text resolves to a
 * visible Person (alias-aware, so absorbed IDs redirect to the survivor).
 *
 * The strong `persons.introducedBy` column remains authoritative/compatibility;
 * this is an additive, replay-safe dual write onto the canonical
 * `address_links` convergence target. It is best-effort: a link failure must
 * never fail the owning Person save. Free-text names that do not resolve to a
 * Person are intentionally left as text until a later curation resolves them.
 */
export async function syncPersonIntroducedByLink(principal: Principal, person: Person): Promise<void> {
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) return;
  const raw = person.introducedBy?.trim();
  if (!raw) return;

  try {
    const { peopleStorage } = await import("../people-storage");
    // getPeopleByIds resolves the principal-visible merge alias graph, so an
    // absorbed introducer address redirects to the surviving Person. A plain
    // name (not a Person ID) resolves to nothing and is left as text.
    const [introducer] = await peopleStorage.getPeopleByIds([raw]);
    if (!introducer || introducer.id === person.id) return;

    const { createAddressLink } = await import("../life-addressing-storage");
    await createAddressLink(principal, {
      sourceAddress: `@person:${person.id}`,
      predicate: "introduced_by",
      targetAddress: `@person:${introducer.id}`,
      createdBy: "person:introduced_by_migration",
      idempotencyKey: introducedByIdempotencyKey(person.id, introducer.id),
    });
  } catch (error) {
    // 409 means a different link already owns this idempotency key (e.g. the
    // introducer changed); that is acceptable and non-fatal for a dual write.
    log.warn(`introduced_by link sync skipped for person=${person.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Bounded, replay-safe backfill of `introduced_by` typed links for the current
 * principal's visible People. Idempotent by link idempotency key. Returns
 * parity counts for observability. The whole-account boot backfill is owned by
 * the Phase 4 cutover step; this principal-scoped pass converges one account.
 */
export async function backfillIntroducedByLinksForPrincipal(
  principal: Principal,
  options: { limit?: number } = {},
): Promise<{ scanned: number; withText: number; resolved: number; linked: number }> {
  const limit = Math.min(Math.max(options.limit ?? 1000, 1), 5000);
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
    return { scanned: 0, withText: 0, resolved: 0, linked: 0 };
  }
  const { peopleStorage } = await import("../people-storage");
  const index = await peopleStorage.listPeople();
  const ids = index.slice(0, limit).map(entry => entry.id);
  const people = await peopleStorage.getPeopleByIds(ids);

  let withText = 0;
  let resolved = 0;
  let linked = 0;
  for (const person of people) {
    const raw = person.introducedBy?.trim();
    if (!raw) continue;
    withText += 1;
    const [introducer] = await peopleStorage.getPeopleByIds([raw]);
    if (!introducer || introducer.id === person.id) continue;
    resolved += 1;
    try {
      const { createAddressLink } = await import("../life-addressing-storage");
      await createAddressLink(principal, {
        sourceAddress: `@person:${person.id}`,
        predicate: "introduced_by",
        targetAddress: `@person:${introducer.id}`,
        createdBy: "person:introduced_by_migration",
        idempotencyKey: introducedByIdempotencyKey(person.id, introducer.id),
      });
      linked += 1;
    } catch {
      // Idempotent replay or a superseded introducer; non-fatal.
    }
  }
  log.info(`[introduced-by-backfill] scanned=${people.length} withText=${withText} resolved=${resolved} linked=${linked}`);
  return { scanned: people.length, withText, resolved, linked };
}
