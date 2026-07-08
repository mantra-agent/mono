import { useEffect, useRef, useState, type ComponentType, type KeyboardEvent, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { usePageHeader } from "@/hooks/use-page-header";
import { Button } from "@/components/ui/button";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { ActiveStatusSpinner } from "@/components/nav-dot";
import { statusFamily } from "@/components/build-status-panel";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { Boxes, ChevronRight, MoreHorizontal, Package, Plus, Server, Trash2 } from "lucide-react";

interface PlatformProductEnvironment {
  id: number;
  productId: number;
  name: string;
  createdAt: string;
  updatedAt: string;
}

interface PlatformProduct {
  id: number;
  platformId: number;
  name: string;
  description: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  environments: PlatformProductEnvironment[];
}

interface Platform {
  id: number;
  name: string;
  description: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  products: PlatformProduct[];
}

type BuildLifecycleStatus = {
  providers?: {
    railway?: { deployment?: { status?: string | null } | null } | null;
    cloudflare_pages?: { deployment?: { status?: string | null } | null } | null;
  };
  workflows?: { recent?: Array<{ status: string }> };
};

type PendingDelete =
  | { type: "platform"; platform: Platform }
  | { type: "product"; platform: Platform; product: PlatformProduct }
  | { type: "environment"; platform: Platform; product: PlatformProduct; environment: PlatformProductEnvironment };

type RenameTarget =
  | { type: "platform"; id: number }
  | { type: "product"; id: number; platformId: number }
  | null;

const INDENT_STEP_PX = 16;
const MAX_INDENT_PX = 96;

function TreeBranch({ depth }: { depth: number }) {
  if (depth <= 0) return null;
  return (
    <div className="shrink-0 w-5 self-stretch relative mr-1" aria-hidden="true">
      <div className="absolute left-1/2 top-0 bottom-1/2 -translate-x-px border-l border-border" />
      <div className="absolute left-1/2 top-1/2 right-0 border-t border-border" />
    </div>
  );
}

function RenameInput({
  value,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.select();
  }, []);

  return (
    <input
      ref={inputRef}
      className="flex-1 min-w-0 bg-transparent border-b border-primary outline-none text-sm"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onCommit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
      onBlur={onCommit}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      data-testid="input-platform-tree-rename"
    />
  );
}

function PlatformTreeRow({
  depth,
  icon: Icon,
  title,
  children,
  onSelect,
  onRename,
  menu,
  expander,
  active,
  muted,
  isRenaming,
  renameValue,
  onRenameValueChange,
  onRenameCommit,
  onRenameCancel,
  isBuilding,
  testId,
}: {
  depth: number;
  icon?: ComponentType<{ className?: string }>;
  title: string;
  children?: ReactNode;
  onSelect?: () => void;
  onRename?: () => void;
  menu?: ReactNode;
  expander?: ReactNode;
  active?: boolean;
  muted?: boolean;
  isRenaming?: boolean;
  renameValue?: string;
  onRenameValueChange?: (value: string) => void;
  onRenameCommit?: () => void;
  onRenameCancel?: () => void;
  isBuilding?: boolean;
  testId?: string;
}) {
  return (
    <div className="flex min-w-0 items-stretch" style={{ paddingLeft: Math.min(depth * INDENT_STEP_PX, MAX_INDENT_PX) }}>
      <TreeBranch depth={depth} />
      <div className="flex-1 min-w-0 relative overflow-hidden">
        <div
          role={onSelect ? "button" : undefined}
          tabIndex={onSelect ? 0 : undefined}
          className={cn(
            "group relative flex items-center gap-2 rounded-md px-2 py-1.5 text-sm w-full text-left select-none transition-colors overflow-hidden",
            onSelect && !isRenaming && "cursor-pointer",
            active ? "bg-accent" : "hover:bg-accent/70",
            muted ? "text-muted-foreground" : "text-foreground",
            isBuilding && "text-active animate-pulse",
          )}
          title={isRenaming ? undefined : title}
          onClick={() => !isRenaming && onSelect?.()}
          onKeyDown={(event) => {
            if (!onSelect || isRenaming) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onSelect();
            }
          }}
          data-testid={testId}
        >
          <span className="flex items-center justify-center shrink-0">
            {isBuilding ? <ActiveStatusSpinner className="h-3.5 w-3.5" /> : Icon ? <Icon className="h-3.5 w-3.5 shrink-0" /> : null}
          </span>
          {isRenaming && onRenameValueChange && onRenameCommit && onRenameCancel ? (
            <RenameInput
              value={renameValue ?? ""}
              onChange={onRenameValueChange}
              onCommit={onRenameCommit}
              onCancel={onRenameCancel}
            />
          ) : children ? (
            children
          ) : (
            <span className="flex-1 min-w-0 pr-14">
              <button
                type="button"
                className={cn("inline-flex max-w-full min-w-0 items-baseline text-left align-baseline", onRename && "cursor-text")}
                onClick={(event) => {
                  if (!onRename) return;
                  event.stopPropagation();
                  onRename();
                }}
                aria-label={onRename ? `Rename ${title}` : title}
              >
                <span className={cn("truncate", isBuilding && "text-active animate-pulse")}>{title}</span>
              </button>
            </span>
          )}
          {expander}
          {menu}
        </div>
      </div>
    </div>
  );
}

function RowMenu({ children, label }: { children: ReactNode; label: string }) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center justify-center h-6 w-6 rounded-md opacity-0 group-hover:opacity-100 transition-opacity hover:bg-accent bg-accent/50"
          onClick={(event) => event.stopPropagation()}
          aria-label={label}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onCloseAutoFocus={(event) => event.preventDefault()}>{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

function RowExpander({ open, onToggle, label }: { open: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      className="absolute right-8 top-1/2 -translate-y-1/2 h-5 w-5 flex items-center justify-center rounded text-muted-foreground/60 hover:text-foreground hover:bg-accent transition-colors z-10"
      aria-label={label}
    >
      <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
    </button>
  );
}

function EmptyTreeRow({ depth, title }: { depth: number; title: string }) {
  return (
    <PlatformTreeRow depth={depth} title={title} muted>
      <span className="truncate text-muted-foreground">{title}</span>
    </PlatformTreeRow>
  );
}

function EnvironmentRow({
  environment,
  onOpen,
  onDelete,
}: {
  environment: PlatformProductEnvironment;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const { data } = useQuery<BuildLifecycleStatus>({
    queryKey: ["/api/platforms/environments", environment.id, "build-status"],
    refetchInterval: (query) => {
      const status = query.state.data?.providers?.railway?.deployment?.status || query.state.data?.providers?.cloudflare_pages?.deployment?.status;
      const activeWorkflow = query.state.data?.workflows?.recent?.some((run) => ["active", "needs_review"].includes(run.status));
      return statusFamily(status) === "deploying" || activeWorkflow ? 8000 : false;
    },
    staleTime: 30_000,
  });
  const deploymentStatus = data?.providers?.railway?.deployment?.status || data?.providers?.cloudflare_pages?.deployment?.status;
  const isBuilding = statusFamily(deploymentStatus) === "deploying" || !!data?.workflows?.recent?.some((run) => ["active", "needs_review"].includes(run.status));

  return (
    <PlatformTreeRow
      depth={2}
      icon={Server}
      title={environment.name}
      onSelect={onOpen}
      isBuilding={isBuilding}
      testId={`platform-environment-${environment.id}`}
      menu={
        <RowMenu label={`Open ${environment.name} actions`}>
          <DropdownMenuItem onClick={(event) => { event.stopPropagation(); onOpen(); }}>
            Open
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={(event) => { event.stopPropagation(); onDelete(); }}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Delete environment
          </DropdownMenuItem>
        </RowMenu>
      }
    >
      <span className="flex-1 min-w-0 pr-14">
        <span className={cn("truncate", isBuilding && "text-active animate-pulse")}>{environment.name}</span>
      </span>
    </PlatformTreeRow>
  );
}

export default function PlatformsPage() {
  usePageHeader({ title: "Platforms" });
  const [, setLocation] = useLocation();
  const [closedPlatforms, setClosedPlatforms] = useState<Set<number>>(() => new Set());
  const [closedProducts, setClosedProducts] = useState<Set<number>>(() => new Set());
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [renameTarget, setRenameTarget] = useState<RenameTarget>(null);
  const [renameValue, setRenameValue] = useState("");

  const { data: platforms = [], isLoading } = useQuery<Platform[]>({
    queryKey: ["/api/platforms"],
  });

  const createPlatformMutation = useMutation({
    mutationFn: async (name: string) => {
      const res = await apiRequest("POST", "/api/platforms", { name });
      return res.json() as Promise<Platform>;
    },
    onSuccess: (platform) => {
      queryClient.invalidateQueries({ queryKey: ["/api/platforms"] });
      setClosedPlatforms(prev => {
        const next = new Set(prev);
        next.delete(platform.id);
        return next;
      });
      setRenameTarget({ type: "platform", id: platform.id });
      setRenameValue(platform.name);
    },
  });

  const updatePlatformMutation = useMutation({
    mutationFn: async ({ id, name }: { id: number; name: string }) => {
      const res = await apiRequest("PATCH", `/api/platforms/${id}`, { name });
      return res.json() as Promise<Platform>;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/platforms"] }),
  });

  const updateProductMutation = useMutation({
    mutationFn: async ({ platformId, productId, name }: { platformId: number; productId: number; name: string }) => {
      const res = await apiRequest("PATCH", `/api/platforms/${platformId}/products/${productId}`, { name });
      return res.json() as Promise<PlatformProduct>;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/platforms"] }),
  });

  const deletePlatformMutation = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/platforms/${id}`),
    onSuccess: () => {
      setPendingDelete(null);
      queryClient.invalidateQueries({ queryKey: ["/api/platforms"] });
    },
  });

  const createProductMutation = useMutation({
    mutationFn: async ({ platformId, name }: { platformId: number; name: string }) => {
      const res = await apiRequest("POST", `/api/platforms/${platformId}/products`, { name });
      return res.json() as Promise<PlatformProduct>;
    },
    onSuccess: (product, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/platforms"] });
      setClosedPlatforms(prev => {
        const next = new Set(prev);
        next.delete(variables.platformId);
        return next;
      });
      setClosedProducts(prev => {
        const next = new Set(prev);
        next.delete(product.id);
        return next;
      });
      setRenameTarget({ type: "product", id: product.id, platformId: variables.platformId });
      setRenameValue(product.name);
    },
  });

  const createEnvironmentMutation = useMutation({
    mutationFn: async ({ platformId, productId, name }: { platformId: number; productId: number; name: string }) => {
      const res = await apiRequest("POST", `/api/platforms/${platformId}/products/${productId}/environments`, { name });
      return res.json() as Promise<PlatformProductEnvironment>;
    },
    onSuccess: (_environment, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/platforms"] });
      setClosedProducts(prev => {
        const next = new Set(prev);
        next.delete(variables.productId);
        return next;
      });
    },
  });

  const deleteEnvironmentMutation = useMutation({
    mutationFn: async ({ platformId, productId, environmentId }: { platformId: number; productId: number; environmentId: number }) => apiRequest("DELETE", `/api/platforms/${platformId}/products/${productId}/environments/${environmentId}`),
    onSuccess: () => {
      setPendingDelete(null);
      queryClient.invalidateQueries({ queryKey: ["/api/platforms"] });
    },
  });

  const deleteProductMutation = useMutation({
    mutationFn: async ({ platformId, productId }: { platformId: number; productId: number }) => apiRequest("DELETE", `/api/platforms/${platformId}/products/${productId}`),
    onSuccess: () => {
      setPendingDelete(null);
      queryClient.invalidateQueries({ queryKey: ["/api/platforms"] });
    },
  });

  const togglePlatform = (id: number) => {
    setClosedPlatforms(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleProduct = (id: number) => {
    setClosedProducts(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const startRenamePlatform = (platform: Platform) => {
    setRenameTarget({ type: "platform", id: platform.id });
    setRenameValue(platform.name);
  };

  const startRenameProduct = (platform: Platform, product: PlatformProduct) => {
    setRenameTarget({ type: "product", id: product.id, platformId: platform.id });
    setRenameValue(product.name);
  };

  const cancelRename = () => {
    setRenameTarget(null);
    setRenameValue("");
  };

  const commitRename = () => {
    if (!renameTarget) return;
    const name = renameValue.trim();
    if (!name) {
      cancelRename();
      return;
    }
    if (renameTarget.type === "platform") {
      updatePlatformMutation.mutate({ id: renameTarget.id, name });
    } else {
      updateProductMutation.mutate({ platformId: renameTarget.platformId, productId: renameTarget.id, name });
    }
    cancelRename();
  };

  const createNewPlatform = () => {
    if (createPlatformMutation.isPending) return;
    createPlatformMutation.mutate("New Platform");
  };

  const createNewProduct = (platform: Platform) => {
    if (createProductMutation.isPending) return;
    createProductMutation.mutate({ platformId: platform.id, name: "New Product" });
  };

  const createNewEnvironment = (platform: Platform, product: PlatformProduct) => {
    if (createEnvironmentMutation.isPending) return;
    createEnvironmentMutation.mutate({ platformId: platform.id, productId: product.id, name: "New Environment" });
  };

  const confirmDelete = () => {
    if (!pendingDelete) return;

    if (pendingDelete.type === "platform") {
      deletePlatformMutation.mutate(pendingDelete.platform.id);
      return;
    }

    if (pendingDelete.type === "product") {
      deleteProductMutation.mutate({
        platformId: pendingDelete.platform.id,
        productId: pendingDelete.product.id,
      });
      return;
    }

    deleteEnvironmentMutation.mutate({
      platformId: pendingDelete.platform.id,
      productId: pendingDelete.product.id,
      environmentId: pendingDelete.environment.id,
    });
  };

  const deleteTitle = pendingDelete?.type === "platform"
    ? "Delete platform"
    : pendingDelete?.type === "product"
      ? "Delete product"
      : "Delete environment";
  const deleteDescription = pendingDelete?.type === "platform"
    ? `Delete ${pendingDelete.platform.name} and its ${pendingDelete.platform.products.length} products? This cannot be undone.`
    : pendingDelete?.type === "product"
      ? `Delete ${pendingDelete.product.name} from ${pendingDelete.platform.name}? This cannot be undone.`
      : `Delete ${pendingDelete?.environment.name} from ${pendingDelete?.product.name}? This cannot be undone.`;
  const deletePending = deletePlatformMutation.isPending || deleteProductMutation.isPending || deleteEnvironmentMutation.isPending;

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="min-w-0 p-2 space-y-1">
          <button
            type="button"
            onClick={createNewPlatform}
            disabled={createPlatformMutation.isPending}
            className="flex items-center gap-2 w-full px-2 py-1.5 text-sm text-cta hover:text-cta/80 hover:bg-accent/70 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="button-new-platform"
          >
            <Plus className="h-3.5 w-3.5 shrink-0" />
            <span>New Platform</span>
          </button>

          {isLoading ? (
            <div className="space-y-2 py-1">
              <Skeleton className="h-8 rounded-md" />
              <Skeleton className="ml-6 h-8 rounded-md" />
              <Skeleton className="ml-12 h-8 rounded-md" />
            </div>
          ) : platforms.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Boxes className="mb-3 h-6 w-6 text-muted-foreground" />
              <p className="text-sm font-medium text-foreground">No platforms yet</p>
              <p className="mt-1 text-sm text-muted-foreground">Create the first platform, then add products underneath it.</p>
            </div>
          ) : platforms.map(platform => {
            const platformOpen = !closedPlatforms.has(platform.id);
            const platformRenaming = renameTarget?.type === "platform" && renameTarget.id === platform.id;
            return (
              <div key={platform.id} className="space-y-0 mt-0">
                <PlatformTreeRow
                  depth={0}
                  icon={Boxes}
                  title={platform.name}
                  onSelect={() => togglePlatform(platform.id)}
                  onRename={() => startRenamePlatform(platform)}
                  isRenaming={platformRenaming}
                  renameValue={renameValue}
                  onRenameValueChange={setRenameValue}
                  onRenameCommit={commitRename}
                  onRenameCancel={cancelRename}
                  testId={`platform-item-${platform.id}`}
                  expander={
                    <RowExpander
                      open={platformOpen}
                      onToggle={() => togglePlatform(platform.id)}
                      label={platformOpen ? "Collapse platform" : "Expand platform"}
                    />
                  }
                  menu={
                    <RowMenu label={`Open ${platform.name} actions`}>
                      <DropdownMenuItem onClick={(event) => { event.stopPropagation(); startRenamePlatform(platform); }}>
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={(event) => { event.stopPropagation(); createNewProduct(platform); }} disabled={createProductMutation.isPending}>
                        <Plus className="mr-2 h-4 w-4" />
                        Add product
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={(event) => { event.stopPropagation(); setPendingDelete({ type: "platform", platform }); }}
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete platform
                      </DropdownMenuItem>
                    </RowMenu>
                  }
                />

                {platformOpen && (
                  <div className="space-y-0 mt-0">
                    {platform.products.length === 0 ? (
                      <EmptyTreeRow depth={1} title="No products yet" />
                    ) : platform.products.map(product => {
                      const productOpen = !closedProducts.has(product.id);
                      const productRenaming = renameTarget?.type === "product" && renameTarget.id === product.id;
                      return (
                        <div key={product.id} className="space-y-0 mt-0">
                          <PlatformTreeRow
                            depth={1}
                            icon={Package}
                            title={product.name}
                            onSelect={() => toggleProduct(product.id)}
                            onRename={() => startRenameProduct(platform, product)}
                            isRenaming={productRenaming}
                            renameValue={renameValue}
                            onRenameValueChange={setRenameValue}
                            onRenameCommit={commitRename}
                            onRenameCancel={cancelRename}
                            testId={`platform-product-${product.id}`}
                            expander={
                              <RowExpander
                                open={productOpen}
                                onToggle={() => toggleProduct(product.id)}
                                label={productOpen ? "Collapse product" : "Expand product"}
                              />
                            }
                            menu={
                              <RowMenu label={`Open ${product.name} actions`}>
                                <DropdownMenuItem onClick={(event) => { event.stopPropagation(); startRenameProduct(platform, product); }}>
                                  Rename
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={(event) => { event.stopPropagation(); createNewEnvironment(platform, product); }} disabled={createEnvironmentMutation.isPending}>
                                  <Plus className="mr-2 h-4 w-4" />
                                  Add environment
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  className="text-destructive focus:text-destructive"
                                  onClick={(event) => { event.stopPropagation(); setPendingDelete({ type: "product", platform, product }); }}
                                >
                                  <Trash2 className="mr-2 h-4 w-4" />
                                  Delete product
                                </DropdownMenuItem>
                              </RowMenu>
                            }
                          />
                          {productOpen && (
                            <div className="space-y-0 mt-0">
                              {product.environments.length === 0 ? (
                                <EmptyTreeRow depth={2} title="No environments yet" />
                              ) : product.environments.map(environment => (
                                <EnvironmentRow
                                  key={environment.id}
                                  environment={environment}
                                  onOpen={() => setLocation(`/platforms/environments/${environment.id}`)}
                                  onDelete={() => setPendingDelete({ type: "environment", platform, product, environment })}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <AlertDialog open={!!pendingDelete} onOpenChange={(open) => { if (!open) setPendingDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{deleteTitle}</AlertDialogTitle>
            <AlertDialogDescription>{deleteDescription}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletePending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={confirmDelete}
              disabled={deletePending}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
