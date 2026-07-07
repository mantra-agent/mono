export interface VoiceStartParams {
  chatSessionId: string | null;
  isReconnect?: boolean;
  requestId?: string;
}

export interface VoiceStartResult {
  signedUrl: string;
  agentId: string;
  voiceId: string | null;
  sessionId: string;
  chatSessionId: string | null;
  chatSessionKey?: string;
  timings?: Record<string, number>;
  serverTranscript?: Array<{ role: string; content: string; timestamp?: string }>;
}
