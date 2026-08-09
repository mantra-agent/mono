type HomePhase = "loading" | "renderable" | "settled";

interface HomeAttributionState {
  phase: HomePhase;
  focusShellMounted: boolean;
  sectionCount: number;
  itemCount: number;
}

const state: HomeAttributionState = {
  phase: "loading",
  focusShellMounted: false,
  sectionCount: 0,
  itemCount: 0,
};

let settleTimer: number | null = null;

function isHomeRoute(): boolean {
  return typeof window !== "undefined" && window.location.pathname === "/home";
}

export function markHomeLoading(): void {
  if (!isHomeRoute()) return;
  if (settleTimer !== null) window.clearTimeout(settleTimer);
  settleTimer = null;
  state.phase = "loading";
}

export function markHomeRenderable(sectionCount: number, itemCount: number): void {
  if (!isHomeRoute()) return;
  state.phase = "renderable";
  state.sectionCount = Math.max(0, Math.trunc(sectionCount));
  state.itemCount = Math.max(0, Math.trunc(itemCount));
  if (settleTimer !== null) window.clearTimeout(settleTimer);
  settleTimer = window.setTimeout(() => {
    if (isHomeRoute()) state.phase = "settled";
    settleTimer = null;
  }, 2_000);
}

export function markFocusShellMounted(mounted: boolean): void {
  state.focusShellMounted = mounted;
}

export function homeAttributionMetadata(): Record<string, string | number | boolean> {
  if (!isHomeRoute()) return {};
  return {
    homePhase: state.phase,
    focusShellMounted: state.focusShellMounted,
    homeSectionCount: state.sectionCount,
    homeItemCount: state.itemCount,
  };
}
