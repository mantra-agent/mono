import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ChevronRight,
  Loader2,
  MoreHorizontal,
  Plus,
  Route,
  Star,
} from "lucide-react";
import { EditableSessionTitle } from "@/components/editable-session-title";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import { HierarchyTreeRow } from "@/components/hierarchy-tree";
import {
  HIERARCHY_PRIMARY_ACTION_CLASS,
  HIERARCHY_SECTION_HEADER_CLASS,
  HIERARCHY_SESSION_ROW_CLASS,
  HIERARCHY_TREE_STACK_CLASS,
} from "@/components/hierarchy-section-header";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import {
  PACKAGED_CONNECTOR_PROVIDERS,
  ProviderConnectorPackage,
  type PackagedConnectorProvider,
} from "@/components/integrations/provider-connector-package";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/hooks/use-auth";
import { usePageHeader } from "@/hooks/use-page-header";
import { usePageLoadActivity } from "@/hooks/use-page-activity";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";


const ROUTERS_QUERY_KEY = ["/api/routers"] as const;

interface RouterSummary {
  id: string;
  name: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

interface RouterConnector {
  id: number;
  provider: string;
  label: string;
  status: string;
  sortOrder: number;
  priorityPinned: boolean;
  routerId?: string | null;
  /** Present on router detail; required for inline ProviderConnectorPackage models tree. */
  config?: {
    kind?: "model" | "openai-models" | "claude-cli-models" | "grok-models";
    tierMappings: Record<"max" | "high" | "balanced" | "fast", string | { model: string }>;
  };
}

interface RouterDetail extends RouterSummary {
  connectors: RouterConnector[];
}

const CONNECTOR_KINDS: Array<{ kind: string; label: string }> = [
  { kind: "claude-cli", label: "Claude CLI" },
  { kind: "openai-subscription", label: "ChatGPT Subscription" },
  { kind: "openai", label: "OpenAI API" },
  { kind: "anthropic", label: "Claude API" },
  { kind: "grok-api", label: "Grok API" },
  { kind: "grok-subscription", label: "Grok Subscription" },
];

function matchesQuery(query: string, ...parts: Array<string | null | undefined>): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return parts.some((part) => (part ?? "").toLowerCase().includes(needle));
}

function ConnectorAuthMeta({ connectorId, provider }: { connectorId: number; provider: string }) {
  const { data } = useQuery<{
    connected?: boolean;
    email?: string;
    label?: string;
    credentialLast4?: string;
  }>({
    queryKey: [`/api/models/connectors/${connectorId}/auth-status`],
    staleTime: 15_000,
  });
  const isSecret = provider === "claude-cli" || provider === "openai" || provider === "anthropic";
  const text = isSecret
    ? (data?.credentialLast4 ? `···${data.credentialLast4}` : "")
    : (data?.email || data?.label || "");
  if (!text) return null;
  return <span className="ml-1 min-w-0 truncate text-muted-foreground">{text}</span>;
}

function RouterConnectorRow({
  connector,
  routerId,
  actions,
}: {
  connector: RouterConnector;
  routerId: string;
  actions: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const supportsPackage = PACKAGED_CONNECTOR_PROVIDERS.has(connector.provider);
  // Router detail already carries config; do not resolve through legacy-only /api/models/connectors.
  const packageConnector = connector.config
    ? {
        id: connector.id,
        provider: connector.provider as PackagedConnectorProvider,
        label: connector.label,
        status: connector.status,
        sortOrder: connector.sortOrder,
        priorityPinned: connector.priorityPinned,
        config: connector.config,
      }
    : undefined;

  return (
    <HierarchyTreeRow continues indent="icon" connectorAnchor="first-row-center">
      <div className={cn(HIERARCHY_SESSION_ROW_CLASS, "group/conn min-h-8 cursor-default")}>
        <span className={cn("min-w-0 flex-1 truncate", connector.status !== "active" && "text-muted-foreground")}>
          {connector.priorityPinned ? "📌 " : ""}
          {connector.label}
          <ConnectorAuthMeta connectorId={connector.id} provider={connector.provider} />
        </span>
        {supportsPackage ? (
          <button
            type="button"
            className="rounded p-0.5 hover:bg-accent/60"
            onClick={() => setOpen((value) => !value)}
            aria-label={open ? "Collapse connector" : "Expand connector"}
          >
            <ChevronRight className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", open && "rotate-90")} />
          </button>
        ) : null}
        {actions}
      </div>
      {supportsPackage && open ? (
        <div className="space-y-0 pb-1 pl-6 pr-1">
          {packageConnector ? (
            <ProviderConnectorPackage
              provider={packageConnector.provider}
              connector={packageConnector as any}
              flattenHeaders
              invalidateQueryKeys={[[...ROUTERS_QUERY_KEY, routerId]]}
            />
          ) : (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">Connector configuration unavailable.</div>
          )}
        </div>
      ) : null}
    </HierarchyTreeRow>
  );
}

function RouterRow({
  summary,
  canWrite,
  defaultOpen,
  onRename,
  onSetDefault,
  onDelete,
}: {
  summary: RouterSummary;
  canWrite: boolean;
  defaultOpen: boolean;
  onRename: (id: string, name: string) => void;
  onSetDefault: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const { toast } = useToast();

  const detailQuery = useQuery<RouterDetail>({
    queryKey: [...ROUTERS_QUERY_KEY, summary.id],
    enabled: open,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/routers/${summary.id}`);
      const body = await res.json();
      return body.router as RouterDetail;
    },
    staleTime: 10_000,
  });

  const connectors = detailQuery.data?.connectors ?? [];

  async function invalidateMembership() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: [...ROUTERS_QUERY_KEY, summary.id] }),
      queryClient.invalidateQueries({ queryKey: ROUTERS_QUERY_KEY }),
    ]);
  }

  const addConnector = useMutation({
    mutationFn: async (kind: string) => {
      await apiRequest("POST", `/api/routers/${summary.id}/connectors`, { kind });
    },
    onSuccess: async () => {
      await invalidateMembership();
    },
    onError: (error: Error) => toast({ title: "Add connector failed", description: error.message, variant: "destructive" }),
  });

  const patchConnector = useMutation({
    mutationFn: async ({ connectorId, body }: { connectorId: number; body: Record<string, unknown> }) => {
      await apiRequest("PATCH", `/api/routers/${summary.id}/connectors/${connectorId}`, body);
    },
    onSuccess: async () => {
      await invalidateMembership();
    },
    onError: (error: Error) => toast({ title: "Update failed", description: error.message, variant: "destructive" }),
  });

  const removeConnector = useMutation({
    mutationFn: async (connectorId: number) => {
      await apiRequest("DELETE", `/api/routers/${summary.id}/connectors/${connectorId}`);
    },
    onSuccess: async () => {
      await invalidateMembership();
    },
    onError: (error: Error) => toast({ title: "Remove failed", description: error.message, variant: "destructive" }),
  });

  const reorder = useMutation({
    mutationFn: async (ids: number[]) => {
      await apiRequest("PUT", `/api/routers/${summary.id}/connectors/order`, { ids });
    },
    onSuccess: async () => {
      await invalidateMembership();
    },
    onError: (error: Error) => toast({ title: "Reorder failed", description: error.message, variant: "destructive" }),
  });

  function raiseConnector(connector: RouterConnector) {
    const cohort = connectors.filter((c) => c.priorityPinned === connector.priorityPinned);
    const idx = cohort.findIndex((c) => c.id === connector.id);
    if (idx <= 0) return;
    const next = [...cohort];
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    const other = connectors.filter((c) => c.priorityPinned !== connector.priorityPinned);
    const pinned = connector.priorityPinned ? next : other.filter((c) => c.priorityPinned);
    const unpinned = connector.priorityPinned ? other.filter((c) => !c.priorityPinned) : next;
    reorder.mutate([...pinned, ...unpinned].map((c) => c.id));
  }

  function lowerConnector(connector: RouterConnector) {
    const cohort = connectors.filter((c) => c.priorityPinned === connector.priorityPinned);
    const idx = cohort.findIndex((c) => c.id === connector.id);
    if (idx < 0 || idx >= cohort.length - 1) return;
    const next = [...cohort];
    [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
    const other = connectors.filter((c) => c.priorityPinned !== connector.priorityPinned);
    const pinned = connector.priorityPinned ? next : other.filter((c) => c.priorityPinned);
    const unpinned = connector.priorityPinned ? other.filter((c) => !c.priorityPinned) : next;
    reorder.mutate([...pinned, ...unpinned].map((c) => c.id));
  }

  return (
    <div className="min-w-0" data-testid={`router-row-${summary.id}`}>
      <div className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent/70">
        <Route className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <EditableSessionTitle
          title={summary.name}
          canEdit={canWrite}
          onCommit={(name) => onRename(summary.id, name)}
          className="min-w-0 flex-1 truncate font-normal text-foreground"
        />
        </div>
        <span className="ml-1 flex w-5 shrink-0 items-center justify-center">
          <button
            type="button"
            className="rounded p-0.5 hover:bg-accent/60"
            onClick={() => setOpen((value) => !value)}
            aria-label={open ? "Collapse" : "Expand"}
          >
            <ChevronRight className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", open && "rotate-90")} />
          </button>
        </span>
        {canWrite ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="rounded p-0.5 opacity-0 transition-opacity hover:bg-accent/60 group-hover:opacity-100 data-[state=open]:opacity-100"
                aria-label="Router actions"
              >
                <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem
                disabled={summary.isDefault}
                onClick={() => onSetDefault(summary.id)}
              >
                Set as Default
              </DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Add Connector</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {CONNECTOR_KINDS.map((item) => (
                    <DropdownMenuItem
                      key={item.kind}
                      onClick={() => addConnector.mutate(item.kind)}
                    >
                      {item.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                disabled={summary.isDefault}
                onClick={() => onDelete(summary.id)}
              >
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      {open ? (
        <>
          {detailQuery.isLoading ? (
            <HierarchyTreeRow continues indent="icon" connectorAnchor="first-row-center">
              <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading…
              </div>
            </HierarchyTreeRow>
          ) : connectors.length === 0 ? (
            <HierarchyTreeRow continues indent="icon" connectorAnchor="first-row-center">
              <div className="px-2 py-1.5 text-sm text-muted-foreground">No connectors.</div>
            </HierarchyTreeRow>
          ) : (
            connectors.map((connector) => (
              <RouterConnectorRow
                key={connector.id}
                connector={connector}
                routerId={summary.id}
                actions={canWrite ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="rounded p-0.5 opacity-0 transition-opacity hover:bg-accent/60 group-hover/conn:opacity-100 data-[state=open]:opacity-100"
                        aria-label="Connector actions"
                      >
                        <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-40">
                      <DropdownMenuItem
                        onClick={() => patchConnector.mutate({
                          connectorId: connector.id,
                          body: { priorityPinned: !connector.priorityPinned },
                        })}
                      >
                        {connector.priorityPinned ? "Unpin" : "Pin"}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => raiseConnector(connector)}>Raise</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => lowerConnector(connector)}>Lower</DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => patchConnector.mutate({
                          connectorId: connector.id,
                          body: { status: connector.status === "active" ? "inactive" : "active" },
                        })}
                      >
                        {connector.status === "active" ? "Disable" : "Enable"}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => removeConnector.mutate(connector.id)}
                      >
                        Remove
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              />
            ))
          )}
          <HierarchyTreeRow continues={false} indent="icon" connectorAnchor="first-row-center">
            <ProfileTreeRow
              label="Default"
              icon={<Star className="h-3.5 w-3.5" />}
              hasValue={summary.isDefault}
              showEmpty
            >
              <span className={summary.isDefault ? "text-foreground" : "text-muted-foreground"}>
                {summary.isDefault ? "Yes" : "No"}
              </span>
            </ProfileTreeRow>
          </HierarchyTreeRow>
        </>
      ) : null}
    </div>
  );
}

export default function RoutersAdminPage() {
  const { hasPermission } = useAuth();
  const canRead = hasPermission("system:read");
  const canWrite = hasPermission("system:write");
  const [search, setSearch] = useState("");
  const { toast } = useToast();
  usePageHeader({ title: "Routers" });

  const listQuery = useQuery<{ routers: RouterSummary[] }>({
    queryKey: ROUTERS_QUERY_KEY,
    enabled: canRead,
    queryFn: async () => (await apiRequest("GET", "/api/routers")).json(),
    staleTime: 15_000,
  });
  usePageLoadActivity("page:routers", listQuery.isLoading);

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/routers", { name: "New Router" });
      return res.json();
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ROUTERS_QUERY_KEY });
    },
    onError: (error: Error) => toast({ title: "Create failed", description: error.message, variant: "destructive" }),
  });

  const renameMutation = useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      await apiRequest("PATCH", `/api/routers/${id}`, { name });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ROUTERS_QUERY_KEY });
    },
    onError: (error: Error) => toast({ title: "Rename failed", description: error.message, variant: "destructive" }),
  });

  const defaultMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("POST", `/api/routers/${id}/default`);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ROUTERS_QUERY_KEY });
    },
    onError: (error: Error) => toast({ title: "Set default failed", description: error.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/routers/${id}`);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ROUTERS_QUERY_KEY });
    },
    onError: (error: Error) => toast({ title: "Delete failed", description: error.message, variant: "destructive" }),
  });

  const routers = useMemo(() => {
    const rows = listQuery.data?.routers ?? [];
    return rows.filter((router) => matchesQuery(search, router.name, router.id));
  }, [listQuery.data?.routers, search]);

  if (!canRead) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        Routers requires system:read.
      </div>
    );
  }
  if (listQuery.isLoading || !listQuery.data) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col bg-background" data-testid="routers-page">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={HIERARCHY_TREE_STACK_CLASS}>
          <HierarchySearchInput
            value={search}
            onChange={setSearch}
            inputTestId="input-search-routers"
            clearTestId="button-clear-router-search"
            ariaLabel="Search routers"
          />
          {canWrite ? (
            <button
              type="button"
              className={HIERARCHY_PRIMARY_ACTION_CLASS}
              onClick={() => createMutation.mutate()}
              disabled={createMutation.isPending}
              data-testid="button-new-router"
            >
              <Plus className="h-3.5 w-3.5" />
              New Router
            </button>
          ) : null}
          <Collapsible defaultOpen>
            <CollapsibleTrigger className={cn(HIERARCHY_SECTION_HEADER_CLASS, "hover-elevate")}>
              <ChevronRight className="h-3 w-3 shrink-0 transition-transform [[data-state=open]_&]:rotate-90" />
              ROUTERS
            </CollapsibleTrigger>
            <CollapsibleContent>
              {routers.length === 0 ? (
                <div className="px-2 py-1.5 text-sm text-muted-foreground">No routers.</div>
              ) : (
                routers.map((router) => (
                  <RouterRow
                    key={router.id}
                    summary={router}
                    canWrite={canWrite}
                    defaultOpen={Boolean(search.trim())}
                    onRename={(id, name) => renameMutation.mutate({ id, name })}
                    onSetDefault={(id) => defaultMutation.mutate(id)}
                    onDelete={(id) => deleteMutation.mutate(id)}
                  />
                ))
              )}
            </CollapsibleContent>
          </Collapsible>
        </div>
      </div>
    </div>
  );
}
