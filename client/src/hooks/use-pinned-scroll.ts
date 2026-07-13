import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import { createLogger } from "@/lib/logger";

const log = createLogger("PinnedScroll");

interface UsePinnedScrollOptions {
  containerRef: RefObject<HTMLElement>;
  revision: string | number;
  enabled?: boolean;
  bottomThreshold?: number;
  resetKey?: string | number | null;
}

interface UsePinnedScrollResult {
  onScroll: () => void;
  onUserScrollIntent: () => void;
  forcePin: () => void;
}

function distanceFromBottom(container: HTMLElement): number {
  return container.scrollHeight - container.scrollTop - container.clientHeight;
}

function pinToBottom(container: HTMLElement): void {
  container.scrollTop = container.scrollHeight;
}

export function usePinnedScroll({
  containerRef,
  revision,
  enabled = true,
  bottomThreshold = 96,
  resetKey = null,
}: UsePinnedScrollOptions): UsePinnedScrollResult {
  const isPinnedRef = useRef(true);
  const programmaticScrollRef = useRef(false);
  const userScrollIntentRef = useRef(false);
  const lastRevisionRef = useRef<string | number | null>(null);

  const updatePinnedState = useCallback((container: HTMLElement) => {
    const isPinned = distanceFromBottom(container) <= bottomThreshold;
    const wasPinned = isPinnedRef.current;
    isPinnedRef.current = isPinned;
    if (isPinned) {
      userScrollIntentRef.current = false;
    } else if (wasPinned) {
      log.verbose(() => `SCROLL_USER_UNPIN resetKey=${resetKey} distance=${distanceFromBottom(container)}`);
    }
    return isPinned;
  }, [bottomThreshold, resetKey]);

  const onUserScrollIntent = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    userScrollIntentRef.current = true;
  }, [containerRef]);

  const onScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    if (programmaticScrollRef.current && !userScrollIntentRef.current) return;
    // Layout growth fires scroll events too. It must not revoke follow mode.
    // Only a preceding wheel/touch intent is allowed to change pinned state.
    if (!userScrollIntentRef.current) return;
    updatePinnedState(container);
  }, [containerRef, updatePinnedState]);

  const forcePin = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    log.verbose(() => `SCROLL_FORCE_PIN resetKey=${resetKey}`);
    isPinnedRef.current = true;
    userScrollIntentRef.current = false;
    programmaticScrollRef.current = true;
    requestAnimationFrame(() => {
      pinToBottom(container);
      log.verbose(() => `SCROLL_FORCE_PIN_APPLY resetKey=${resetKey} top=${container.scrollTop}`);
      requestAnimationFrame(() => {
        programmaticScrollRef.current = false;
        updatePinnedState(container);
      });
    });
  }, [containerRef, resetKey, updatePinnedState]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    isPinnedRef.current = true;
    userScrollIntentRef.current = false;
    lastRevisionRef.current = null;
    if (!enabled || !container) return;
    log.verbose(() => `SCROLL_RESET resetKey=${resetKey}`);
    programmaticScrollRef.current = true;
    requestAnimationFrame(() => {
      pinToBottom(container);
      log.verbose(() => `SCROLL_RESET_APPLY resetKey=${resetKey} top=${container.scrollTop}`);
      requestAnimationFrame(() => {
        programmaticScrollRef.current = false;
        updatePinnedState(container);
      });
    });
  }, [containerRef, enabled, resetKey, updatePinnedState]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!enabled || !container) return;
    const previousRevision = lastRevisionRef.current;
    const revisionChanged = previousRevision !== revision;
    lastRevisionRef.current = revision;
    if (!revisionChanged) return;
    log.verbose(() => `SCROLL_REVISION resetKey=${resetKey} pinned=${isPinnedRef.current}`);
    if (!isPinnedRef.current) return;
    programmaticScrollRef.current = true;
    requestAnimationFrame(() => {
      if (userScrollIntentRef.current && !updatePinnedState(container)) {
        programmaticScrollRef.current = false;
        log.verbose(() => `SCROLL_REVISION_CANCEL_USER resetKey=${resetKey}`);
        return;
      }
      pinToBottom(container);
      log.verbose(() => `SCROLL_REVISION_APPLY resetKey=${resetKey} top=${container.scrollTop}`);
      requestAnimationFrame(() => {
        programmaticScrollRef.current = false;
        updatePinnedState(container);
      });
    });
  }, [bottomThreshold, containerRef, enabled, resetKey, revision, updatePinnedState]);

  return { onScroll, onUserScrollIntent, forcePin };
}
