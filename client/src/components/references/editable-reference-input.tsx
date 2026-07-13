import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { parseReferenceText } from "@shared/reference-parser";
import { ReferenceRenderer } from "./reference-renderer";

type EditableReferenceInputProps = {
  value: string;
  onChange: (value: string, cursorPosition: number) => void;
  onCursorChange?: (cursorPosition: number) => void;
  onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onPaste?: (event: React.ClipboardEvent<HTMLDivElement>) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
};

export type EditableReferenceInputHandle = {
  element: HTMLDivElement | null;
  focus: (options?: FocusOptions) => void;
  setSelectionRange: (start: number, end?: number) => void;
};

type SelectionOffsets = {
  start: number;
  end: number;
};

function extractValue(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
  if (!(node instanceof HTMLElement)) return "";
  const token = node.dataset.referenceToken;
  if (token) return token;
  let value = "";
  node.childNodes.forEach((child) => {
    value += extractValue(child);
  });
  return value;
}

function offsetForBoundary(root: HTMLElement, container: Node, boundaryOffset: number): number {
  if (!root.contains(container)) return extractValue(root).length;

  let offset = 0;
  let found = false;

  function walk(node: Node): void {
    if (found) return;

    if (node === container) {
      if (node.nodeType === Node.TEXT_NODE) {
        offset += boundaryOffset;
      } else {
        const children = Array.from(node.childNodes).slice(0, boundaryOffset);
        for (const child of children) offset += extractValue(child).length;
      }
      found = true;
      return;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      offset += node.textContent?.length || 0;
      return;
    }

    if (node instanceof HTMLElement) {
      const token = node.dataset.referenceToken;
      if (token) {
        offset += token.length;
        return;
      }
    }

    node.childNodes.forEach(walk);
  }

  root.childNodes.forEach(walk);
  return offset;
}

function selectionOffsetsWithin(root: HTMLElement): SelectionOffsets {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    const end = extractValue(root).length;
    return { start: end, end };
  }

  const range = selection.getRangeAt(0);
  const start = offsetForBoundary(root, range.startContainer, range.startOffset);
  const end = offsetForBoundary(root, range.endContainer, range.endOffset);
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function selectionOffsetWithin(root: HTMLElement): number {
  return selectionOffsetsWithin(root).end;
}

function setSelectionAtOffset(root: HTMLElement, targetOffset: number): void {
  const range = document.createRange();
  const selection = window.getSelection();
  let remaining = Math.max(0, targetOffset);
  let placed = false;

  function place(node: Node, offset: number): void {
    range.setStart(node, offset);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    placed = true;
  }

  function walk(node: Node): void {
    if (placed) return;

    if (node.nodeType === Node.TEXT_NODE) {
      const length = node.textContent?.length || 0;
      if (remaining <= length) place(node, remaining);
      else remaining -= length;
      return;
    }

    if (node instanceof HTMLElement) {
      const token = node.dataset.referenceToken;
      if (token) {
        if (remaining <= token.length) {
          const parent = node.parentNode;
          if (!parent) return;
          const index = Array.from(parent.childNodes).indexOf(node);
          place(parent, remaining <= token.length / 2 ? index : index + 1);
        } else {
          remaining -= token.length;
        }
        return;
      }
    }

    node.childNodes.forEach(walk);
  }

  root.childNodes.forEach(walk);
  if (!placed) place(root, root.childNodes.length);
}

function replaceRange(value: string, selection: SelectionOffsets, inserted: string): { value: string; cursor: number } {
  const nextValue = value.slice(0, selection.start) + inserted + value.slice(selection.end);
  return { value: nextValue, cursor: selection.start + inserted.length };
}

export const EditableReferenceInput = forwardRef<EditableReferenceInputHandle, EditableReferenceInputProps>(
  function EditableReferenceInput(
    {
      value,
      onChange,
      onCursorChange,
      onKeyDown,
      onPaste,
      onFocus,
      onBlur,
      placeholder,
      disabled,
      className,
    },
    ref,
  ) {
    const rootRef = useRef<HTMLDivElement>(null);
    const pendingSelectionRef = useRef<number | null>(null);
    const composingRef = useRef(false);
    const [domEpoch, setDomEpoch] = useState(0);
    const parts = useMemo(() => parseReferenceText(value), [value]);

    const commitValue = useCallback((nextValue: string, cursor: number) => {
      pendingSelectionRef.current = cursor;
      onChange(nextValue, cursor);
    }, [onChange]);

    const commitFromDOM = useCallback((nextValue: string, cursor: number) => {
      // The browser mutated contentEditable DOM natively (autocorrect,
      // composition). Remount the rendered parts so React never reconciles
      // against nodes it no longer owns — reconciling browser-mutated nodes
      // desyncs or crashes the commit and permanently locks the input.
      setDomEpoch((epoch) => epoch + 1);
      commitValue(nextValue, cursor);
    }, [commitValue]);

    const setSelectionRange = useCallback((start: number) => {
      pendingSelectionRef.current = start;
      const root = rootRef.current;
      if (!root || document.activeElement !== root) return;
      requestAnimationFrame(() => setSelectionAtOffset(root, start));
    }, []);

    useImperativeHandle(ref, () => ({
      element: rootRef.current,
      focus: (options?: FocusOptions) => rootRef.current?.focus(options),
      setSelectionRange,
    }), [setSelectionRange]);

    useLayoutEffect(() => {
      if (composingRef.current) return;
      const pending = pendingSelectionRef.current;
      if (pending === null) return;
      const root = rootRef.current;
      if (!root || document.activeElement !== root) return;
      pendingSelectionRef.current = null;
      setSelectionAtOffset(root, pending);
    }, [value]);

    /** Sync DOM text back to React state after composition or browser-native edits */
    const syncFromDOM = useCallback(() => {
      const root = rootRef.current;
      if (!root) return;
      const domValue = extractValue(root);
      const cursor = selectionOffsetWithin(root);
      if (domValue !== value) {
        commitFromDOM(domValue, cursor);
      }
    }, [commitFromDOM, value]);

    const handleBeforeInput = useCallback((inputEvent: InputEvent) => {
      if (disabled) return;

      const root = rootRef.current;
      if (!root) return;

      // During IME composition (autocorrect, predictive text, CJK input),
      // let the browser handle text mutations natively. We sync on compositionend.
      if (composingRef.current && inputEvent.inputType === "insertCompositionText") {
        return;
      }

      const selection = selectionOffsetsWithin(root);
      let inserted: string | null = null;

      switch (inputEvent.inputType) {
        case "insertText":
          inserted = inputEvent.data || "";
          break;
        case "insertCompositionText":
          // Not composing but got composition text (e.g. autocorrect replacement).
          // Let browser handle it natively, sync afterward.
          return;
        case "insertReplacementText": {
          // iOS/macOS Safari autocorrect and spellcheck replacements arrive
          // here (not as composition events). Apply the replacement in React
          // state so the browser never mutates React-owned DOM nodes.
          const replacement = inputEvent.data ?? inputEvent.dataTransfer?.getData("text/plain");
          const targetRange = inputEvent.getTargetRanges?.()[0];
          if (replacement === undefined || replacement === null || !targetRange) {
            // Fall back to native mutation; handleInput syncs and remounts.
            return;
          }
          inputEvent.preventDefault();
          const start = offsetForBoundary(root, targetRange.startContainer, targetRange.startOffset);
          const end = offsetForBoundary(root, targetRange.endContainer, targetRange.endOffset);
          const next = replaceRange(
            value,
            { start: Math.min(start, end), end: Math.max(start, end) },
            replacement,
          );
          commitValue(next.value, next.cursor);
          return;
        }
        case "insertLineBreak":
        case "insertParagraph":
          inserted = "\n";
          break;
        case "insertFromPaste": {
          const pastedText = inputEvent.dataTransfer?.getData("text/plain") || inputEvent.data || "";
          inputEvent.preventDefault();
          if (!pastedText) return;
          const next = replaceRange(value, selection, pastedText);
          commitValue(next.value, next.cursor);
          return;
        }
        case "deleteByCut":
        case "deleteByDrag":
        case "deleteByComposition":
        case "deleteContent":
        case "deleteContentBackward": {
          inputEvent.preventDefault();
          if (selection.start !== selection.end) {
            const next = replaceRange(value, selection, "");
            commitValue(next.value, next.cursor);
            return;
          }
          if (inputEvent.inputType !== "deleteContentBackward") return;
          const start = Math.max(0, selection.start - 1);
          const next = replaceRange(value, { start, end: selection.end }, "");
          commitValue(next.value, next.cursor);
          return;
        }
        case "deleteContentForward": {
          inputEvent.preventDefault();
          if (selection.start !== selection.end) {
            const next = replaceRange(value, selection, "");
            commitValue(next.value, next.cursor);
            return;
          }
          const end = Math.min(value.length, selection.end + 1);
          const next = replaceRange(value, { start: selection.start, end }, "");
          commitValue(next.value, next.cursor);
          return;
        }
        default:
          return;
      }

      inputEvent.preventDefault();
      const next = replaceRange(value, selection, inserted);
      commitValue(next.value, next.cursor);
    }, [commitValue, disabled, value]);

    useEffect(() => {
      const root = rootRef.current;
      if (!root) return;
      const listener = (event: Event) => handleBeforeInput(event as InputEvent);
      root.addEventListener("beforeinput", listener);
      return () => root.removeEventListener("beforeinput", listener);
    }, [handleBeforeInput]);

    /** Track IME composition lifecycle for autocorrect/predictive text support */
    useEffect(() => {
      const root = rootRef.current;
      if (!root) return;

      const onCompositionStart = () => {
        composingRef.current = true;
      };

      const onCompositionEnd = () => {
        composingRef.current = false;
        // Sync the final composed value from DOM back to React state.
        // Use rAF to ensure the browser has committed the final text.
        requestAnimationFrame(() => syncFromDOM());
      };

      root.addEventListener("compositionstart", onCompositionStart);
      root.addEventListener("compositionend", onCompositionEnd);
      return () => {
        root.removeEventListener("compositionstart", onCompositionStart);
        root.removeEventListener("compositionend", onCompositionEnd);
      };
    }, [syncFromDOM]);

    const handleInput = useCallback(() => {
      // During composition, the browser mutates the DOM directly. We don't
      // interfere here — compositionend handles the sync. For non-composition
      // native edits that slip past beforeinput, sync (and remount) from DOM.
      if (!composingRef.current) syncFromDOM();
    }, [syncFromDOM]);

    const handleBlur = useCallback(() => {
      // iOS can blur mid-composition without firing compositionend; a stuck
      // composing flag would permanently disable DOM→state sync and lock
      // the input. Clear it and sync whatever the browser left in the DOM.
      if (composingRef.current) {
        composingRef.current = false;
        syncFromDOM();
      }
      onBlur?.();
    }, [onBlur, syncFromDOM]);

    const handlePaste = useCallback((event: React.ClipboardEvent<HTMLDivElement>) => {
      onPaste?.(event);
      if (event.defaultPrevented || disabled) return;

      const text = event.clipboardData.getData("text/plain");
      if (!text) return;
      event.preventDefault();

      const root = rootRef.current;
      const selection = root ? selectionOffsetsWithin(root) : { start: value.length, end: value.length };
      const next = replaceRange(value, selection, text);
      commitValue(next.value, next.cursor);
    }, [commitValue, disabled, onPaste, value]);

    const handleSelect = useCallback(() => {
      const root = rootRef.current;
      if (!root) return;
      onCursorChange?.(selectionOffsetWithin(root));
    }, [onCursorChange]);

    return (
      <div
        ref={rootRef}
        role="textbox"
        aria-multiline="true"
        contentEditable={!disabled}
        suppressContentEditableWarning
        data-placeholder={placeholder}
        data-empty={value.length === 0 ? "true" : undefined}
        onInput={handleInput}
        onKeyUp={handleSelect}
        onMouseUp={handleSelect}
        onFocus={onFocus}
        onBlur={handleBlur}
        onKeyDown={onKeyDown}
        onPaste={handlePaste}
        className={cn(
          "editable-reference-input w-full min-h-9 whitespace-pre-wrap break-words outline-none empty:before:content-[attr(data-placeholder)]",
          disabled && "pointer-events-none cursor-not-allowed opacity-50",
          className,
        )}
      >
        {parts.map((part, index) =>
          part.kind === "text" ? (
            <span key={`${domEpoch}-${index}`}>{part.text}</span>
          ) : (
            <span
              key={`${domEpoch}-${index}`}
              contentEditable={false}
              data-reference-token={part.ref.canonical}
              className="inline-block align-baseline"
            >
              <ReferenceRenderer refValue={part.ref} surface="chat-inline" />
            </span>
          ),
        )}
      </div>
    );
  },
);
