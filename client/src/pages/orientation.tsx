import { useMemo, useState, type ComponentType } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { usePageHeader } from "@/hooks/use-page-header";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Compass,
  Lightbulb,
  ShieldCheck,
  Search,
  X,
  type LucideIcon,
} from "lucide-react";

type SectionKey = "theses" | "rules" | "beliefs" | "principles";

type OrientationRecord = Record<string, unknown> & { id?: string | number };

interface SectionConfig {
  key: SectionKey;
  label: string;
  icon: LucideIcon;
  endpoint: string;
  title: (item: OrientationRecord) => string;
  subtitle?: (item: OrientationRecord) => string | null;
  detailRows: Array<{ label: string; value: (item: OrientationRecord) => unknown }>;
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
    detailRows: [
      { label: "Rule", value: (item) => item.rule },
      { label: "Scope", value: (item) => item.scope },
      { label: "Context", value: (item) => item.context },
      { label: "Source", value: (item) => item.source },
      { label: "Tags", value: (item) => item.tags },
    ],
  },
  {
    key: "principles",
    deleteEndpoint: (item) => `/api/principles/${item.id}`,
    label: "Principles",
    icon: Compass,
    endpoint: "/api/principles",
    title: (item) => text(item.title) || "Untitled principle",
    subtitle: (item) => text(item.layer1),
    detailRows: [
      { label: "Layer 1", value: (item) => item.layer1 },
      { label: "Layer 2", value: (item) => item.layer2 },
      { label: "Auto tags", value: (item) => item.autoTags },
      { label: "Manual tags", value: (item) => item.manualTags },
      { label: "Related", value: (item) => item.relatedIds },
    ],
  },
  {
    key: "beliefs",
    deleteEndpoint: (item) => `/api/beliefs/${item.id}`,
    label: "Beliefs",
    icon: Lightbulb,
    endpoint: "/api/beliefs",
    title: (item) => text(item.claim) || "Untitled belief",
    subtitle: (item) => text(item.domain),
    detailRows: [
      { label: "Claim", value: (item) => item.claim },
      { label: "Domain", value: (item) => item.domain },
      { label: "Status", value: (item) => item.status },
      { label: "Confidence", value: (item) => percent(item.confidence) },
      { label: "Evidence", value: (item) => item.evidence },
      { label: "Principle", value: (item) => item.principleRef },
      { label: "Tags", value: (item) => item.tags },
    ],
  },
  {
    key: "theses",
    deleteEndpoint: (item) => `/api/theses/${item.id}`,
    label: "Theses",
    icon: BookOpen,
    endpoint: "/api/theses",
    title: (item) => text(item.title) || "Untitled thesis",
    subtitle: (item) => text(item.statement),
    detailRows: [
      { label: "Statement", value: (item) => item.statement },
      { label: "Status", value: (item) => item.status },
      { label: "Conviction", value: (item) => item.conviction },
      { label: "Tags", value: (item) => item.tags },
    ],
  },


];

const SECTION_BY_KEY = Object.fromEntries(SECTION_CONFIGS.map((section) => [section.key, section])) as Record<SectionKey, SectionConfig>;
const INDENT_PX = 16;
const CONNECTOR_CLASS = "border-muted-foreground/50";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}


function percent(value: unknown): string {
  return typeof value === "number" ? `${Math.round(value * 100)}%` : "";
}

function formatValue(value: unknown): string {
  if (value == null || value === "") return "—";
  if (Array.isArray(value)) {
    if (!value.length) return "—";
    if (value.every((item) => typeof item === "string")) return value.join(", ");
    return value.map((item) => typeof item === "object" ? JSON.stringify(item) : String(item)).join("\n");
  }
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function sectionIcon(section: SectionConfig, _item?: OrientationRecord): LucideIcon {
  return section.icon;
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

function TreeRow({
  depth,
  icon: Icon,
  title,
  subtitle,
  selected,
  muted,
  hasChildren,
  expanded,
  onClick,
}: {
  depth: number;
  icon?: ComponentType<{ className?: string }>;
  title: string;
  subtitle?: string | null;
  selected?: boolean;
  muted?: boolean;
  hasChildren?: boolean;
  expanded?: boolean;
  onClick?: () => void;
}) {
  return (
    <div
      className={cn(
        "group relative flex items-center py-1 transition-colors duration-200 rounded-md",
        selected ? "bg-accent" : "hover:bg-accent/50",
        onClick && "cursor-pointer",
      )}
      style={{ paddingLeft: `${depth * INDENT_PX}px` }}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={(event) => {
        if (!onClick) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      }}
    >
      {depth > 0 && (
        <span className="pointer-events-none absolute inset-y-0 left-2 w-3" aria-hidden="true">
          <span className={cn("absolute bottom-1/2 left-0 top-0 border-l", CONNECTOR_CLASS)} />
          <span className={cn("absolute left-0 top-1/2 w-3 border-t", CONNECTOR_CLASS)} />
        </span>
      )}
      {Icon ? (
        <span className="w-4 shrink-0 flex items-center justify-center">
          <Icon className={cn("h-3.5 w-3.5", muted ? "text-muted-foreground/60" : selected ? "text-foreground" : "text-muted-foreground")} />
        </span>
      ) : null}
      <div className={cn("min-w-0 flex-1", Icon ? "pl-0.5" : "pl-1")}>
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "truncate text-xs transition-all duration-200",
              hasChildren ? "font-bold uppercase tracking-wider" : "font-medium",
              muted ? "text-muted-foreground/60" : selected ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {title}
          </span>
          {subtitle ? <span className="hidden truncate text-[11px] text-muted-foreground/60 sm:inline">{subtitle}</span> : null}
        </div>
      </div>

    </div>
  );
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
  const hasExpansion = section.detailRows.some((row) => {
    const v = row.value(item);
    return v != null && v !== "" && !(Array.isArray(v) && v.length === 0);
  });

  return (
    <div className="space-y-0.5">
      <div className={cn("group relative flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 pr-16 text-sm cursor-pointer select-none transition-colors overflow-hidden hover:bg-accent/50 text-foreground")} style={{ paddingLeft: "32px" }}>
        <span className="pointer-events-none absolute inset-y-0 left-2 w-4" aria-hidden="true">
          <span className={cn("absolute bottom-1/2 left-0 top-0 border-l", CONNECTOR_CLASS)} />
          <span className={cn("absolute left-0 top-1/2 w-4 border-t", CONNECTOR_CLASS)} />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm">{title}</span>
        {hasExpansion && (
          <button
            type="button"
            className="absolute right-8 top-1/2 z-10 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/60 opacity-0 transition-all group-hover:opacity-100 focus-visible:opacity-100 hover:bg-accent hover:text-foreground"
            onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-90")} />
          </button>
        )}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="absolute right-1 top-1/2 z-10 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/60 opacity-0 transition-all group-hover:opacity-100 focus-visible:opacity-100 hover:bg-accent hover:text-foreground"
              onClick={(e) => e.stopPropagation()}
              aria-label="Actions"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-32" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setDeleteOpen(true)}>Delete</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {expanded && (
        <div className="ml-8 rounded-md border border-border/40 bg-card/40 p-3 text-sm">
          {section.detailRows.map((row) => {
            const v = row.value(item);
            if (v == null || v === "" || (Array.isArray(v) && v.length === 0)) return null;
            return (
              <div key={row.label} className="mt-1 first:mt-0">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{row.label}: </span>
                <span className="whitespace-pre-wrap text-sm text-foreground">{formatValue(v)}</span>
              </div>
            );
          })}
        </div>
      )}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete item?</AlertDialogTitle>
            <AlertDialogDescription>This will permanently delete &ldquo;{title.slice(0, 80)}&rdquo;. This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleteMutation.mutate()} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function OrientationSection({
  section,
  items,
  loading,
  selectedKey,
  searchActive,
}: {
  section: SectionConfig;
  items: OrientationRecord[];
  loading: boolean;
  searchActive: boolean;
}) {
  const [expanded, setExpanded] = useState(section.key !== "beliefs");
  const isExpanded = searchActive || expanded;
  return (
    <div className="space-y-0.5">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
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
            <div className="px-8 py-1.5 text-sm text-muted-foreground">
              {searchActive ? `No matching ${section.label.toLowerCase()}.` : `No ${section.label.toLowerCase()} yet.`}
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

export default function WorldPage() {
  usePageHeader({ title: "Orientation" });
  const [searchQuery, setSearchQuery] = useState("");
  const queries = SECTION_CONFIGS.map((section) => useSectionData(section));


  const normalizedSearch = searchQuery.trim().toLowerCase();
  const sectionData = useMemo(() => {
    return SECTION_CONFIGS.map((section, index) => {
      const items = queries[index].data ?? [];
      const filteredItems = normalizedSearch
        ? items.filter((item) => {
          const searchable = [
            section.label,
            section.title(item),
            section.subtitle?.(item) ?? "",
            ...section.detailRows.map((row) => formatValue(row.value(item))),
          ].join(" ").toLowerCase();
          return searchable.includes(normalizedSearch);
        })
        : items;
      return {
        section,
        items: filteredItems,
        loading: queries[index].isLoading,
      };
    });
  }, [normalizedSearch, queries.map((query) => query.data).join("|"), queries.map((query) => query.isLoading).join("|")]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-2 sm:p-3">
      <div className="relative mb-2 min-w-0">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          className="h-7 w-full rounded-md border border-input bg-background pl-7 pr-7 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          data-testid="input-search-orientation"
        />
        {searchQuery ? (
          <button
            type="button"
            onClick={() => setSearchQuery("")}
            className="absolute right-1.5 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
            data-testid="button-clear-orientation-search"
          >
            <X className="h-3 w-3" />
          </button>
        ) : null}
      </div>
      <div className="w-full space-y-1 rounded-lg border border-black bg-background/40 p-2">
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
