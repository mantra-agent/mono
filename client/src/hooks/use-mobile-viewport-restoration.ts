import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createLogger } from "@/lib/logger";

const log = createLogger("MobileViewport");
const VIEWPORT_TOLERANCE_PX = 2;
const STABLE_FRAME_COUNT = 4;
const RESTORE_FRAME_BUDGET = 60;

type ViewportSnapshot = {
  height: number;
  offsetTop: number;
};

/**
 * Owns the physical-mobile shell height across Safari keyboard transitions.
 * Internal page and transcript scroll containers are deliberately untouched.
 */
export function useMobileViewportRestoration(enabled: boolean) {
  const shellRef = useRef<HTMLDivElement>(null);
  const restingHeightRef = useRef<number | null>(null);
  const composerFocusedRef = useRef(false);
  const restoringRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const framesRemainingRef = useRef(0);
  const stableFramesRef = useRef(0);
  const previousSnapshotRef = useRef<ViewportSnapshot | null>(null);
  const [restoredHeight, setRestoredHeight] = useState<number | null>(null);

  const cancelRestore = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    framesRemainingRef.current = 0;
    stableFramesRef.current = 0;
    previousSnapshotRef.current = null;
  }, []);

  const readViewport = useCallback((): ViewportSnapshot => {
    const viewport = window.visualViewport;
    return {
      height: viewport?.height ?? window.innerHeight,
      offsetTop: viewport?.offsetTop ?? 0,
    };
  }, []);

  const finalizeRestore = useCallback((snapshot: ViewportSnapshot) => {
    if (!enabled || composerFocusedRef.current || !restoringRef.current) return;
    const restingHeight = restingHeightRef.current;
    if (!restingHeight) return;

    const shellHeight = shellRef.current?.getBoundingClientRect().height ?? 0;
    const windowScrollY = window.scrollY;
    const browserRecovered =
      Math.abs(snapshot.height - restingHeight) <= VIEWPORT_TOLERANCE_PX &&
      Math.abs(shellHeight - restingHeight) <= VIEWPORT_TOLERANCE_PX &&
      Math.abs(snapshot.offsetTop) <= VIEWPORT_TOLERANCE_PX &&
      Math.abs(windowScrollY) <= VIEWPORT_TOLERANCE_PX;

    setRestoredHeight(browserRecovered ? null : restingHeight);
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    restoringRef.current = false;

    if (!browserRecovered) {
      log.debug("Restored mobile viewport after keyboard dismissal", {
        restingHeight,
        shellHeight,
        viewportHeight: snapshot.height,
        viewportOffsetTop: snapshot.offsetTop,
        windowScrollY,
      });
    }
  }, [enabled]);

  const runRestoreFrame = useCallback(() => {
    frameRef.current = null;
    if (!enabled || composerFocusedRef.current || !restoringRef.current) return;

    const snapshot = readViewport();
    const previous = previousSnapshotRef.current;
    const stable = previous
      && Math.abs(snapshot.height - previous.height) <= VIEWPORT_TOLERANCE_PX
      && Math.abs(snapshot.offsetTop - previous.offsetTop) <= VIEWPORT_TOLERANCE_PX;

    stableFramesRef.current = stable ? stableFramesRef.current + 1 : 0;
    previousSnapshotRef.current = snapshot;
    framesRemainingRef.current -= 1;

    if (stableFramesRef.current >= STABLE_FRAME_COUNT || framesRemainingRef.current <= 0) {
      finalizeRestore(snapshot);
      return;
    }

    frameRef.current = requestAnimationFrame(runRestoreFrame);
  }, [enabled, finalizeRestore, readViewport]);

  const startRestore = useCallback(() => {
    cancelRestore();
    restoringRef.current = true;
    framesRemainingRef.current = RESTORE_FRAME_BUDGET;
    frameRef.current = requestAnimationFrame(runRestoreFrame);
  }, [cancelRestore, runRestoreFrame]);

  const onComposerFocusChange = useCallback((focused: boolean) => {
    if (!enabled) return;
    cancelRestore();
    composerFocusedRef.current = focused;

    if (focused) {
      restoringRef.current = false;
      const shellHeight = shellRef.current?.getBoundingClientRect().height;
      if (shellHeight && shellHeight > 0) restingHeightRef.current = Math.round(shellHeight);
      setRestoredHeight(null);
      return;
    }

    startRestore();
  }, [cancelRestore, enabled, startRestore]);

  useLayoutEffect(() => {
    if (restoredHeight === null) return;
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [restoredHeight]);

  useEffect(() => {
    if (!enabled) return;
    const handleOrientationChange = () => {
      cancelRestore();
      composerFocusedRef.current = false;
      restoringRef.current = false;
      restingHeightRef.current = null;
      setRestoredHeight(null);
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    };

    window.addEventListener("orientationchange", handleOrientationChange);
    return () => {
      cancelRestore();
      window.removeEventListener("orientationchange", handleOrientationChange);
    };
  }, [cancelRestore, enabled]);

  return { shellRef, restoredHeight, onComposerFocusChange };
}
