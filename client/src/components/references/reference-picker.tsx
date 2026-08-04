import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Plus, Search, X } from "lucide-react";
import type { ReferenceType } from "@shared/references";
import { serializeReference } from "@shared/references";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { ReferenceSuggestionRow } from "@/components/references/reference-suggestion-row";
import { resolveReference } from "@/components/references/reference-registry";
import {
  loadReferenceSuggestions,
  type ReferenceSuggestion,
} from "@/lib/reference-search";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

export type ReferencePickerValue = ReferenceSuggestion;

export type ReferencePickerProps = {
  /** Controlled multi-select values. Prefer object form; strings are treated as tags. */
  value?: Array<ReferencePickerValue | string>;
  onChange?: (next: ReferencePickerValue[]) => void;
  /** Restrict searchable types. Defaults to all types the search path covers. */
  types?: ReferenceType[];
  /** multi (default) or single select. */
  mode?: "multi" | "single";
  /** inline field (default), compact, or menu checklist (tag-only). */
  variant?: "inline" | "compact" | "menu";
  /** Allow creating a new tag when types includes tag (or is unrestricted). */
  allowCreate?: boolean;
  placeholder?: string;
  className?: string;
  testId?: string;
  dense?: boolean;
  /** Show canonical token on suggestion rows (Design playground). */
  showToken?: boolean;
  disabled?: boolean;
};

interface TagIndex {
  tags: Record<string, { slug: string; label: string; color?: string | null }>;
}

function normalizeIncoming(value?: Array<ReferencePickerValue | string>): ReferencePickerValue[] {
  if (!value?.length) return [];
  const out: ReferencePickerValue[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const suggestion: ReferencePickerValue =
      typeof item === "string"
        ? { type: "tag", id: item, label: item }
        : item;
    if (!suggestion.id) continue;
    const key = `${suggestion.type}:${suggestion.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(suggestion);
  }
  return out;
}

function selectedHas(selected: ReferencePickerValue[], candidate: ReferencePickerValue): boolean {
  const key = `${candidate.type}:${candidate.id}`.toLowerCase();
  return selected.some((s) => `${s.type}:${s.id}`.toLowerCase() === key);
}

function selectedHasLabel(selected: ReferencePickerValue[], label: string): boolean {
  const key = label.toLowerCase();
  return selected.some((s) => s.label.toLowerCase() === key || s.id.toLowerCase() === key);
}

function removeSelected(
  selected: ReferencePickerValue[],
  candidate: ReferencePickerValue,
): ReferencePickerValue[] {
  const key = `${candidate.type}:${candidate.id}`.toLowerCase();
  return selected.filter((s) => `${s.type}:${s.id}`.toLowerCase() !== key);
}

function useDebouncedReferenceSearch(
  query: string,
  types: ReferenceType[] | undefined,
  enabled: boolean,
) {
  const [suggestions, setSuggestions] = useState<ReferenceSuggestion[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const typesKey = types?.join(",") || "";

  useEffect(() => {
    if (!enabled) {
      setSuggestions([]);
      setIsLoading(false);
      return;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      setIsLoading(true);
      loadReferenceSuggestions({
        query: query.trim(),
        signal: controller.signal,
        allowedTypes: types,
        triggerChar: "@",
      })
        .then((results) => {
          if (!controller.signal.aborted) setSuggestions(results);
        })
        .catch((error) => {
          if (error?.name !== "AbortError") setSuggestions([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) setIsLoading(false);
        });
    }, 120);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [query, typesKey, enabled, types]);

  return { suggestions, isLoading };
}

function useTagCreate() {
  return useMutation({
    mutationFn: async (label: string) => {
      await apiRequest("POST", "/api/tags", { label });
      return label;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tags"] });
    },
  });
}

function FieldPicker({
  value,
  onChange,
  types,
  mode,
  placeholder,
  className,
  testId,
  dense,
  showToken,
  allowCreate,
  disabled,
}: Required<
  Pick<
    ReferencePickerProps,
    | "mode"
    | "placeholder"
    | "dense"
    | "showToken"
    | "allowCreate"
    | "disabled"
  >
> & {
  value: ReferencePickerValue[];
  onChange: (next: ReferencePickerValue[]) => void;
  types?: ReferenceType[];
  className?: string;
  testId?: string;
}) {
  const [input, setInput] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const createTag = useTagCreate();
  const tagOnly = !!types?.length && types.every((t) => t === "tag");
  const canCreateTag =
    allowCreate && (!types?.length || types.includes("tag")) && input.trim().length > 0;

  const { suggestions, isLoading } = useDebouncedReferenceSearch(input, types, open);

  const visible = useMemo(() => {
    return suggestions.filter((s) => !selectedHas(value, s));
  }, [suggestions, value]);

  const exactTagExists = visible.some(
    (s) => s.type === "tag" && s.label.toLowerCase() === input.trim().toLowerCase(),
  );
  const showCreate =
    canCreateTag &&
    !exactTagExists &&
    !selectedHasLabel(value, input.trim());

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    setActiveIndex(0);
  }, [input, visible.length, showCreate]);

  const commit = useCallback(
    (suggestion: ReferencePickerValue) => {
      if (mode === "single") {
        onChange([suggestion]);
      } else if (!selectedHas(value, suggestion)) {
        onChange([...value, suggestion]);
      }
      setInput("");
      setOpen(false);
    },
    [mode, onChange, value],
  );

  const commitCreate = useCallback(() => {
    const label = input.trim();
    if (!label) return;
    createTag.mutate(label);
    commit({ type: "tag", id: label, label, description: "New tag" });
  }, [input, createTag, commit]);

  const totalOptions = visible.length + (showCreate ? 1 : 0);

  return (
    <div ref={containerRef} className={cn("relative", className)} data-testid={testId}>
      <div className={cn("flex flex-wrap items-center", dense ? "gap-1" : "gap-1.5")}>
        {value.map((item) =>
          tagOnly ? (
            <Badge
              key={`${item.type}:${item.id}`}
              variant="secondary"
              className={cn("gap-1 font-normal", dense ? "h-5 px-1.5 text-[10px]" : "text-xs")}
            >
              {item.label}
              {!disabled && (
                <button
                  type="button"
                  className="ml-0.5 rounded-full hover:bg-muted-foreground/20"
                  onClick={() => onChange(removeSelected(value, item))}
                  aria-label={`Remove ${item.label}`}
                >
                  <X className={dense ? "h-2.5 w-2.5" : "h-3 w-3"} />
                </button>
              )}
            </Badge>
          ) : (
            <span
              key={`${item.type}:${item.id}`}
              className="inline-flex items-center gap-0.5 rounded-full border border-border/70 bg-muted/40 pl-2 pr-1 py-0.5 text-xs"
            >
              {(() => {
                const resolved = resolveReference({
                  type: item.type,
                  id: item.id,
                  canonical: serializeReference({ type: item.type, id: item.id }),
                  metadata: { label: item.label },
                });
                const Icon = resolved.Icon;
                return (
                  <>
                    <Icon className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="max-w-[10rem] truncate font-medium">{item.label}</span>
                  </>
                );
              })()}
              {!disabled && (
                <button
                  type="button"
                  className="rounded-full p-0.5 text-muted-foreground hover:bg-muted-foreground/20"
                  onClick={() => onChange(removeSelected(value, item))}
                  aria-label={`Remove ${item.label}`}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </span>
          ),
        )}
        <Input
          value={input}
          disabled={disabled}
          onChange={(e) => {
            setInput(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && totalOptions > 0) {
              e.preventDefault();
              setActiveIndex((i) => (i + 1) % totalOptions);
              return;
            }
            if (e.key === "ArrowUp" && totalOptions > 0) {
              e.preventDefault();
              setActiveIndex((i) => (i - 1 + totalOptions) % totalOptions);
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              if (totalOptions > 0) {
                e.preventDefault();
                if (showCreate && activeIndex === visible.length) {
                  commitCreate();
                } else if (visible[activeIndex]) {
                  commit(visible[activeIndex]);
                }
                return;
              }
              if (showCreate) {
                e.preventDefault();
                commitCreate();
              }
              return;
            }
            if (e.key === "," && tagOnly) {
              e.preventDefault();
              if (showCreate) commitCreate();
              return;
            }
            if (e.key === "Backspace" && !input && value.length > 0) {
              onChange(value.slice(0, -1));
              return;
            }
            if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          placeholder={value.length === 0 ? placeholder : dense ? "Add…" : "Add reference…"}
          className={cn(
            "border-0 shadow-none focus-visible:ring-0 px-1 bg-transparent",
            dense ? "h-6 min-w-[4.5rem] flex-1 text-xs" : "h-7 min-w-[7rem] flex-1 text-sm",
          )}
          data-testid={testId ? `${testId}-input` : undefined}
        />
      </div>

      {open && (isLoading || visible.length > 0 || showCreate) && (
        <div
          className={cn(
            "absolute left-0 right-0 z-50 mt-1 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md",
            dense ? "max-h-48" : "max-h-56",
          )}
          data-testid={testId ? `${testId}-suggestions` : undefined}
        >
          <div className="flex items-center gap-2 border-b border-border/60 px-2 py-1.5 text-xs text-muted-foreground">
            <Search className="h-3 w-3" />
            <span>{input.trim() ? `Matching “${input.trim()}”` : "Search references"}</span>
          </div>
          <div className="max-h-48 overflow-y-auto py-0.5">
            {isLoading && visible.length === 0 && !showCreate ? (
              <div className="px-3 py-2 text-sm text-muted-foreground">Searching…</div>
            ) : (
              <>
                {visible.map((suggestion, index) => (
                  <ReferenceSuggestionRow
                    key={`${suggestion.type}:${suggestion.id}`}
                    suggestion={suggestion}
                    active={index === activeIndex}
                    dense={dense}
                    showToken={showToken}
                    onSelect={commit}
                    onHover={() => setActiveIndex(index)}
                  />
                ))}
                {showCreate && (
                  <button
                    type="button"
                    className={cn(
                      "flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors",
                      activeIndex === visible.length ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
                    )}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      commitCreate();
                    }}
                    onMouseEnter={() => setActiveIndex(visible.length)}
                  >
                    <Plus className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">Create tag “{input.trim()}”</span>
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function MenuTagPicker({
  value,
  onChange,
  testId,
  disabled,
}: {
  value: ReferencePickerValue[];
  onChange: (next: ReferencePickerValue[]) => void;
  testId?: string;
  disabled?: boolean;
}) {
  const [newTagInput, setNewTagInput] = useState("");
  const createTag = useTagCreate();
  const { data: tagIndex } = useQuery<TagIndex | string[]>({
    queryKey: ["/api/tags"],
  });

  const merged = useMemo(() => {
    const labels = new Map<string, string>();
    if (Array.isArray(tagIndex)) {
      for (const label of tagIndex) {
        if (typeof label === "string" && label.trim()) labels.set(label.toLowerCase(), label);
      }
    } else {
      for (const tag of Object.values(tagIndex?.tags || {})) {
        labels.set((tag.label || tag.slug).toLowerCase(), tag.label || tag.slug);
      }
    }
    for (const item of value) {
      labels.set(item.label.toLowerCase(), item.label);
    }
    return Array.from(labels.values()).sort((a, b) => a.localeCompare(b));
  }, [tagIndex, value]);

  const handleCreate = () => {
    const label = newTagInput.trim();
    if (!label || disabled) return;
    if (!selectedHasLabel(value, label)) {
      onChange([...value, { type: "tag", id: label, label }]);
    }
    createTag.mutate(label);
    setNewTagInput("");
  };

  return (
    <div data-testid={testId}>
      {merged.map((tag) => {
        const item: ReferencePickerValue = { type: "tag", id: tag, label: tag };
        const isSelected = selectedHasLabel(value, tag);
        return (
          <DropdownMenuItem
            key={tag}
            disabled={disabled}
            onSelect={(e) => {
              e.preventDefault();
              if (isSelected) {
                onChange(value.filter((v) => v.label.toLowerCase() !== tag.toLowerCase()));
              } else {
                onChange([...value, item]);
              }
            }}
            className="gap-2 text-xs"
          >
            <div
              className={cn(
                "h-3.5 w-3.5 rounded-sm border flex items-center justify-center shrink-0",
                isSelected
                  ? "bg-primary border-primary text-primary-foreground"
                  : "border-muted-foreground/40",
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
          disabled={disabled}
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
          disabled={disabled || !newTagInput.trim()}
        >
          <Plus className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}

/**
 * Universal reference picker — one control for @anything.
 * Field mode searches the shared reference index; tag-locked mode keeps
 * badge UX and optional create. Menu mode is tag checklist for existing menus.
 */
export function ReferencePicker({
  value,
  onChange,
  types,
  mode = "multi",
  variant = "inline",
  allowCreate = false,
  placeholder = "Add reference…",
  className,
  testId,
  dense,
  showToken = false,
  disabled = false,
}: ReferencePickerProps) {
  const selected = normalizeIncoming(value);
  const handleChange = onChange ?? (() => undefined);
  const isDense = dense ?? variant === "compact";

  if (variant === "menu") {
    return (
      <MenuTagPicker
        value={selected}
        onChange={handleChange}
        testId={testId}
        disabled={disabled}
      />
    );
  }

  return (
    <FieldPicker
      value={selected}
      onChange={handleChange}
      types={types}
      mode={mode}
      placeholder={placeholder}
      className={className}
      testId={testId}
      dense={isDense}
      showToken={showToken}
      allowCreate={allowCreate}
      disabled={disabled}
    />
  );
}

/** Convenience: tag labels in / labels out, backed by ReferencePicker. */
export function tagsToReferenceValues(tags: string[]): ReferencePickerValue[] {
  return tags.map((label) => ({ type: "tag" as const, id: label, label }));
}

export function referenceValuesToTags(values: ReferencePickerValue[]): string[] {
  return values.filter((v) => v.type === "tag").map((v) => v.label);
}
