import { type MouseEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * InlineDatePicker — the canonical inline date-editing pattern.
 *
 * Renders a trigger (date label, calendar icon, etc.) with an invisible
 * native date input layered on top as the actual tap/click target. A direct
 * user gesture on the input opens the OS picker natively on mobile (iOS
 * ignores programmatic showPicker/click on hidden inputs); on desktop the
 * same gesture calls showPicker() so the calendar opens immediately.
 * Choosing a date commits immediately. No intermediate edit box.
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
  const openPicker = (e: MouseEvent<HTMLInputElement>) => {
    e.stopPropagation();
    try {
      e.currentTarget.showPicker();
    } catch {
      // Mobile browsers open the native picker from the direct tap itself.
    }
  };

  return (
    <span
      className={cn("relative inline-flex cursor-pointer", className)}
      onClick={(e) => e.stopPropagation()}
      data-testid={testId}
    >
      {children}
      <input
        type="date"
        value={value || ""}
        onChange={(e) => onCommit(e.target.value || null)}
        onClick={openPicker}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        aria-label="Edit date"
      />
    </span>
  );
}
