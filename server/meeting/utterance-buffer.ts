import { createLogger } from "../log";
import { TurnAssembler, type CompleteTurn, type TurnCloseReason } from "../turn-assembly";
const log = createLogger("MeetingUtteranceBuffer");
const DEFAULT_SILENCE_MS = 1_800;
export interface MeetingUtteranceChunk { sessionId: string; speakerKey: string; speakerLabel?: string; text: string; final: boolean; eventId?: string; }
export interface FinalizedMeetingUtterance { sessionId: string; speakerLabel?: string; text: string; reason: "provider_final" | "silence" | "speaker_change" | "budget_exceeded"; }
export type FinalizedMeetingUtteranceHandler = (utterance: FinalizedMeetingUtterance) => Promise<void>;
interface Active { turnKey: string; speakerKey: string; sequence: number; timer: NodeJS.Timeout | null; }
export class MeetingUtteranceBuffer {
  private readonly assembler = new TurnAssembler({ maxActiveTurns: 256, maxFragmentsPerTurn: 256, maxBytesPerTurn: 65_536, maxOpenAgeMs: 30_000 });
  private readonly activeBySession = new Map<string, Active>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly silenceMs: number;
  constructor(private readonly onFinalized: FinalizedMeetingUtteranceHandler, opts: { silenceMs?: number } = {}) { this.silenceMs = opts.silenceMs ?? DEFAULT_SILENCE_MS; }
  push(chunk: MeetingUtteranceChunk): Promise<void> { const prior = this.chains.get(chunk.sessionId) ?? Promise.resolve(); const next = prior.catch(() => undefined).then(() => this.apply(chunk)).finally(() => { if (this.chains.get(chunk.sessionId) === next) this.chains.delete(chunk.sessionId); }); this.chains.set(chunk.sessionId, next); return next; }
  private async apply(chunk: MeetingUtteranceChunk): Promise<void> {
    let active = this.activeBySession.get(chunk.sessionId);
    if (active && active.speakerKey !== chunk.speakerKey) { await this.finish(chunk.sessionId, active, "speaker_change"); active = undefined; }
    if (!active) { active = { turnKey: `${chunk.sessionId}:${chunk.speakerKey}:${Date.now()}`, speakerKey: chunk.speakerKey, sequence: 0, timer: null }; this.activeBySession.set(chunk.sessionId, active); }
    if (active.timer) clearTimeout(active.timer);
    const now = Date.now();
    const outcome = this.assembler.accept({ streamId: chunk.sessionId, turnKey: active.turnKey, sequence: active.sequence++, direction: "inbound", speakerKey: chunk.speakerKey, speakerLabel: chunk.speakerLabel, text: chunk.text, stability: chunk.final ? "stable" : "provisional", providerEventId: chunk.eventId, occurredAtMs: now, receivedAtMs: now });
    if (outcome.outcome === "closed") { this.activeBySession.delete(chunk.sessionId); await this.emit(outcome.turn); return; }
    if (outcome.outcome === "rejected") { log.warn(`turn_rejected sessionId=${chunk.sessionId} reason=${outcome.reason}`); return; }
    active.timer = setTimeout(() => void this.enqueueFinish(chunk.sessionId, active!, "conversational_gap"), this.silenceMs); active.timer.unref?.();
  }
  private enqueueFinish(sessionId: string, active: Active, reason: TurnCloseReason): Promise<void> { const prior = this.chains.get(sessionId) ?? Promise.resolve(); const next = prior.catch(() => undefined).then(() => this.finish(sessionId, active, reason)).finally(() => { if (this.chains.get(sessionId) === next) this.chains.delete(sessionId); }); this.chains.set(sessionId, next); return next; }
  private async finish(sessionId: string, active: Active, reason: TurnCloseReason): Promise<void> { if (this.activeBySession.get(sessionId)?.turnKey !== active.turnKey) return; if (active.timer) clearTimeout(active.timer); this.activeBySession.delete(sessionId); const outcome = this.assembler.close(active.turnKey, reason); if (outcome.outcome === "closed") await this.emit(outcome.turn); }
  private async emit(turn: CompleteTurn): Promise<void> { if (!turn.text) return; const reason: FinalizedMeetingUtterance["reason"] = turn.closeReason === "speaker_change" ? "speaker_change" : turn.closeReason === "budget_exceeded" ? "budget_exceeded" : turn.closeReason === "provider_endpoint" ? "provider_final" : "silence"; try { await this.onFinalized({ sessionId: turn.streamId, speakerLabel: turn.speakerLabel, text: turn.text, reason }); } catch (error) { log.error(`utterance finalization failed sessionId=${turn.streamId}`, error); } }
}
