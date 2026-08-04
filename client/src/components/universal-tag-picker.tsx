import {
  ReferencePicker,
  referenceValuesToTags,
  tagsToReferenceValues,
} from "@/components/references/reference-picker";

export interface UniversalTagPickerProps {
  /** Canonical selected tags. Prefer this over the legacy `tags` alias. */
  selected?: string[];
  /** @deprecated Use `selected`. Kept for existing Goal surfaces. */
  tags?: string[];
  onChange: (tags: string[]) => void;
  /** inline = badge row + input (forms). compact = dense badge row + input (popovers). menu = dropdown checklist. */
  variant?: "inline" | "compact" | "menu";
  placeholder?: string;
  className?: string;
  testId?: string;
  /** @deprecated Use `testId`. Kept for existing Goal surfaces. */
  "data-testid"?: string;
}

/**
 * Tag-locked facade over ReferencePicker.
 * Prefer ReferencePicker directly for multi-type or single-select use.
 */
export function UniversalTagPicker({
  selected,
  tags,
  onChange,
  variant = "inline",
  placeholder = "Add tag…",
  className,
  testId,
  "data-testid": dataTestId,
}: UniversalTagPickerProps) {
  const value = selected ?? tags ?? [];
  const resolvedTestId = testId ?? dataTestId;
  const pickerVariant = variant === "menu" ? "menu" : "inline";
  const dense = variant === "compact";

  return (
    <ReferencePicker
      value={tagsToReferenceValues(value)}
      onChange={(next) => onChange(referenceValuesToTags(next))}
      types={["tag"]}
      mode="multi"
      variant={pickerVariant}
      allowCreate
      placeholder={placeholder}
      className={className}
      testId={resolvedTestId}
      dense={dense}
    />
  );
}
