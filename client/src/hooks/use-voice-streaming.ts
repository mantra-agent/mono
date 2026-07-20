interface VoiceSessionHandle {
  status: string;
  activeConversationId: string | null;
}

/** Derives whether the visible session owns the active voice conversation. */
export function useVoiceStreaming(
  voiceSession: VoiceSessionHandle | null | undefined,
  activeSessionId: string | null,
) {
  return {
    voiceActive: !!(
      voiceSession &&
      activeSessionId &&
      voiceSession.activeConversationId === activeSessionId &&
      voiceSession.status !== "idle"
    ),
  };
}
