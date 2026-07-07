import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
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

function selectionOffsetWithin(root: HTMLElement): number {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return 0;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer)) return extractValue(root).length;

  let offset = 0;
  let found = false;

  function walk(node: Node): void {
    if (found) return;

    if (node === range.startContainer) {
      if (node.nodeType === Node.TEXT_NODE) {
        offset += range.startOffset;
      } else {
        const children = Array.from(node.childNodes).slice(0, range.startOffset);
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
    const parts = useMemo(() => parseReferenceText(value), [value]);

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
      const pending = pendingSelectionRef.current;
      if (pending === null) return;
      const root = rootRef.current;
      if (!root || document.activeElement !== root) return;
      pendingSelectionRef.current = null;
      setSelectionAtOffset(root, pending);
    }, [value]);

    const emitChange = useCallback(() => {
      const root = rootRef.current;
      if (!root) return;
      const nextValue = extractValue(root);
      const cursor = selectionOffsetWithin(root);
      pendingSelectionRef.current = cursor;
      onChange(nextValue, cursor);
    }, [onChange]);

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
        onInput={emitChange}
        onKeyUp={handleSelect}
        onMouseUp={handleSelect}
        onFocus={onFocus}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        className={cn(
          "editable-reference-input w-full min-h-9 whitespace-pre-wrap break-words outline-none empty:before:content-[attr(data-placeholder)]",
          disabled && "pointer-events-none cursor-not-allowed opacity-50",
          className,
        )}
      >
        {parts.map((part, index) =>
          part.kind === "text" ? (
            <span key={index}>{part.text}</span>
          ) : (
            <span
              key={index}
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
