import { useEffect, useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface ExpandedDescriptionEditorProps {
  value: string | null | undefined;
  onSave: (value: string) => void;
  placeholder: string;
  testIdPrefix: string;
}

export function ExpandedDescriptionEditor({
  value,
  onSave,
  placeholder,
  testIdPrefix,
}: ExpandedDescriptionEditorProps) {
  const normalizedValue = value || "";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(normalizedValue);

  useEffect(() => {
    if (!editing) setDraft(normalizedValue);
  }, [editing, normalizedValue]);

  const save = () => {
    const nextValue = draft.trim();
    if (nextValue !== normalizedValue) onSave(nextValue);
    setEditing(false);
  };

  if (editing) {
    return (
      <Textarea
        value={draft}
        onChange={event => setDraft(event.target.value)}
        onBlur={save}
        onKeyDown={event => {
          if (event.key === "Escape") {
            setDraft(normalizedValue);
            setEditing(false);
          }
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") save();
        }}
        placeholder={placeholder}
        className="min-h-16 resize-none border-0 bg-transparent p-0 text-sm leading-relaxed shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
        autoFocus
        data-testid={`textarea-${testIdPrefix}`}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        setDraft(normalizedValue);
        setEditing(true);
      }}
      className={cn(
        "block w-full rounded-sm text-left text-sm leading-relaxed hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        normalizedValue.trim() ? "text-muted-foreground" : "text-muted-foreground/50",
      )}
      data-testid={`button-edit-${testIdPrefix}`}
    >
      {normalizedValue.trim() || placeholder}
    </button>
  );
}
