import { cn } from "@/lib/utils";
import { forwardRef, useImperativeHandle, useRef, useState } from "react";

/**
 * Imperative handle so surfaces with an external "Rename" affordance (e.g. a
 * titlebar dropdown menu) can start editing without duplicating edit state.
 */
export interface EditableSessionTitleHandle {
  startEditing: () => void;
}

interface EditableSessionTitleProps {
  /** Current persisted title text. */
  title: string;
  /** Whether the title may be edited (a real, persisted session is active). */
  canEdit: boolean;
  /** Commit a trimmed, changed title. Only called when the value actually changed. */
  onCommit: (nextTitle: string) => void;
  /** Extra classes for the rest (span) presentation. */
  className?: string;
  /** Streaming sessions render the title in the active accent while not editing. */
  isStreaming?: boolean;
}

/**
 * Tap-to-edit session title. Single source of truth for the inline session
 * rename control shared by the Session Window mobile header and the transcript
 * panel titlebar. Renders a truncating span at rest; a tap (when editable)
 * swaps it for an input that commits on Enter/blur and cancels on Escape.
 */
export const EditableSessionTitle = forwardRef<
  EditableSessionTitleHandle,
  EditableSessionTitleProps
>(function EditableSessionTitle(
  { title, canEdit, onCommit, className, isStreaming },
  ref,
) {
  const [isEditing, setIsEditing] = useState(false);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);

  const startEditing = () => {
    if (!canEdit) return;
    committedRef.current = false;
    setValue(title);
    setIsEditing(true);
    setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 0);
  };

  useImperativeHandle(ref, () => ({ startEditing }), [canEdit, title]);

  const commit = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    const trimmed = value.trim();
    if (trimmed && trimmed !== title) onCommit(trimmed);
    setIsEditing(false);
  };

  if (isEditing) {
    return (
      <input
        ref={inputRef}
        className="text-sm font-medium bg-transparent border border-border rounded px-1.5 py-0.5 outline-none focus-visible:ring-1 focus-visible:ring-ring min-w-0 flex-1"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            committedRef.current = true;
            setIsEditing(false);
          }
        }}
        onBlur={commit}
        data-testid="input-title-rename"
      />
    );
  }

  return (
    <span
      className={cn(
        "text-sm font-medium truncate",
        canEdit && "cursor-pointer hover:underline",
        isStreaming && "text-active",
        className,
      )}
      onClick={startEditing}
      title={title}
      data-testid="text-chat-title"
    >
      {title}
    </span>
  );
});
