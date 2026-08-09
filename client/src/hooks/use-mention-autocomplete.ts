import { useState, useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { normalizeReferenceType, serializeReference, type ReferenceType } from "@shared/references";
import { createLogger } from "@/lib/logger";
import {
  loadReferenceSuggestions,
  REFERENCE_TYPE_LABELS,
  type ReferenceSuggestion,
} from "@/lib/reference-search";

const logger = createLogger("MentionAutocomplete");

// Re-export shared types so existing consumers keep working.
export type { ReferenceSuggestion };
export { REFERENCE_TYPE_LABELS };

export type ReferenceTrigger = {
  start: number;
  query: string;
  triggerChar: "@" | "#";
};

/**
 * Detect a mention trigger (`@` or `#`) from the text before the cursor.
 * When both characters are present, the one closest to the cursor wins.
 *
 * Spaces are part of the query so multi-word people/labels stay open
 * ("@Michael Miller", multi-word tasks). Newlines, backticks, and `type:`
 * completion still end the trigger.
 */
export function findReferenceTrigger(value: string, cursor: number): ReferenceTrigger | null {
  const beforeCursor = value.slice(0, cursor);
  let best: ReferenceTrigger | null = null;
  for (const char of ["@", "#"] as const) {
    const pos = beforeCursor.lastIndexOf(char);
    if (pos === -1) continue;
    const beforeChar = pos === 0 ? " " : beforeCursor[pos - 1];
    if (!/\s|[(\[{]/.test(beforeChar)) continue;
    const query = beforeCursor.slice(pos + 1);
    // Allow ordinary spaces for multi-word labels; end on hard breaks only.
    if (/[\n\r`]/.test(query)) continue;
    if (query.includes(":")) continue;
    const candidate: ReferenceTrigger = { start: pos, query, triggerChar: char };
    if (!best || pos > best.start) best = candidate;
  }
  return best;
}

export interface MentionAutocompleteOptions {
  /** Current text value */
  value: string;
  /** Cursor position in the text */
  cursorPosition: number;
  /** Callback to update text and cursor */
  onChange: (newValue: string, newCursorPosition: number) => void;
  /** Restrict suggestions to specific reference types. */
  allowedTypes?: ReferenceType[];
}

export interface MentionAutocompleteResult {
  /** Active trigger state (null when inactive) */
  trigger: ReferenceTrigger | null;
  /** Filtered suggestions */
  suggestions: ReferenceSuggestion[];
  /** Whether suggestions are loading */
  isLoading: boolean;
  /** Active keyboard-navigation index */
  activeIndex: number;
  /** Set active index (for hover) */
  setActiveIndex: (index: number) => void;
  /** Insert the given suggestion at the trigger position */
  insertSuggestion: (suggestion: ReferenceSuggestion) => void;
  /** Dismiss the popover without inserting */
  dismiss: () => void;
  /** Handle keyboard events — returns true if consumed */
  handleKeyDown: (e: React.KeyboardEvent) => boolean;
  /** Call on every input change to re-evaluate trigger */
  handleInputChange: (value: string, cursorPosition: number) => void;
}

export function useMentionAutocomplete(
  options: MentionAutocompleteOptions,
): MentionAutocompleteResult {
  const { value, onChange, allowedTypes } = options;
  const allowedKey = allowedTypes?.join(",") || "";
  const queryClient = useQueryClient();

  const [trigger, setTrigger] = useState<ReferenceTrigger | null>(null);
  const [suggestions, setSuggestions] = useState<ReferenceSuggestion[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  // Keep a ref for current trigger to avoid stale closures in insert
  const triggerRef = useRef(trigger);
  triggerRef.current = trigger;
  const valueRef = useRef(value);
  valueRef.current = value;

  // Detect trigger on input changes
  const handleInputChange = useCallback((newValue: string, cursorPosition: number) => {
    const detected = findReferenceTrigger(newValue, cursorPosition);
    setTrigger(detected);
    setActiveIndex(0);
  }, []);

  // Debounced suggestion fetching via shared search path
  useEffect(() => {
    if (!trigger) {
      setSuggestions([]);
      setIsLoading(false);
      return;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      setIsLoading(true);
      loadReferenceSuggestions({
        query: trigger.query,
        signal: controller.signal,
        allowedTypes,
        triggerChar: trigger.triggerChar,
      })
        .then((results) => {
          if (!controller.signal.aborted) {
            setSuggestions(results);
          }
        })
        .catch((error) => {
          if (error?.name !== "AbortError") {
            logger.warn("fetch-error", { error: error?.message || String(error) });
            setSuggestions([]);
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setIsLoading(false);
        });
    }, 120);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [trigger, allowedKey, allowedTypes]);

  const insertSuggestion = useCallback(
    (suggestion: ReferenceSuggestion) => {
      const currentTrigger = triggerRef.current;
      if (!currentTrigger) return;
      const currentValue = valueRef.current;
      const normalizedType = normalizeReferenceType(suggestion.type);
      const token = serializeReference({ type: normalizedType, id: suggestion.id });
      if (suggestion.label && suggestion.label !== suggestion.id) {
        queryClient.setQueryData(
          ["reference-label", normalizedType, suggestion.id],
          suggestion.label,
        );
      }
      const nextValue = `${currentValue.slice(0, currentTrigger.start)}${token} ${currentValue.slice(currentTrigger.start + 1 + currentTrigger.query.length)}`;
      const nextCursor = currentTrigger.start + token.length + 1;
      setTrigger(null);
      setSuggestions([]);
      onChange(nextValue, nextCursor);
    },
    [onChange, queryClient],
  );

  const dismiss = useCallback(() => {
    setTrigger(null);
    setSuggestions([]);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!trigger || suggestions.length === 0) return false;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % suggestions.length);
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insertSuggestion(suggestions[activeIndex] || suggestions[0]);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        dismiss();
        return true;
      }
      return false;
    },
    [trigger, suggestions, activeIndex, insertSuggestion, dismiss],
  );

  return {
    trigger,
    suggestions,
    isLoading,
    activeIndex,
    setActiveIndex,
    insertSuggestion,
    dismiss,
    handleKeyDown,
    handleInputChange,
  };
}
