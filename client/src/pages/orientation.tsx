import { useMemo, useState, type ReactNode } from "react";
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
import { Input } from "@/components/ui/input";
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
  FileText,
  Layers,
  Link2,
  MoreHorizontal,
  Plus,
  ShieldCheck,
  Tag,
  type LucideIcon,
} from "lucide-react";

type SectionKey = "theses" | "rules" | "principles";
type OrientationRecord = Record<string, unknown> & { id?: string | number };
type RuleScope = "always" | "contextual";

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
    subtitle: (item) => text(item.context),
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

function tagsToReferenceText(tags: string[]): string {
  return tags
    .map((tag) => {
      const slug = normalizeTagSlug(tag);
      return slug ? `@tag:${slug}` : "";
    })
    .filter(Boolean)
    .join(" ");
}

function searchableText(section: SectionConfig, item: OrientationRecord): string {
  const parts = [
    section.label,
    section.title(item),
    section.subtitle?.(item) ?? "",
    formatValue(item.rule),
    formatValue(item.context),
    formatValue(item.scope),
    formatValue(item.source),
    formatValue(item.tags),
    formatValue(item.layer1),
    formatValue(item.layer2),
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

function TagLinks({ tags, empty = "—" }: { tags: string[]; empty?: string }) {
  if (!tags.length) {
    return <span className="text-muted-foreground">{empty}</span>;
  }
  return (
    <InlineReferenceText
      text={tagsToReferenceText(tags)}
      className="inline-flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5"
    />
  );
}

function DetailTextRow({
  label,
  icon,
  value,
  testId,
  mono = false,
}: {
  label: string;
  icon: ReactNode;
  value: unknown;
  testId: string;
  mono?: boolean;
}) {
  const display = formatValue(value);
  const hasValue = display !== "—";
  return (
    <ProfileTreeRow
      label={label}
      icon={icon}
      hasValue={hasValue}
      showEmpty
      mobileLayout="inline"
      testId={testId}
    >
      <span className={cn("min-w-0 whitespace-pre-wrap break-words text-sm", mono && "font-mono text-xs")}>
        {display}
      </span>
    </ProfileTreeRow>
  );
}

function DetailTagsRow({
  label,
  tags,
  testId,
  editable = false,
  onChange,
}: {
  label: string;
  tags: string[];
  testId: string;
  editable?: boolean;
  onChange?: (tags: string[]) => void;
}) {
  return (
    <ProfileTreeRow
      label={label}
      icon={<Tag className="h-3.5 w-3.5" />}
      hasValue={tags.length > 0}
      showEmpty
      mobileLayout="inline"
      testId={testId}
      expandedContent={
        editable && onChange ? (
          <UniversalTagPicker
            variant="compact"
            selected={tags}
            onChange={onChange}
            placeholder="Add tag"
            testId={`${testId}-picker`}
          />
        ) : undefined
      }
    >
      <TagLinks tags={tags} empty="None" />
    </ProfileTreeRow>
  );
}

function RuleDetails({ item }: { item: OrientationRecord }) {
  const ruleId = String(item.id ?? "");
  const [ruleText, setRuleText] = useState(text(item.rule));
  const [contextText, setContextText] = useState(text(item.context));
  const scope = (text(item.scope) || "always") as RuleScope;
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

  const commitContext = () => {
    const next = contextText.trim();
    if (next === text(item.context)) return;
    if (scope === "contextual" && !next) {
      setContextText(text(item.context));
      return;
    }
    updateMutation.mutate({ context: next || undefined, scope: next ? "contextual" : "always" });
  };

  return (
    <div className="space-y-0.5">
      <ProfileTreeRow
        label="Rule"
        icon={<FileText className="h-3.5 w-3.5" />}
        hasValue={Boolean(ruleText.trim())}
        showEmpty
        mobileLayout="inline"
        testId={`row-rule-text-${ruleId}`}
        expandedContent={
          <Textarea
            value={ruleText}
            onChange={(event) => setRuleText(event.target.value)}
            onBlur={commitRule}
            className="min-h-20 text-sm"
            data-testid={`input-rule-text-${ruleId}`}
          />
        }
      >
        <span className="min-w-0 whitespace-pre-wrap break-words text-sm">{ruleText || "—"}</span>
      </ProfileTreeRow>

      <ProfileTreeRow
        label="Scope"
        icon={<Layers className="h-3.5 w-3.5" />}
        hasValue
        showEmpty
        mobileLayout="inline"
        testId={`row-rule-scope-${ruleId}`}
        expandedContent={
          <div className="flex gap-2">
            {(["always", "contextual"] as const).map((nextScope) => (
              <button
                key={nextScope}
                type="button"
                className={cn(
                  "rounded-md border px-2 py-1 text-xs capitalize transition-colors",
                  scope === nextScope
                    ? "border-foreground/30 bg-accent text-foreground"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
                onClick={() => {
                  if (nextScope === scope) return;
                  if (nextScope === "contextual" && !contextText.trim()) return;
                  updateMutation.mutate({
                    scope: nextScope,
                    context: nextScope === "always" ? undefined : contextText.trim(),
                  });
                }}
                data-testid={`button-rule-scope-${nextScope}-${ruleId}`}
              >
                {nextScope}
              </button>
            ))}
          </div>
        }
      >
        <span className="capitalize text-sm">{scope}</span>
      </ProfileTreeRow>

      <ProfileTreeRow
        label="Context"
        icon={<Compass className="h-3.5 w-3.5" />}
        hasValue={Boolean(contextText.trim())}
        showEmpty
        mobileLayout="inline"
        testId={`row-rule-context-${ruleId}`}
        expandedContent={
          <Input
            value={contextText}
            onChange={(event) => setContextText(event.target.value)}
            onBlur={commitContext}
            placeholder="When this rule applies"
            className="h-8 text-sm"
            data-testid={`input-rule-context-${ruleId}`}
          />
        }
      >
        <span className="min-w-0 truncate text-sm">{contextText || "—"}</span>
      </ProfileTreeRow>

      <DetailTextRow
        label="Source"
        icon={<Link2 className="h-3.5 w-3.5" />}
        value={item.source}
        testId={`row-rule-source-${ruleId}`}
      />

      <DetailTagsRow
        label="Tags"
        tags={tags}
        testId={`row-rule-tags-${ruleId}`}
        editable
        onChange={(nextTags) => updateMutation.mutate({ tags: nextTags.length ? nextTags : undefined })}
      />
    </div>
  );
}

function PrincipleDetails({ item }: { item: OrientationRecord }) {
  const id = String(item.id ?? "");
  return (
    <div className="space-y-0.5">
      <DetailTextRow
        label="Layer 1"
        icon={<FileText className="h-3.5 w-3.5" />}
        value={item.layer1}
        testId={`row-principle-layer1-${id}`}
      />
      <DetailTextRow
        label="Layer 2"
        icon={<Layers className="h-3.5 w-3.5" />}
        value={item.layer2}
        testId={`row-principle-layer2-${id}`}
      />
      <DetailTagsRow
        label="Auto tags"
        tags={asStringArray(item.autoTags)}
        testId={`row-principle-auto-tags-${id}`}
      />
      <DetailTagsRow
        label="Manual tags"
        tags={asStringArray(item.manualTags)}
        testId={`row-principle-manual-tags-${id}`}
      />
      <DetailTextRow
        label="Related"
        icon={<Link2 className="h-3.5 w-3.5" />}
        value={item.relatedIds}
        testId={`row-principle-related-${id}`}
        mono
      />
    </div>
  );
}

function ThesisDetails({ item }: { item: OrientationRecord }) {
  const id = String(item.id ?? "");
  return (
    <div className="space-y-0.5">
      <DetailTextRow
        label="Statement"
        icon={<FileText className="h-3.5 w-3.5" />}
        value={item.statement}
        testId={`row-thesis-statement-${id}`}
      />
      <DetailTextRow
        label="Status"
        icon={<Layers className="h-3.5 w-3.5" />}
        value={item.status}
        testId={`row-thesis-status-${id}`}
      />
      <DetailTextRow
        label="Conviction"
        icon={<Compass className="h-3.5 w-3.5" />}
        value={item.conviction}
        testId={`row-thesis-conviction-${id}`}
      />
      <DetailTagsRow
        label="Tags"
        tags={asStringArray(item.tags)}
        testId={`row-thesis-tags-${id}`}
      />
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
  const [context, setContext] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const createMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        rule: rule.trim(),
        source: "manual",
        scope: context.trim() ? "contextual" : "always",
      };
      if (context.trim()) body.context = context.trim();
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
      <Input
        value={context}
        onChange={(event) => setContext(event.target.value)}
        placeholder="Context (optional)"
        className="h-8 text-sm"
        data-testid="input-new-rule-context"
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
