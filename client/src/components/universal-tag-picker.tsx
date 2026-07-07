import { useState, useRef, useEffect, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { X, Tag, Plus } from "lucide-react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { Tag as TagModel } from "@shared/schema";

interface UniversalTagPickerProps {
  tags: string[];
  onChange: (tags: string[]) => void;
  autoTags?: string[];
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  "data-testid"?: string;
}

export function UniversalTagPicker({
  tags,
  onChange,
  autoTags = [],
  placeholder = "Add tag...",
  className = "",
  disabled = false,
  "data-testid": testId,
}: UniversalTagPickerProps) {
  const [input, setInput] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: tagData } = useQuery<{ tags: TagModel[] }>({
    queryKey: ["/api/tags"],
  });

  const createTagMutation = useMutation({
    mutationFn: async (label: string) => {
      const res = await apiRequest("POST", "/api/tags", { label });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tags"] });
    },
  });

  const allRegistryTags = tagData?.tags ?? [];

  const suggestions = input.trim()
    ? allRegistryTags
        .filter(
          (t) =>
            !tags.includes(t.slug) &&
            !autoTags.includes(t.slug) &&
            (t.label.includes(input.toLowerCase()) ||
              t.slug.includes(input.toLowerCase()) ||
              t.aliases.some((a) => a.includes(input.toLowerCase())))
        )
        .slice(0, 8)
    : [];

  const inputNormalized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-");
  const isNewTag =
    input.trim().length > 0 &&
    !allRegistryTags.some(
      (t) =>
        t.slug === inputNormalized ||
        t.label === input.trim().toLowerCase()
    ) &&
    !tags.includes(inputNormalized);

  const addTag = useCallback(
    async (slug: string, label?: string) => {
      if (tags.includes(slug) || autoTags.includes(slug)) return;
      const exists = allRegistryTags.some((t) => t.slug === slug);
      if (!exists && label) {
        await createTagMutation.mutateAsync(label);
      }
      onChange([...tags, slug]);
      setInput("");
      setShowSuggestions(false);
    },
    [tags, autoTags, allRegistryTags, onChange, createTagMutation]
  );

  const removeTag = useCallback(
    (slug: string) => {
      onChange(tags.filter((t) => t !== slug));
    },
    [tags, onChange]
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (suggestions.length > 0) {
        addTag(suggestions[0].slug);
      } else if (isNewTag && inputNormalized) {
        addTag(inputNormalized, input.trim());
      }
    } else if (e.key === "Backspace" && !input && tags.length > 0) {
      removeTag(tags[tags.length - 1]);
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
      inputRef.current?.blur();
    }
  };

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const getTagLabel = (slug: string) => {
    const found = allRegistryTags.find((t) => t.slug === slug);
    return found?.label ?? slug;
  };

  return (
    <div ref={containerRef} className={`relative ${className}`} data-testid={testId}>
      <div className="flex flex-wrap gap-1 mb-1.5">
        {tags.map((slug) => (
          <Badge
            key={slug}
            variant="secondary"
            className="text-xs gap-1 pr-1"
            data-testid={`tag-manual-${slug}`}
          >
            {getTagLabel(slug)}
            {!disabled && (
              <button
                type="button"
                className="ml-0.5 hover:text-destructive"
                onClick={() => removeTag(slug)}
                data-testid={`button-remove-tag-${slug}`}
              >
                <X className="h-2.5 w-2.5" />
              </button>
            )}
          </Badge>
        ))}
        {autoTags.map((slug) => (
          <Badge
            key={`auto-${slug}`}
            variant="outline"
            className="text-xs no-default-hover-elevate opacity-70"
            data-testid={`tag-auto-${slug}`}
          >
            {getTagLabel(slug)}
          </Badge>
        ))}
      </div>
      {!disabled && (
        <div className="relative">
          <div className="flex gap-2">
            <Input
              ref={inputRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setShowSuggestions(true);
              }}
              onFocus={() => setShowSuggestions(true)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              className="text-sm"
              data-testid="input-tag-search"
            />
          </div>
          {showSuggestions && (suggestions.length > 0 || isNewTag) && (
            <div className="absolute z-50 top-full mt-1 w-full bg-popover border border-border rounded-md shadow-md max-h-48 overflow-y-auto">
              {suggestions.map((tag) => (
                <button
                  key={tag.slug}
                  type="button"
                  className="w-full text-left px-3 py-1.5 text-sm hover-elevate flex items-center gap-2"
                  onClick={() => addTag(tag.slug)}
                  data-testid={`suggestion-tag-${tag.slug}`}
                >
                  <Tag className="h-3 w-3 text-muted-foreground shrink-0" />
                  <span>{tag.label}</span>
                  <span className="text-xs text-muted-foreground ml-auto">
                    {tag.usageCount}
                  </span>
                </button>
              ))}
              {isNewTag && (
                <button
                  type="button"
                  className="w-full text-left px-3 py-1.5 text-sm hover-elevate flex items-center gap-2 border-t border-border"
                  onClick={() => addTag(inputNormalized, input.trim())}
                  data-testid="button-create-new-tag"
                >
                  <Plus className="h-3 w-3 text-primary shrink-0" />
                  <span>
                    Create <span className="font-medium">"{input.trim()}"</span>
                  </span>
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
