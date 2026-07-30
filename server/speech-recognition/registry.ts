import type { SpeechRecognitionAdapterKind } from "@shared/models/platforms";
import { DeepgramDiarizingSTTProvider, ScribeRealtimeSTTProvider } from "./adapters";
import type { STTProvider } from "./contracts";

const adapters = new Map<SpeechRecognitionAdapterKind, STTProvider>([
  ["elevenlabs-scribe-realtime", new ScribeRealtimeSTTProvider()],
  ["deepgram-realtime", new DeepgramDiarizingSTTProvider()],
]);

export function getSpeechRecognitionAdapter(adapterKind: SpeechRecognitionAdapterKind): STTProvider {
  const adapter = adapters.get(adapterKind);
  if (!adapter) throw new Error(`Speech recognition adapter ${adapterKind} is not implemented`);
  return adapter;
}

export function listImplementedSpeechRecognitionAdapters(): SpeechRecognitionAdapterKind[] {
  return Array.from(adapters.keys());
}
