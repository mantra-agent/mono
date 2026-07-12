import type { STTTranscript } from "./stt/provider";

export class PhoneTurnDetector {
  private finalized: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly onTurn: (text: string) => Promise<void>, private readonly silenceMs = 900) {}

  push(result: STTTranscript): void {
    if (result.isFinal) this.finalized.push(result.text);
    if (!result.isFinal) return;
    if (this.timer) clearTimeout(this.timer);
    if (result.speechFinal) void this.flush();
    else this.timer = setTimeout(() => void this.flush(), this.silenceMs);
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const text = this.finalized.join(" ").replace(/\s+/g, " ").trim();
    this.finalized = [];
    if (text) await this.onTurn(text);
  }

  close(): Promise<void> { return this.flush(); }
}
