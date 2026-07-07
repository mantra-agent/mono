/**
 * Thinking content filter for voice output.
 *
 * Strips <thinking>...</thinking> blocks from streaming LLM output
 * so they're never sent to the TTS engine. Handles partial tags at
 * chunk boundaries and tracks suppression stats for diagnostics.
 */
import { createLogger } from "../log";

const log = createLogger("VoiceThinking");

/**
 * Find the start of a partial tag match at the end of data.
 * Returns the index where the partial match starts, or -1.
 */
export function findPartialTagStart(data: string, from: number, tag: string): number {
  const maxLen = Math.min(tag.length - 1, data.length - from);
  for (let len = maxLen; len >= 1; len--) {
    const start = data.length - len;
    if (start >= from && data.slice(start) === tag.slice(0, len)) {
      return start;
    }
  }
  return -1;
}

export interface ThinkingFilterResult {
  filteredSendChunk: (content: string) => void;
  getStats: () => { chars: number; ms: number };
  finalize: () => void;
}

/**
 * Create a passthrough filter (no thinking suppression).
 */
export function createPassthroughThinkingFilter(sendChunk: (content: string) => void): ThinkingFilterResult {
  return {
    filteredSendChunk: sendChunk,
    getStats: () => ({ chars: 0, ms: 0 }),
    finalize: () => {},
  };
}

/**
 * Create a thinking filter that strips <thinking>...</thinking> blocks.
 */
export function createThinkingFilter(sendChunk: (content: string) => void): ThinkingFilterResult {
  const OPEN_TAG = "<thinking>";
  const CLOSE_TAG = "</thinking>";
  let thinkingBuf = "";
  let inThinking = false;
  let suppChars = 0;
  let suppMs = 0;
  let openedAt: number | null = null;

  const filteredSendChunk = (content: string) => {
    let out = "";
    let data = thinkingBuf + content;
    thinkingBuf = "";
    let i = 0;
    while (i < data.length) {
      if (inThinking) {
        const closeIdx = data.indexOf(CLOSE_TAG, i);
        if (closeIdx === -1) {
          const tailStart = findPartialTagStart(data, i, CLOSE_TAG);
          if (tailStart !== -1) { suppChars += tailStart - i; thinkingBuf = data.slice(tailStart); }
          else { suppChars += data.length - i; }
          break;
        } else {
          suppChars += closeIdx - i;
          i = closeIdx + CLOSE_TAG.length;
          inThinking = false;
          if (openedAt !== null) { suppMs += Date.now() - openedAt; openedAt = null; }
        }
      } else {
        const openIdx = data.indexOf(OPEN_TAG, i);
        if (openIdx === -1) {
          const tailStart = findPartialTagStart(data, i, OPEN_TAG);
          if (tailStart !== -1) { out += data.slice(i, tailStart); thinkingBuf = data.slice(tailStart); }
          else { out += data.slice(i); }
          break;
        } else {
          out += data.slice(i, openIdx);
          i = openIdx + OPEN_TAG.length;
          inThinking = true;
          openedAt = Date.now();
        }
      }
    }
    if (out) sendChunk(out);
  };

  return {
    filteredSendChunk,
    getStats: () => ({ chars: suppChars, ms: suppMs }),
    finalize: () => {
      if (thinkingBuf && !inThinking) {
        log.warn(`thinkingFilter finalize: flushing ${thinkingBuf.length} buffered bytes (possible partial tag)`);
        sendChunk(thinkingBuf);
        thinkingBuf = "";
      } else if (thinkingBuf && inThinking) {
        log.warn(`thinkingFilter finalize: discarding ${thinkingBuf.length} bytes from unclosed <thinking> block`);
        suppChars += thinkingBuf.length;
        thinkingBuf = "";
      }
      if (openedAt !== null) { suppMs += Date.now() - openedAt; openedAt = null; }
    },
  };
}
