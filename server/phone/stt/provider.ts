import {
  connectDeepgramStreaming,
  deepgramConfigured,
} from "../../integrations/deepgram/streaming";

export interface STTTranscript {
  text: string;
  isFinal: boolean;
  speechFinal: boolean;
  eventId?: string;
  occurredAtMs?: number;
  receivedAtMs?: number;
}

export interface STTStream {
  sendAudio(bytes: Buffer): void;
  close(): void;
}

export interface STTProvider {
  readonly name: string;
  isConfigured(): boolean;
  connect(onTranscript: (result: STTTranscript) => void, onError: (error: Error) => void): Promise<STTStream>;
}

export class DeepgramSTTProvider implements STTProvider {
  readonly name = "deepgram";

  isConfigured(): boolean {
    return deepgramConfigured();
  }

  async connect(
    onTranscript: (result: STTTranscript) => void,
    onError: (error: Error) => void,
  ): Promise<STTStream> {
    return connectDeepgramStreaming(
      {
        model: "nova-3",
        language: "en-US",
        encoding: "mulaw",
        sampleRateHz: 8000,
        endpointingMs: 400,
      },
      (event) => onTranscript({
        text: event.text,
        isFinal: event.isFinal,
        speechFinal: event.speechFinal,
        eventId: event.requestId,
        receivedAtMs: event.receivedAtMs,
      }),
      onError,
    );
  }
}
