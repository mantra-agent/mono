import { useCallback, useRef, useState } from "react";
import { EditableReferenceInput, type EditableReferenceInputHandle } from "@/components/references/editable-reference-input";
import { MentionPopover } from "@/components/mention-popover";
import { useMentionAutocomplete } from "@/hooks/use-mention-autocomplete";

export function CompanyReferenceField({ value, onCommit }: { value: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  const cursorRef = useRef(value.length);
  const inputRef = useRef<EditableReferenceInputHandle>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const handleChange = useCallback((next: string, cursor: number) => {
    setDraft(next);
    cursorRef.current = cursor;
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(cursor));
  }, []);
  const mention = useMentionAutocomplete({ value: draft, cursorPosition: cursorRef.current, onChange: handleChange, allowedTypes: ["company"] });
  return <div ref={anchorRef} className="relative w-48">
    <EditableReferenceInput ref={inputRef} value={draft} onChange={(next, cursor) => { handleChange(next, cursor); mention.handleInputChange(next, cursor); }} onCursorChange={cursor => { cursorRef.current = cursor; mention.handleInputChange(draft, cursor); }} onKeyDown={event => { if (mention.handleKeyDown(event)) return; if (event.key === "Enter") inputRef.current?.element?.blur(); if (event.key === "Escape") setDraft(value); }} onBlur={() => { window.setTimeout(() => { if (draft !== value) onCommit(draft.trim()); }, 150); }} placeholder="Company name or @company" className="h-5 min-h-5 overflow-hidden whitespace-nowrap rounded-md border border-input bg-muted/50 px-1.5 py-0 text-right text-xs leading-5" />
    <MentionPopover trigger={mention.trigger} suggestions={mention.suggestions} isLoading={mention.isLoading} activeIndex={mention.activeIndex} onSelect={mention.insertSuggestion} onHover={mention.setActiveIndex} anchorRef={anchorRef} testIdSuffix="-company" />
  </div>;
}
