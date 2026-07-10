/**
 * Meeting transport boundary — M0.
 *
 * A MeetingTransport delivers attributed transcript text INTO a meeting
 * session and reports bot lifecycle status. It is the seam where meeting
 * vendors (Recall.ai, Zoom SDK, SIP/phone stacks) plug in later — M0 ships
 * zero vendors. The dev loopback endpoint is the first "transport": it feeds
 * the exact same session/message plumbing a real transport will use.
 *
 * This mirrors the TextTransport boundary from the transport spec: ElevenLabs
 * voice remains untouched as one text-transport implementation; meeting
 * transports are a sibling inbound path, not a rewrite of it.
 *
 * Abstractions stay minimal by design (Minimum Viable Protocol): STT/TTS
 * composition only becomes an interface when a second consumer exists
 * (TTS at M4, STT at M5).
 */

import type { MeetingBotStatus } from "@shared/models/chat";

/** One attributed utterance arriving from a meeting. */
export interface MeetingTranscriptEvent {
  /** Raw utterance text. */
  text: string;
  /**
   * Speaker label as reported by the transport (display name, caller ID).
   * Undefined when the transport cannot attribute the utterance — the
   * session layer assigns a stable "Speaker N" identity per session.
   */
  speakerLabel?: string;
  /** Transport-side timestamp (ISO). Defaults to receipt time when absent. */
  timestamp?: string;
}

export type MeetingTranscriptHandler = (
  event: MeetingTranscriptEvent,
) => void | Promise<void>;

export type MeetingStatusHandler = (
  status: MeetingBotStatus,
) => void | Promise<void>;

/**
 * Inbound meeting transport. Implementations own vendor connection details;
 * consumers only see attributed transcript events and bot status transitions.
 */
export interface MeetingTransport {
  /** Join/dial into the meeting. Resolves once the connection attempt starts. */
  connect(): Promise<void>;
  /** Leave the meeting and release vendor resources. */
  disconnect(): Promise<void>;
  /** Register the single downstream handler for attributed transcript text. */
  onTranscript(handler: MeetingTranscriptHandler): void;
  /** Register the single downstream handler for bot lifecycle transitions. */
  onStatus(handler: MeetingStatusHandler): void;
}
