import { useEffect, useRef, useCallback } from "react";

export function useFocusManager(containerRef: React.RefObject<HTMLDivElement | null>) {
  const focusIndexRef = useRef(-1);

  const getFocusables = useCallback((): HTMLElement[] => {
    if (!containerRef.current) return [];
    return Array.from(containerRef.current.querySelectorAll<HTMLElement>(".focusable"));
  }, [containerRef]);

  const applyFocus = useCallback(
    (index: number) => {
      const elements = getFocusables();
      // Clear all focused state
      elements.forEach((el) => el.classList.remove("focused"));

      if (index >= 0 && index < elements.length) {
        elements[index].classList.add("focused");
        elements[index].scrollIntoView({ behavior: "smooth", block: "nearest" });
        focusIndexRef.current = index;
      }
    },
    [getFocusables],
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInsideSurface = containerRef.current?.contains(target);
      const isGlobal = target === document.body || target === document.documentElement;
      if (!isInsideSurface && !isGlobal) return;

      const elements = getFocusables();
      if (elements.length === 0) return;

      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault();
          const next =
            focusIndexRef.current < elements.length - 1
              ? focusIndexRef.current + 1
              : 0;
          applyFocus(next);
          break;
        }
        case "ArrowUp": {
          e.preventDefault();
          const prev =
            focusIndexRef.current > 0
              ? focusIndexRef.current - 1
              : elements.length - 1;
          applyFocus(prev);
          break;
        }
        case "Enter":
        case " ": {
          e.preventDefault();
          const current = elements[focusIndexRef.current];
          if (current) {
            current.click();
          }
          break;
        }
        case "Tab": {
          // Suppress tab within the surface to keep D-pad semantics
          e.preventDefault();
          break;
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [getFocusables, applyFocus]);

  // Re-index on render
  useEffect(() => {
    const elements = getFocusables();
    if (focusIndexRef.current >= elements.length) {
      focusIndexRef.current = Math.max(0, elements.length - 1);
    }
  });
}
