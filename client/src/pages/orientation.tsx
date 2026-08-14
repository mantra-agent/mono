import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { usePageHeader } from "@/hooks/use-page-header";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import {
  HIERARCHY_PRIMARY_ACTION_CLASS,
  HIERARCHY_SECTION_HEADER_CLASS,
  HIERARCHY_SESSION_ROW_CLASS,
  HIERARCHY_TREE_STACK_CLASS,
} from "@/components/hierarchy-section-header";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import {
  PROFILE_DESCRIPTION_FRAME_CLASS,
  PROFILE_DESCRIPTION_TEXT_CLASS,
} from "@/components/profile-description-style";
import { UniversalTagPicker } from "@/components/universal-tag-picker";
import { InlineReferenceText } from "@/components/references/inline-reference-text";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { normalizeTagSlug } from "@shared/models/tags";
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  Compass,
  MoreHorizontal,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";

type SectionKey = "theses" | "rules" | "principles";
type OrientationRecord = Record<string, unknown> & { id?: string | number };

interface SectionConfig {
  key: SectionKey;
  label: string;
  icon: LucideIcon;
  endpoint: string;
  title: (item: OrientationRecord) => string;
  subtitle?: (item: OrientationRecord) => string | null;
  deleteEndpoint: (item: OrientationRecord) => string;
}

const SECTION_CONFIGS: SectionConfig[] = [
  {
    key: "rules",
    deleteEndpoint: (item) => `/api/rules/${item.id}`,
    label: "Rules",
    icon: ShieldCheck,
    endpoint: "/api/rules",
    title: (item) => text(item.rule) || "Untitled rule",
  },
  {
    key: "principles",
    deleteEndpoint: (item) => `/api/principles/${item.id}`,
    label: "Principles",
    icon: Compass,
    endpoint: "/api/principles",
    title: (item) => text(item.title) || "Untitled principle",
    subtitle: (item) => text(item.layer1),
  },
  {
    key: "theses",
    deleteEndpoint: (item) => `/api/theses/${item.id}`,
    label: "Theses",
    icon: BookOpen,
    endpoint: "/api/theses",
    title: (item) => text(item.title) || "Untitled thesis",
    subtitle: (item) => text(item.statement),
  },
];

const CONNECTOR_CLASS = "border-muted-foreground/50";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

function formatValue(value: unknown): string {
  if (value == null || value === "") return "—";
  if (Array.isArray(value)) {
    if (!value.length) return "—";
    if (value.every((item) => typeof item === "string")) return value.join(", ");
    return value
      .map((item) => (typeof item === "object" ? JSON.stringify(item) : String(item)))
      .join("\n");
  }
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function searchableText(section: SectionConfig, item: OrientationRecord): string {
  const parts = [
    section.label,
    section.title(item),
    section.subtitle?.(item) ?? "",
    formatValue(item.rule),
    formatValue(item.tags),
    formatValue(item.layer1),
    formatValue(item.autoTags),
    formatValue(item.manualTags),
    formatValue(item.relatedIds),
    formatValue(item.statement),
    formatValue(item.status),
    formatValue(item.conviction),
  ];
  return parts.join(" ").toLowerCase();
}

async function fetchArray(endpoint: string): Promise<OrientationRecord[]> {
  const response = await apiRequest("GET", endpoint);
  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

function useSectionData(section: SectionConfig) {
  return useQuery<OrientationRecord[]>({
    queryKey: [section.endpoint],
    queryFn: () => fetchArray(section.endpoint),
  });
}

function uniqueTags(...groups: string[][]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const group of groups) {
    for (const tag of group) {
      const normalized = tag.trim();
      if (!normalized) continue;
      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(normalized);
    }
  }
  return result;
}

function TagChip({ tag }: { tag: string }) {
  const slug = normalizeTagSlug(tag);
  if (!slug) {
    return <span className="text-sm text-muted-foreground">{tag}</span>;
  }
  return (
    <InlineReferenceText
      text={`@tag:${slug}`}
      className="inline-flex min-w-0 max-w-full items-center [&_span]:mx-0"
    />
  );
}

function OrientationTagRow({
  tags,
  onChange,
  testId,
  editable = true,
}: {
  tags: string[];
  onChange?: (tags: string[]) => void;
  testId: string;
  editable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(tags.length);
  const summaryRef = useRef<HTMLDivElement>(null);
  const measurementRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const summary = summaryRef.current;
    const measurement = measurementRef.current;
    if (!summary || !measurement) return;

    const updateVisibleCount = () => {
      const widths = Array.from(measurement.children).map((child) => (child as HTMLElement).offsetWidth);
      const gap = 4;
      const availableWidth = summary.clientWidth;
      const allTagsWidth = widths.reduce((total, width) => total + width, 0) + Math.max(0, widths.length - 1) * gap;

      if (allTagsWidth <= availableWidth) {
        setVisibleCount(tags.length);
        return;
      }

      let occupiedWidth = 0;
      let nextVisibleCount = 0;
      for (const width of widths) {
        const nextWidth = occupiedWidth + (nextVisibleCount > 0 ? gap : 0) + width;
        if (nextWidth > availableWidth) break;
        occupiedWidth = nextWidth;
        nextVisibleCount += 1;
      }
      setVisibleCount(nextVisibleCount);
    };

    updateVisibleCount();
    const observer = new ResizeObserver(updateVisibleCount);
    observer.observe(summary);
    return () => observer.disconnect();
  }, [tags]);

  const hasOverflow = visibleCount < tags.length;
  const canEdit = editable && typeof onChange === "function";

  const row = (
    <ProfileTreeRow
      label={<span data-testid={`${testId}-label`}>Tags</span>}
      icon={<SlidersHorizontal className="h-3.5 w-3.5" />}
      hasValue={tags.length > 0}
      showEmpty
      actionContent={
        canEdit ? (
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 min-h-5 w-5 min-w-5 shrink-0 rounded px-0 text-muted-foreground/60 hover:bg-accent hover:text-foreground"
              aria-label={hasOverflow ? `Show all ${tags.length} tags` : "Edit tags"}
              data-testid={hasOverflow ? `${testId}-overflow` : `${testId}-edit`}
            >
              {hasOverflow ? <MoreHorizontal className="h-3.5 w-3.5" /> : <Plus className="h-3 w-3" />}
            </Button>
          </PopoverTrigger>
        ) : undefined
      }
      mobileLayout="inline"
      testId={testId}
    >
      <div
        ref={summaryRef}
        className="relative flex h-5 w-48 min-w-0 items-center justify-end gap-1 overflow-hidden"
        data-testid={`${testId}-summary`}
      >
        <div ref={measurementRef} aria-hidden className="pointer-events-none invisible absolute left-0 top-0 flex items-center gap-1">
          {tags.map((tag) => (
            <span key={tag} className="inline-flex shrink-0">
              <TagChip tag={tag} />
            </span>
          ))}
        </div>
        {tags.slice(0, visibleCount).map((tag) => (
          <span key={tag} className="inline-flex max-w-full shrink-0 overflow-hidden" data-testid={`${testId}-chip-${tag}`}>
            <TagChip tag={tag} />
          </span>
        ))}
      </div>
    </ProfileTreeRow>
  );

  if (!canEdit) return row;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {row}
      <PopoverContent align="end" className="w-72 p-2" onOpenAutoFocus={(event) => event.preventDefault()} data-testid={`${testId}-popover`}>
        <UniversalTagPicker
          variant="compact"
          selected={tags}
          onChange={onChange!}
          placeholder="Add tag"
          testId={`${testId}-picker`}
        />
      </PopoverContent>
    </Popover>
  );
}

function SummaryTextArea({
  value,
  onChange,
  onCommit,
  placeholder,
  testId,
  minHeightClass = "min-h-20",
}: {
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  placeholder: string;
  testId: string;
  minHeightClass?: string;
}) {
  return (
    <div className={PROFILE_DESCRIPTION_FRAME_CLASS}>
      <Textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onCommit}
        placeholder={placeholder}
        className={cn(
          minHeightClass,
          "w-full resize-none border-0 bg-transparent p-0 shadow-none outline-none ring-0 placeholder:text-muted-foreground focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 md:text-[14px]",
          PROFILE_DESCRIPTION_TEXT_CLASS,
        )}
        data-testid={testId}
      />
    </div>
  );
}

function RuleDetails({ item }: { item: OrientationRecord }) {
  const ruleId = String(item.id ?? "");
  const [ruleText, setRuleText] = useState(text(item.rule));
  const tags = asStringArray(item.tags);

  const updateMutation = useMutation({
    mutationFn: async (patch: Record<string, unknown>) => {
      const response = await apiRequest("PUT", `/api/rules/${ruleId}`, patch);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/rules"] });
    },
  });

  const commitRule = () => {
    const next = ruleText.trim();
    if (!next || next === text(item.rule)) {
      setRuleText(text(item.rule));
      return;
    }
    updateMutation.mutate({ rule: next });
  };

  return (
    <div className="space-y-0.5">
      <SummaryTextArea
        value={ruleText}
        onChange={setRuleText}
        onCommit={commitRule}
        placeholder="Rule"
        testId={`input-rule-text-${ruleId}`}
      />

      <OrientationTagRow
        tags={tags}
        testId={`row-rule-tags-${ruleId}`}
        onChange={(nextTags) => updateMutation.mutate({ tags: nextTags.length ? nextTags : undefined })}
      />
    </div>
  );
}

function PrincipleDetails({ item }: { item: OrientationRecord }) {
  const id = String(item.id ?? "");
  const [layer1, setLayer1] = useState(text(item.layer1));
  const autoTags = asStringArray(item.autoTags);
  const manualTags = asStringArray(item.manualTags);
  const tags = uniqueTags(manualTags, autoTags);

  const updateMutation = useMutation({
    mutationFn: async (patch: Record<string, unknown>) => {
      const response = await apiRequest("PUT", `/api/principles/${id}`, patch);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/principles"] });
    },
  });

  const commitLayer1 = () => {
    const next = layer1.trim();
    if (!next || next === text(item.layer1)) {
      setLayer1(text(item.layer1));
      return;
    }
    updateMutation.mutate({ layer1: next });
  };

  return (
    <div className="space-y-0.5">
      <SummaryTextArea
        value={layer1}
        onChange={setLayer1}
        onCommit={commitLayer1}
        placeholder="Principle"
        testId={`input-principle-layer1-${id}`}
        minHeightClass="min-h-32"
      />

      <OrientationTagRow
        tags={tags}
        testId={`row-principle-tags-${id}`}
        onChange={(nextTags) => {
          const nextAuto = autoTags.filter((tag) => nextTags.some((next) => next.toLowerCase() === tag.toLowerCase()));
          const nextManual = nextTags.filter(
            (tag) => !nextAuto.some((auto) => auto.toLowerCase() === tag.toLowerCase()),
          );
          updateMutation.mutate({ autoTags: nextAuto, manualTags: nextManual });
        }}
      />
    </div>
  );
}

function ThesisDetails({ item }: { item: OrientationRecord }) {
  const id = String(item.id ?? "");
  const [statement, setStatement] = useState(text(item.statement));
  const tags = asStringArray(item.tags);

  return (
    <div className="space-y-0.5">
      <SummaryTextArea
        value={statement}
        onChange={setStatement}
        onCommit={() => setStatement(text(item.statement))}
        placeholder="Statement"
        testId={`input-thesis-statement-${id}`}
      />
      <OrientationTagRow tags={tags} testId={`row-thesis-tags-${id}`} editable={false} />
    </div>
  );
}

function OrientationItemDetails({
  section,
  item,
}: {
  section: SectionConfig;
  item: OrientationRecord;
}) {
  if (section.key === "rules") return <RuleDetails item={item} />;
  if (section.key === "principles") return <PrincipleDetails item={item} />;
  return <ThesisDetails item={item} />;
}

function OrientationItemRow({ section, item }: { section: SectionConfig; item: OrientationRecord }) {
  const [expanded, setExpanded] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const deleteMutation = useMutation({
    mutationFn: async () => apiRequest("DELETE", section.deleteEndpoint(item)),
    onSuccess: () => {
      setDeleteOpen(false);
      queryClient.invalidateQueries({ queryKey: [section.endpoint] });
    },
    onError: () => setDeleteOpen(false),
  });
  const title = section.title(item);
  const Icon = section.icon;

  return (
    <div className="space-y-0.5">
      <div
        className={cn(
          HIERARCHY_SESSION_ROW_CLASS,
          "group pr-16 hover:bg-accent/50 text-foreground",
        )}
        style={{ paddingLeft: "32px" }}
        onClick={() => setExpanded((value) => !value)}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setExpanded((value) => !value);
          }
        }}
        data-testid={`row-orientation-${section.key}-${String(item.id ?? "")}`}
      >
        <span className="pointer-events-none absolute inset-y-0 left-2 w-4" aria-hidden="true">
          <span className={cn("absolute bottom-1/2 left-0 top-0 border-l", CONNECTOR_CLASS)} />
          <span className={cn("absolute left-0 top-1/2 w-4 border-t", CONNECTOR_CLASS)} />
        </span>
        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-muted-foreground">
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm">{title}</span>
        <button
          type="button"
          className="absolute right-8 top-1/2 z-10 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/60 opacity-0 transition-all group-hover:opacity-100 focus-visible:opacity-100 hover:bg-accent hover:text-foreground"
          onClick={(event) => {
            event.stopPropagation();
            setExpanded((value) => !value);
          }}
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-90")} />
        </button>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="absolute right-1 top-1/2 z-10 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/60 opacity-0 transition-all group-hover:opacity-100 focus-visible:opacity-100 hover:bg-accent hover:text-foreground"
              onClick={(event) => event.stopPropagation()}
              aria-label="Actions"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-32" onClick={(event) => event.stopPropagation()}>
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={() => setDeleteOpen(true)}
            >
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {expanded ? (
        <div className="ml-8 border-l border-border/40 pl-2">
          <OrientationItemDetails section={section} item={item} />
        </div>
      ) : null}

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete item?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete &ldquo;{title.slice(0, 80)}&rdquo;. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMutation.mutate()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function NewRuleForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [rule, setRule] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const createMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = { rule: rule.trim() };
      if (tags.length) body.tags = tags;
      const response = await apiRequest("POST", "/api/rules", body);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/rules"] });
      onCreated();
    },
  });

  const canSave = rule.trim().length > 0 && !createMutation.isPending;

  return (
    <div className="space-y-2 rounded-md border border-border/40 bg-card/30 p-2" data-testid="form-new-rule">
      <Textarea
        value={rule}
        onChange={(event) => setRule(event.target.value)}
        placeholder="Rule"
        className="min-h-20 text-sm"
        data-testid="input-new-rule-text"
        autoFocus
      />
      <UniversalTagPicker
        variant="compact"
        selected={tags}
        onChange={setTags}
        placeholder="Add tags"
        testId="input-new-rule-tags"
      />
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:text-foreground"
          data-testid="button-cancel-new-rule"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!canSave}
          onClick={() => createMutation.mutate()}
          className="rounded-md bg-cta px-2 py-1 text-sm text-cta-foreground disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="button-save-new-rule"
        >
          Save
        </button>
      </div>
      {createMutation.isError ? (
        <div className="text-xs text-destructive">
          {(createMutation.error as Error)?.message || "Could not create rule"}
        </div>
      ) : null}
    </div>
  );
}

function OrientationSection({
  section,
  items,
  loading,
  searchActive,
}: {
  section: SectionConfig;
  items: OrientationRecord[];
  loading: boolean;
  searchActive: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const isExpanded = searchActive || expanded;

  return (
    <div className="space-y-0.5">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className={cn(HIERARCHY_SECTION_HEADER_CLASS, "hover:text-foreground")}
        data-testid={`section-orientation-${section.key}`}
      >
        {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <span>{section.label}</span>
      </button>
      {isExpanded ? (
        <div className="space-y-0.5">
          {loading ? (
            <div className="space-y-1 py-1 pl-8 pr-2">
              <Skeleton className="h-6 rounded-md" />
              <Skeleton className="h-6 rounded-md" />
            </div>
          ) : items.length === 0 ? (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">
              {searchActive
                ? `No matching ${section.label.toLowerCase()}.`
                : `No ${section.label.toLowerCase()} yet.`}
            </div>
          ) : (
            items.map((item) => (
              <OrientationItemRow
                key={`${section.key}:${String(item.id ?? "")}`}
                section={section}
                item={item}
              />
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

export default function OrientationPage() {
  usePageHeader({ title: "Orientation" });
  const [searchQuery, setSearchQuery] = useState("");
  const [showNewRule, setShowNewRule] = useState(false);
  const queries = SECTION_CONFIGS.map((section) => useSectionData(section));

  const normalizedSearch = searchQuery.trim().toLowerCase();
  const sectionData = useMemo(() => {
    return SECTION_CONFIGS.map((section, index) => {
      const items = queries[index].data ?? [];
      const filteredItems = normalizedSearch
        ? items.filter((item) => searchableText(section, item).includes(normalizedSearch))
        : items;
      return {
        section,
        items: filteredItems,
        loading: queries[index].isLoading,
      };
    });
  }, [
    normalizedSearch,
    queries.map((query) => query.dataUpdatedAt).join("|"),
    queries.map((query) => query.isLoading).join("|"),
  ]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className={HIERARCHY_TREE_STACK_CLASS}>
        <HierarchySearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          inputTestId="input-search-orientation"
          clearTestId="button-clear-orientation-search"
          ariaLabel="Search orientation"
        />

        <button
          type="button"
          onClick={() => setShowNewRule((value) => !value)}
          className={HIERARCHY_PRIMARY_ACTION_CLASS}
          data-testid="button-new-rule"
        >
          <Plus className="h-3.5 w-3.5 shrink-0" />
          <span>New Rule</span>
        </button>

        {showNewRule ? (
          <NewRuleForm
            onCancel={() => setShowNewRule(false)}
            onCreated={() => setShowNewRule(false)}
          />
        ) : null}

        {sectionData.map(({ section, items, loading }) => (
          <OrientationSection
            key={section.key}
            section={section}
            items={items}
            loading={loading}
            searchActive={Boolean(normalizedSearch)}
          />
        ))}
      </div>
    </div>
  );
}
