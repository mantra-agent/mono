import { createLogger } from "./log";

const log = createLogger("TurnAssembler");

export type FragmentStability = "provisional" | "stable";
export type TurnCloseReason = "conversational_gap" | "speaker_change" | "provider_endpoint" | "stream_closed" | "completed" | "cancelled" | "superseded" | "budget_exceeded" | "transport_failed";
export interface TurnFragment { streamId: string; turnKey: string; sequence: number; direction: "inbound" | "outbound"; speakerKey?: string; speakerLabel?: string; text: string; stability: FragmentStability; providerEventId?: string; occurredAtMs: number; receivedAtMs: number; }
export interface CompleteTurn { turnKey: string; streamId: string; direction: "inbound" | "outbound"; speakerKey?: string; speakerLabel?: string; text: string; rawFragments: TurnFragment[]; closeReason: TurnCloseReason; firstSequence: number; lastSequence: number; startedAtMs: number; closedAtMs: number; degraded: boolean; }
export type TurnAssemblyOutcome = { outcome: "accepted"; turnKey: string; sequence: number } | { outcome: "duplicate"; turnKey: string; providerEventId: string } | { outcome: "stale"; turnKey: string; sequence: number } | { outcome: "closed"; turn: CompleteTurn } | { outcome: "rejected"; turnKey: string; reason: "closed" | "invalid" | "capacity" };
export interface TurnAssemblerOptions { maxActiveTurns?: number; maxFragmentsPerTurn?: number; maxBytesPerTurn?: number; maxOpenAgeMs?: number; dedupeTtlMs?: number; }
interface State { seed: TurnFragment; fragments: TurnFragment[]; stable: string[]; provisional: string; lastSequence: number; bytes: number; }
const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

export class TurnAssembler {
  private readonly active = new Map<string, State>();
  private readonly closed = new Set<string>();
  private readonly eventIds = new Map<string, number>();
  private readonly limits: Required<TurnAssemblerOptions>;
  constructor(options: TurnAssemblerOptions = {}) { this.limits = { maxActiveTurns: options.maxActiveTurns ?? 256, maxFragmentsPerTurn: options.maxFragmentsPerTurn ?? 256, maxBytesPerTurn: options.maxBytesPerTurn ?? 65_536, maxOpenAgeMs: options.maxOpenAgeMs ?? 30_000, dedupeTtlMs: options.dedupeTtlMs ?? 300_000 }; }
  accept(fragment: TurnFragment): TurnAssemblyOutcome {
    this.prune(fragment.receivedAtMs);
    if (!fragment.turnKey || !fragment.streamId || fragment.sequence < 0 || !normalize(fragment.text)) return { outcome: "rejected", turnKey: fragment.turnKey, reason: "invalid" };
    if (this.closed.has(fragment.turnKey)) return { outcome: "rejected", turnKey: fragment.turnKey, reason: "closed" };
    if (fragment.providerEventId && this.eventIds.has(fragment.providerEventId)) return { outcome: "duplicate", turnKey: fragment.turnKey, providerEventId: fragment.providerEventId };
    let state = this.active.get(fragment.turnKey);
    if (!state) { if (this.active.size >= this.limits.maxActiveTurns) return { outcome: "rejected", turnKey: fragment.turnKey, reason: "capacity" }; state = { seed: fragment, fragments: [], stable: [], provisional: "", lastSequence: -1, bytes: 0 }; this.active.set(fragment.turnKey, state); }
    if (fragment.sequence <= state.lastSequence) return { outcome: "stale", turnKey: fragment.turnKey, sequence: fragment.sequence };
    const bytes = Buffer.byteLength(fragment.text);
    if (state.fragments.length + 1 > this.limits.maxFragmentsPerTurn || state.bytes + bytes > this.limits.maxBytesPerTurn || fragment.receivedAtMs - state.seed.receivedAtMs > this.limits.maxOpenAgeMs) return this.close(fragment.turnKey, "budget_exceeded", fragment.receivedAtMs);
    state.fragments.push({ ...fragment, text: normalize(fragment.text) }); state.lastSequence = fragment.sequence; state.bytes += bytes;
    if (fragment.stability === "stable") { state.stable.push(normalize(fragment.text)); state.provisional = ""; } else state.provisional = normalize(fragment.text);
    if (fragment.providerEventId) this.eventIds.set(fragment.providerEventId, fragment.receivedAtMs + this.limits.dedupeTtlMs);
    log.debug(`turn_fragment_accepted streamId=${fragment.streamId} turnKey=${fragment.turnKey} sequence=${fragment.sequence} fragments=${state.fragments.length} bytes=${state.bytes}`);
    return { outcome: "accepted", turnKey: fragment.turnKey, sequence: fragment.sequence };
  }
  close(turnKey: string, reason: TurnCloseReason, nowMs = Date.now()): TurnAssemblyOutcome {
    if (this.closed.has(turnKey)) return { outcome: "rejected", turnKey, reason: "closed" };
    const state = this.active.get(turnKey); if (!state) return { outcome: "rejected", turnKey, reason: "invalid" };
    this.active.delete(turnKey); this.closed.add(turnKey);
    const text = normalize([...state.stable, state.provisional].filter(Boolean).join(" "));
    const turn: CompleteTurn = { turnKey, streamId: state.seed.streamId, direction: state.seed.direction, speakerKey: state.seed.speakerKey, speakerLabel: state.fragments.at(-1)?.speakerLabel ?? state.seed.speakerLabel, text, rawFragments: [...state.fragments], closeReason: reason, firstSequence: state.fragments[0]?.sequence ?? 0, lastSequence: state.lastSequence, startedAtMs: state.seed.occurredAtMs, closedAtMs: nowMs, degraded: reason === "budget_exceeded" };
    log.info(`turn_closed streamId=${turn.streamId} turnKey=${turnKey} reason=${reason} fragments=${turn.rawFragments.length} bytes=${state.bytes}`);
    return { outcome: "closed", turn };
  }
  cancel(turnKey: string, reason: "cancelled" | "superseded"): TurnAssemblyOutcome { return this.close(turnKey, reason); }
  reset(streamId: string): CompleteTurn[] { const turns: CompleteTurn[] = []; for (const [key, state] of this.active) if (state.seed.streamId === streamId) { const result = this.close(key, "stream_closed"); if (result.outcome === "closed") turns.push(result.turn); } return turns; }
  private prune(now: number): void { for (const [id, expiry] of this.eventIds) if (expiry <= now) this.eventIds.delete(id); }
}
