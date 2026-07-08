import { useState } from "react";
import { usePageHeader } from "@/hooks/use-page-header";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
import {
  Wrench,
  Clock,
  ChevronRight,
  Zap,
  Sparkles,
  Pencil,
} from "lucide-react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
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

function formatTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function isRecentlyActive(lastUsed: string | null): boolean {
  if (!lastUsed) return false;
  return Date.now() - new Date(lastUsed).getTime() < 5 * 60 * 1000;
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
          className="p-0.5 rounded hover:bg-muted/50 transition-colors"
          data-testid={`button-pick-icon-${toolName}`}
        >
          <Pencil className="h-2.5 w-2.5 text-muted-foreground/40 hover:text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2" align="start">
        <div className="grid grid-cols-8 gap-1 max-h-48 overflow-auto">
          {ICON_PALETTE_NAMES.map((name) => {
            const Icon = ICON_PALETTE[name];
            const isSelected = name === currentIconName;
            return (
              <button
                key={name}
                className={`p-1.5 rounded hover:bg-muted transition-colors flex items-center justify-center ${isSelected ? "bg-primary/10 ring-1 ring-primary/30" : ""}`}
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
  const active = isRecentlyActive(tool.lastUsed);
  const [expanded, setExpanded] = useState(false);
  const desc = tool.detailedDescription || tool.description;

  const ToolIcon = resolveToolIcon(tool.name, iconOverrides);
  const currentIconName = resolveToolIconName(tool.name, iconOverrides);

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <CollapsibleTrigger asChild>
        <button
          className="flex items-start gap-2 w-full py-2 px-3 rounded-md hover-elevate text-left"
          data-testid={`tool-row-${tool.name}`}
        >
          <ChevronRight className={`h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 shrink-0 mt-0.5 ${expanded ? "rotate-90" : ""}`} />
          <ToolIcon className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              {active && (
                <span className="relative flex h-1.5 w-1.5 shrink-0">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-chart-4 opacity-75" />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-chart-4" />
                </span>
              )}
              <span className={`text-sm font-mono font-semibold ${active ? "text-foreground" : "text-foreground/80"}`}>
                {tool.name}
              </span>
              {tool.discovered && tool.usageCount > 0 && (
                <span className="text-xs text-muted-foreground/50 tabular-nums">{tool.usageCount}x</span>
              )}
              <span onClick={(e) => e.stopPropagation()}>
                <IconPicker toolName={tool.name} currentIconName={currentIconName} />
              </span>
            </div>
          </div>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-8 pr-3 pb-2">
          <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap" data-testid={`text-tool-desc-${tool.name}`}>{desc}</p>
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
  const activeTools = tools.filter(t => isRecentlyActive(t.lastUsed));

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden">
      <div className="flex-1 overflow-auto p-4 space-y-3">
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : tools.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center max-w-sm mx-auto">
            <div className="relative mb-4">
              <Wrench className="h-12 w-12 text-muted-foreground/20" />
              <Sparkles className="h-5 w-5 text-chart-4 absolute -top-1 -right-1" />
            </div>
            <p className="text-sm font-medium mb-1" data-testid="text-tools-empty">Agent's toolbox is empty</p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Tools appear here as Agent discovers and uses them during sessions. Start a chat to see the toolbox come alive.
            </p>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 px-3 py-2 flex-wrap" data-testid="tools-summary-bar">
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
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-chart-4 opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-chart-4" />
                    </span>
                    <span className="text-sm font-medium tabular-nums">{activeTools.length}</span>
                    <span className="text-xs text-muted-foreground">active now</span>
                  </div>
                </>
              )}
            </div>

            <Card>
              <CardContent className="p-2 space-y-0.5">
                {[...tools].sort((a, b) => a.name.localeCompare(b.name)).map((tool) => (
                  <ToolRow key={tool.name} tool={tool} iconOverrides={iconOverrides || {}} />
                ))}
              </CardContent>
            </Card>

          </>
        )}
      </div>
    </div>
  );
}
