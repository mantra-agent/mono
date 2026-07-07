const SCROLLBAR_SELECTOR = ".scrollbar-thin, .scrollbar-hide";
const SCROLLING_CLASS = "is-scrolling";
const SCROLL_HIDE_DELAY_MS = 650;
const MANUAL_SCROLL_INTENT_MS = 500;

const hideTimers = new WeakMap<Element, number>();
const manualIntentTimers = new WeakMap<Element, number>();
const activePointers = new Set<number>();
let initialized = false;

function markScrolling(element: Element) {
  element.classList.add(SCROLLING_CLASS);

  const existingTimer = hideTimers.get(element);
  if (existingTimer) {
    window.clearTimeout(existingTimer);
  }

  const nextTimer = window.setTimeout(() => {
    element.classList.remove(SCROLLING_CLASS);
    hideTimers.delete(element);
  }, SCROLL_HIDE_DELAY_MS);

  hideTimers.set(element, nextTimer);
}

function markManualScrollIntent(element: Element) {
  const existingTimer = manualIntentTimers.get(element);
  if (existingTimer) {
    window.clearTimeout(existingTimer);
  }

  const nextTimer = window.setTimeout(() => {
    manualIntentTimers.delete(element);
  }, MANUAL_SCROLL_INTENT_MS);

  manualIntentTimers.set(element, nextTimer);
}

function hasManualScrollIntent(element: Element) {
  return manualIntentTimers.has(element);
}

function resolveScrollElement(eventTarget: EventTarget | null): Element | null {
  if (!(eventTarget instanceof Element)) {
    if (eventTarget === document || eventTarget === window) {
      return document.documentElement.matches(SCROLLBAR_SELECTOR) ? document.documentElement : null;
    }
    return null;
  }

  return eventTarget.matches(SCROLLBAR_SELECTOR)
    ? eventTarget
    : eventTarget.closest(SCROLLBAR_SELECTOR);
}

function rememberManualIntent(eventTarget: EventTarget | null) {
  const element = resolveScrollElement(eventTarget);
  if (element) {
    markManualScrollIntent(element);
  }
}

export function initializeActiveScrollbars() {
  if (typeof window === "undefined" || initialized) return;
  initialized = true;

  document.addEventListener(
    "wheel",
    (event) => {
      rememberManualIntent(event.target);
    },
    { capture: true, passive: true }
  );

  document.addEventListener(
    "touchmove",
    (event) => {
      rememberManualIntent(event.target);
    },
    { capture: true, passive: true }
  );

  document.addEventListener(
    "pointerdown",
    (event) => {
      activePointers.add(event.pointerId);
      rememberManualIntent(event.target);
    },
    { capture: true, passive: true }
  );

  document.addEventListener(
    "pointermove",
    (event) => {
      if (activePointers.has(event.pointerId)) {
        rememberManualIntent(event.target);
      }
    },
    { capture: true, passive: true }
  );

  const clearPointer = (event: PointerEvent) => {
    activePointers.delete(event.pointerId);
  };

  document.addEventListener("pointerup", clearPointer, { capture: true, passive: true });
  document.addEventListener("pointercancel", clearPointer, { capture: true, passive: true });

  document.addEventListener(
    "scroll",
    (event) => {
      const element = resolveScrollElement(event.target);
      if (element && hasManualScrollIntent(element)) {
        markScrolling(element);
      }
    },
    { capture: true, passive: true }
  );
}
