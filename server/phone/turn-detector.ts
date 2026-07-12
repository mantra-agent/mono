import { createLogger } from "../log";
import { TurnAssembler } from "../turn-assembly";
import type { STTTranscript } from "./stt/provider";
const log = createLogger("PhoneTurnDetector");
export class PhoneTurnDetector {
  private readonly assembler = new TurnAssembler({ maxActiveTurns: 1, maxFragmentsPerTurn: 256, maxBytesPerTurn: 65_536, maxOpenAgeMs: 30_000 });
  private turnKey = `phone:${Date.now()}`;
  private sequence = 0;
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly onTurn: (text: string) => Promise<void>, private readonly silenceMs = 900, private readonly streamId = "phone") {}
  push(result: STTTranscript): void {
    if (!result.isFinal) return;
    if (this.timer) clearTimeout(this.timer);
    const now = result.receivedAtMs ?? Date.now();
    const outcome = this.assembler.accept({ streamId: this.streamId, turnKey: this.turnKey, sequence: this.sequence++, direction: "inbound", speakerKey: "caller", text: result.text, stability: "stable", providerEventId: result.eventId, occurredAtMs: result.occurredAtMs ?? now, receivedAtMs: now });
    if (outcome.outcome === "closed") { void this.deliver(outcome.turn.text); return; }
    if (outcome.outcome === "rejected") log.warn(`phone turn rejected reason=${outcome.reason} streamId=${this.streamId}`);
    if (result.speechFinal) void this.flush("provider_endpoint");
    else { this.timer = setTimeout(() => void this.flush("conversational_gap"), this.silenceMs); this.timer.unref?.(); }
  }
  async flush(reason: "provider_endpoint" | "conversational_gap" | "stream_closed" = "conversational_gap"): Promise<void> { if (this.timer) clearTimeout(this.timer); this.timer = null; const outcome = this.assembler.close(this.turnKey, reason); if (outcome.outcome === "closed") await this.deliver(outcome.turn.text); }
  private async deliver(text: string): Promise<void> { this.turnKey = `phone:${Date.now()}:${this.sequence}`; this.sequence = 0; if (text) await this.onTurn(text); }
  close(): Promise<void> { return this.flush("stream_closed"); }
}
