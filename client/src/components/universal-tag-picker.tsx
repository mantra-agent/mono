import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Check, Plus, Tag, X } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";

interface TagIndex {
  tags: Record<string, { slug: string; label: string; color?: string | null }>;
  usages?: Record<string, unknown>;
  coOccurrences?: Record<string, unknown>;
}

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

function normalizeTagIndex(data: TagIndex | string[] | undefined | null): { slug: string; label: string }[] {
  if (!data) return [];
  if (Array.isArray(data)) {
    return data
      .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
      .map((label) => ({ slug: label, label }));
  }
  return Object.values(data.tags || {}).map((t) => ({
    slug: t.slug,
    label: t.label || t.slug,
  }));
}

function useCanonicalTags(selected: string[]) {
  const { data: tagIndex } = useQuery<TagIndex | string[]>({
    queryKey: ["/api/tags"],
  });

  const knownTags = useMemo(() => {
    const fromIndex = normalizeTagIndex(tagIndex);
    const byKey = new Map<string, { slug: string; label: string }>();
    for (const tag of fromIndex) {
      byKey.set(tag.label.toLowerCase(), tag);
      byKey.set(tag.slug.toLowerCase(), tag);
    }
    for (const label of selected) {
      const key = label.toLowerCase();
      if (!byKey.has(key)) {
        byKey.set(key, { slug: label, label });
      }
    }
    return Array.from(byKey.values())
      .filter((tag, index, arr) => arr.findIndex((t) => t.label.toLowerCase() === tag.label.toLowerCase()) === index)
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [tagIndex, selected]);

  const createTag = useMutation({
    mutationFn: async (label: string) => {
      await apiRequest("POST", "/api/tags", { label });
      return label;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tags"] });
    },
  });

  return { knownTags, createTag };
}

function selectedHas(selected: string[], candidate: string): boolean {
  const key = candidate.toLowerCase();
  return selected.some((t) => t.toLowerCase() === key);
}

function toggleSelected(selected: string[], candidate: string): string[] {
  if (selectedHas(selected, candidate)) {
    return selected.filter((t) => t.toLowerCase() !== candidate.toLowerCase());
  }
  return [...selected, candidate];
}

function removeSelected(selected: string[], candidate: string): string[] {
  return selected.filter((t) => t.toLowerCase() !== candidate.toLowerCase());
}

function TagSuggestions({
  input,
  knownTags,
  selected,
  onPick,
  onCreate,
  testId,
  dense,
}: {
  input: string;
  knownTags: { slug: string; label: string }[];
  selected: string[];
  onPick: (label: string) => void;
  onCreate: (label: string) => void;
  testId?: string;
  dense?: boolean;
}) {
  const q = input.trim().toLowerCase();
  if (!q) return null;

  const matches = knownTags
    .filter((t) => t.label.toLowerCase().includes(q) && !selectedHas(selected, t.label))
    .slice(0, 8);
  const exactExists = knownTags.some((t) => t.label.toLowerCase() === q);
  const showCreate = !exactExists && !selectedHas(selected, input.trim());

  if (matches.length === 0 && !showCreate) return null;

  return (
    <div
      className={cn(
        "absolute left-0 right-0 z-50 mt-1 rounded-md border bg-popover shadow-md overflow-hidden",
        dense ? "max-h-40" : "max-h-48",
      )}
      data-testid={testId ? `${testId}-suggestions` : undefined}
    >
      {matches.map((tag) => (
        <button
          key={tag.slug}
          type="button"
          className={cn(
            "w-full text-left hover-elevate flex items-center gap-2",
            dense ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-sm",
          )}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(tag.label);
          }}
        >
          <Tag className="h-3 w-3 text-muted-foreground shrink-0" />
          <span className="truncate">{tag.label}</span>
        </button>
      ))}
      {showCreate && (
        <button
          type="button"
          className={cn(
            "w-full text-left hover-elevate flex items-center gap-2 text-muted-foreground",
            dense ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-sm",
          )}
          onMouseDown={(e) => {
            e.preventDefault();
            onCreate(input.trim());
          }}
        >
          <Plus className="h-3 w-3 shrink-0" />
          <span className="truncate">Create "{input.trim()}"</span>
        </button>
      )}
    </div>
  );
}

function InlineOrCompactPicker({
  selected,
  onChange,
  placeholder,
  className,
  testId,
  dense,
}: {
  selected: string[];
  onChange: (tags: string[]) => void;
  placeholder: string;
  className?: string;
  testId?: string;
  dense: boolean;
}) {
  const [input, setInput] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { knownTags, createTag } = useCanonicalTags(selected);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const commit = useCallback(
    (raw: string) => {
      const label = raw.trim();
      if (!label) return;
      if (!selectedHas(selected, label)) {
        onChange([...selected, label]);
      }
      if (!knownTags.some((t) => t.label.toLowerCase() === label.toLowerCase())) {
        createTag.mutate(label);
      }
      setInput("");
      setShowSuggestions(false);
    },
    [selected, onChange, knownTags, createTag],
  );

  return (
    <div ref={containerRef} className={cn("relative", className)} data-testid={testId}>
      <div className={cn("flex flex-wrap items-center", dense ? "gap-1" : "gap-1.5")}>
        {selected.map((tag) => (
          <Badge
            key={tag}
            variant="secondary"
            className={cn(
              "gap-1 font-normal",
              dense ? "h-5 px-1.5 text-[10px]" : "text-xs",
            )}
          >
            {tag}
            <button
              type="button"
              className="ml-0.5 rounded-full hover:bg-muted-foreground/20"
              onClick={() => onChange(removeSelected(selected, tag))}
              aria-label={`Remove ${tag}`}
            >
              <X className={dense ? "h-2.5 w-2.5" : "h-3 w-3"} />
            </button>
          </Badge>
        ))}
        <Input
          ref={inputRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setShowSuggestions(true);
          }}
          onFocus={() => setShowSuggestions(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              commit(input);
            } else if (e.key === "Backspace" && !input && selected.length > 0) {
              onChange(selected.slice(0, -1));
            } else if (e.key === "Escape") {
              setShowSuggestions(false);
            }
          }}
          placeholder={selected.length === 0 ? placeholder : dense ? "Add…" : "Add tag…"}
          className={cn(
            "border-0 shadow-none focus-visible:ring-0 px-1 bg-transparent",
            dense ? "h-6 min-w-[4.5rem] flex-1 text-xs" : "h-7 min-w-[7rem] flex-1 text-sm",
          )}
          data-testid={testId ? `${testId}-input` : undefined}
        />
      </div>
      {showSuggestions && (
        <TagSuggestions
          input={input}
          knownTags={knownTags}
          selected={selected}
          onPick={(label) => commit(label)}
          onCreate={(label) => commit(label)}
          testId={testId}
          dense={dense}
        />
      )}
    </div>
  );
}

function MenuTagPicker({
  selected,
  onChange,
  testId,
}: {
  selected: string[];
  onChange: (tags: string[]) => void;
  testId?: string;
}) {
  const [newTagInput, setNewTagInput] = useState("");
  const { knownTags, createTag } = useCanonicalTags(selected);
  const merged = useMemo(() => {
    const labels = new Map<string, string>();
    for (const tag of knownTags) labels.set(tag.label.toLowerCase(), tag.label);
    for (const tag of selected) {
      const key = tag.toLowerCase();
      if (!labels.has(key)) labels.set(key, tag);
    }
    return Array.from(labels.values()).sort((a, b) => a.localeCompare(b));
  }, [knownTags, selected]);

  const handleCreate = () => {
    const label = newTagInput.trim();
    if (!label) return;
    if (!selectedHas(selected, label)) {
      onChange([...selected, label]);
    }
    if (!knownTags.some((t) => t.label.toLowerCase() === label.toLowerCase())) {
      createTag.mutate(label);
    }
    setNewTagInput("");
  };

  return (
    <div data-testid={testId}>
      {merged.map((tag) => {
        const isSelected = selectedHas(selected, tag);
        return (
          <DropdownMenuItem
            key={tag}
            onSelect={(e) => {
              e.preventDefault();
              onChange(toggleSelected(selected, tag));
            }}
            className="gap-2 text-xs"
          >
            <div
              className={cn(
                "h-3.5 w-3.5 rounded-sm border flex items-center justify-center shrink-0",
                isSelected ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/40",
              )}
            >
              {isSelected && <Check className="h-2.5 w-2.5" />}
            </div>
            {tag}
          </DropdownMenuItem>
        );
      })}
      {merged.length > 0 && <DropdownMenuSeparator />}
      <div className="flex items-center gap-1 px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
        <Input
          value={newTagInput}
          onChange={(e) => setNewTagInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              handleCreate();
            }
          }}
          placeholder="New tag…"
          className="h-6 text-xs"
          data-testid={testId ? `${testId}-new-input` : undefined}
        />
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6 shrink-0"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            handleCreate();
          }}
          disabled={!newTagInput.trim()}
        >
          <Plus className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}

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

  if (variant === "menu") {
    return <MenuTagPicker selected={value} onChange={onChange} testId={resolvedTestId} />;
  }

  return (
    <InlineOrCompactPicker
      selected={value}
      onChange={onChange}
      placeholder={placeholder}
      className={className}
      testId={resolvedTestId}
      dense={variant === "compact"}
    />
  );
}
