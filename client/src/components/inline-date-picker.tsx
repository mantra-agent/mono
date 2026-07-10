import { useRef, type MouseEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * InlineDatePicker — the canonical inline date-editing pattern.
 *
 * Renders a trigger (date label, calendar icon, etc.) with a visually hidden
 * native date input layered behind it. Clicking the trigger opens the OS date
 * picker directly via showPicker(); choosing a date commits immediately.
 * No intermediate edit box.
 *
 * Extracted from the People profile "Met" field. Documented in DESIGN.md
 * under Components → Inputs.
 */
export function InlineDatePicker({
  value,
  onCommit,
  children,
  className,
  testId,
}: {
  /** Current date as YYYY-MM-DD, or empty/null when unset */
  value: string | null | undefined;
  /** Called with YYYY-MM-DD on selection, or null when cleared */
  onCommit: (value: string | null) => void;
  /** Trigger content: date label, calendar icon button, etc. */
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const openPicker = (e: MouseEvent) => {
    e.stopPropagation();
    const el = inputRef.current;
    if (!el) return;
    try {
      el.showPicker();
    } catch {
      el.click();
    }
  };

  return (
    <span
      className={cn("relative inline-flex cursor-pointer", className)}
      onClick={openPicker}
      data-testid={testId}
    >
      {children}
      <input
        ref={inputRef}
        type="date"
        value={value || ""}
        onChange={(e) => onCommit(e.target.value || null)}
        onClick={(e) => e.stopPropagation()}
        className="pointer-events-none absolute inset-0 h-full w-full opacity-0"
        tabIndex={-1}
        aria-hidden="true"
      />
    </span>
  );
}
