import { useMemo, useState } from "react";
import { usePageHeader } from "@/hooks/use-page-header";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ChevronRight, Clock, Pencil, Wrench, Zap } from "lucide-react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { ICON_PALETTE, ICON_PALETTE_NAMES, resolveToolIcon, resolveToolIconName } from "@/lib/tool-icons";

interface ToolInfo {
  name: string;
  description: string;
  detailedDescription?: string;
  category: string;
  usageCount: number;
  lastUsed: string | null;
  discovered: boolean;
  source?: "gateway" | "skill" | "bridge";
  errors?: number;
  avgDuration?: number | null;
}

interface ToolsResponse {
  tools: ToolInfo[];
  totalUsageCount: number;
  uniqueToolsUsed: number;
}

interface ToolCategory {
  name: string;
  tools: ToolInfo[];
  usageCount: number;
  activeCount: number;
}

function formatCategoryName(category: string): string {
  return category
    .split(/[_-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isRecentlyActive(lastUsed: string | null): boolean {
  if (!lastUsed) return false;
  return Date.now() - new Date(lastUsed).getTime() < 5 * 60 * 1000;
}

function groupToolsByCategory(tools: ToolInfo[]): ToolCategory[] {
  const grouped = new Map<string, ToolInfo[]>();

  for (const tool of tools) {
    const category = tool.category?.trim() || "other";
    const categoryTools = grouped.get(category) || [];
    categoryTools.push(tool);
    grouped.set(category, categoryTools);
  }

  return Array.from(grouped, ([name, categoryTools]) => {
    const sortedTools = categoryTools.sort((a, b) => a.name.localeCompare(b.name));
    return {
      name,
      tools: sortedTools,
      usageCount: sortedTools.reduce((total, tool) => total + tool.usageCount, 0),
      activeCount: sortedTools.filter((tool) => isRecentlyActive(tool.lastUsed)).length,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function ActivityIndicator({ size = "sm" }: { size?: "sm" | "md" }) {
  return (
    <span className={cn("relative flex shrink-0", size === "md" ? "h-2 w-2" : "h-1.5 w-1.5")}>
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-active opacity-75" />
      <span className="relative inline-flex h-full w-full rounded-full bg-active" />
    </span>
  );
}

function IconPicker({ toolName, currentIconName }: { toolName: string; currentIconName: string }) {
  const [open, setOpen] = useState(false);
  const { toast } = useToast();

  const updateMutation = useMutation({
    mutationFn: async (iconName: string) => {
      await apiRequest("PUT", "/api/tool-icons", { [toolName.toLowerCase()]: iconName });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tool-icons"] });
      setOpen(false);
      toast({ title: "Icon updated" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update icon", description: error.message, variant: "destructive" });
    },
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "absolute right-1 top-1/2 -translate-y-1/2 flex items-center justify-center h-6 w-6 rounded-md transition-opacity hover:bg-accent bg-accent/50",
            open ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Change ${toolName} icon`}
          data-testid={`button-pick-icon-${toolName}`}
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2" align="end">
        <div className="grid max-h-48 grid-cols-8 gap-1 overflow-auto">
          {ICON_PALETTE_NAMES.map((name) => {
            const Icon = ICON_PALETTE[name];
            const isSelected = name === currentIconName;
            return (
              <button
                type="button"
                key={name}
                className={cn(
                  "flex items-center justify-center rounded p-1.5 transition-colors hover:bg-accent",
                  isSelected && "bg-accent ring-1 ring-ring",
                )}
                onClick={() => updateMutation.mutate(name)}
                title={name}
                data-testid={`icon-option-${name}`}
              >
                <Icon className="h-4 w-4 text-foreground/70" />
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ToolRow({ tool, iconOverrides }: { tool: ToolInfo; iconOverrides: Record<string, string> }) {
  const [expanded, setExpanded] = useState(false);
  const active = isRecentlyActive(tool.lastUsed);
  const description = tool.detailedDescription || tool.description;
  const ToolIcon = resolveToolIcon(tool.name, iconOverrides);
  const currentIconName = resolveToolIconName(tool.name, iconOverrides);

  return (
    <div className="min-w-0">
      <div
        className={cn(
          "group relative flex items-center gap-2 rounded-md px-2 py-1.5 text-sm w-full text-left cursor-pointer select-none transition-colors overflow-hidden hover:bg-accent/70",
          active ? "text-active font-medium" : "text-muted-foreground",
        )}
        onClick={() => setExpanded((prev) => !prev)}
        data-testid={`session-item-tool-${tool.name}`}
      >
        <ToolIcon className="h-3.5 w-3.5 shrink-0" />
        {active && <ActivityIndicator />}
        <span className="flex-1 min-w-0 pr-6 truncate">{tool.name}</span>
        {tool.usageCount > 0 && (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground/70 group-hover:opacity-0 transition-opacity">
            {tool.usageCount}
          </span>
        )}
        <IconPicker toolName={tool.name} currentIconName={currentIconName} />
      </div>
      {expanded && (
        <p
          className="px-2 pb-1.5 pl-[30px] text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap"
          data-testid={`text-tool-desc-${tool.name}`}
        >
          {description}
        </p>
      )}
    </div>
  );
}

function CategorySection({ category, iconOverrides }: { category: ToolCategory; iconOverrides: Record<string, string> }) {
  const [open, setOpen] = useState(true);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className="flex items-center gap-1.5 w-full px-2 py-1.5 text-xs font-bold text-muted-foreground uppercase tracking-wider hover-elevate rounded-md"
        data-testid={`button-group-${category.name}`}
      >
        <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="flex items-center gap-1.5">
          {formatCategoryName(category.name)}
          {category.activeCount > 0 && <ActivityIndicator />}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-0 mt-0">
          {category.tools.map((tool) => (
            <ToolRow key={tool.name} tool={tool} iconOverrides={iconOverrides} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export default function ToolsPage({ embedded }: { embedded?: boolean }) {
  usePageHeader({ title: "Tools", skip: !!embedded });
  const { data, isLoading } = useQuery<ToolsResponse>({
    queryKey: ["/api/tools"],
    refetchInterval: 15000,
  });
  const { data: iconOverrides } = useQuery<Record<string, string>>({
    queryKey: ["/api/tool-icons"],
    staleTime: 60_000,
  });

  const tools = data?.tools || [];
  const categories = useMemo(() => groupToolsByCategory(tools), [tools]);
  const activeTools = tools.filter((tool) => isRecentlyActive(tool.lastUsed));

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <div className="flex-1 overflow-auto p-2">
        {isLoading ? (
          <div className="space-y-2 p-2">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : tools.length === 0 ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground" data-testid="text-tools-empty">
            No tools yet.
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3 px-2 py-1.5" data-testid="tools-summary-bar">
              <div className="flex items-center gap-1.5">
                <Wrench className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-sm font-medium tabular-nums" data-testid="text-total-tools">{tools.length}</span>
                <span className="text-xs text-muted-foreground">tools</span>
              </div>
              <span className="text-border">|</span>
              <div className="flex items-center gap-1.5">
                <Zap className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-sm font-medium tabular-nums" data-testid="text-tools-used">{data?.uniqueToolsUsed || 0}</span>
                <span className="text-xs text-muted-foreground">used</span>
              </div>
              <span className="text-border">|</span>
              <div className="flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-sm font-medium tabular-nums" data-testid="text-total-calls">{data?.totalUsageCount || 0}</span>
                <span className="text-xs text-muted-foreground">calls</span>
              </div>
              {activeTools.length > 0 && (
                <>
                  <span className="text-border">|</span>
                  <div className="flex items-center gap-1.5" data-testid="text-active-tools">
                    <ActivityIndicator size="md" />
                    <span className="text-sm font-medium tabular-nums">{activeTools.length}</span>
                    <span className="text-xs text-muted-foreground">active now</span>
                  </div>
                </>
              )}
            </div>

            {categories.map((category) => (
              <CategorySection key={category.name} category={category} iconOverrides={iconOverrides || {}} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
