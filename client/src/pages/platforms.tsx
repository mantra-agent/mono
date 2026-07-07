import { useState, type ComponentType, type ReactNode } from "react";
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
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { Boxes, ChevronRight, Plus, Trash2, X } from "lucide-react";

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

type PendingDelete =
  | { type: "platform"; platform: Platform }
  | { type: "product"; platform: Platform; product: PlatformProduct }
  | { type: "environment"; platform: Platform; product: PlatformProduct; environment: PlatformProductEnvironment };

function TreeRow({
  depth,
  icon: Icon,
  title,
  children,
  onClick,
  muted,
}: {
  depth: number;
  icon?: ComponentType<{ className?: string }>;
  title: string;
  children?: ReactNode;
  onClick?: () => void;
  muted?: boolean;
}) {
  const className = cn(
    "group relative flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
    muted ? "text-muted-foreground hover:bg-accent/50 hover:text-foreground" : "text-foreground hover:bg-accent/50",
  );
  const content = (
    <>
      {Icon && <Icon className="h-3.5 w-3.5 shrink-0" />}
      {children || <span className="truncate">{title}</span>}
    </>
  );

  return (
    <div className="flex" style={{ paddingLeft: Math.min(depth * 16, 96) }}>
      {depth > 0 && (
        <div className="relative mr-1 w-5 self-stretch" aria-hidden="true">
          <div className="absolute bottom-1/2 left-1/2 top-0 border-l border-border/50" />
          <div className="absolute left-1/2 right-0 top-1/2 border-t border-border/50" />
        </div>
      )}
      {onClick ? (
        <div
          role="button"
          tabIndex={0}
          className={cn(className, "cursor-pointer")}
          onClick={onClick}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onClick();
            }
          }}
          title={title}
        >
          {content}
        </div>
      ) : (
        <div className={className} title={title}>{content}</div>
      )}
    </div>
  );
}

function InlineCreateRow({
  depth,
  placeholder,
  value,
  onChange,
  onSubmit,
  onCancel,
  disabled,
}: {
  depth: number;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 py-1 pr-2" style={{ paddingLeft: 8 + Math.min(depth * 16, 96) }}>
      {depth > 0 && <div className="w-6" />}
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-8 text-sm"
        autoFocus
        onKeyDown={(event) => {
          if (event.key === "Enter") onSubmit();
          if (event.key === "Escape") onCancel?.();
        }}
      />
      <Button size="sm" className="h-8 px-3" onClick={onSubmit} disabled={disabled || !value.trim()}>
        Add
      </Button>
      {onCancel && (
        <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={onCancel}>
          <X className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}

export default function PlatformsPage() {
  usePageHeader({ title: "Platforms" });
  const [, setLocation] = useLocation();
  const [closedPlatforms, setClosedPlatforms] = useState<Set<number>>(() => new Set());
  const [openProducts, setOpenProducts] = useState<Set<number>>(() => new Set());
  const [newPlatformName, setNewPlatformName] = useState("");
  const [addingProductFor, setAddingProductFor] = useState<number | null>(null);
  const [newProductName, setNewProductName] = useState("");
  const [addingEnvironmentFor, setAddingEnvironmentFor] = useState<number | null>(null);
  const [newEnvironmentName, setNewEnvironmentName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);

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
      setNewPlatformName("");
      setClosedPlatforms(prev => {
        const next = new Set(prev);
        next.delete(platform.id);
        return next;
      });
    },
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
    onSuccess: (_product, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/platforms"] });
      setNewProductName("");
      setAddingProductFor(null);
      setClosedPlatforms(prev => {
        const next = new Set(prev);
        next.delete(variables.platformId);
        return next;
      });
      setOpenProducts(prev => new Set(prev).add(_product.id));
    },
  });

  const createEnvironmentMutation = useMutation({
    mutationFn: async ({ platformId, productId, name }: { platformId: number; productId: number; name: string }) => {
      const res = await apiRequest("POST", `/api/platforms/${platformId}/products/${productId}/environments`, { name });
      return res.json() as Promise<PlatformProductEnvironment>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/platforms"] });
      setNewEnvironmentName("");
      setAddingEnvironmentFor(null);
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
    setOpenProducts(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submitPlatform = () => {
    const name = newPlatformName.trim();
    if (!name) return;
    createPlatformMutation.mutate(name);
  };

  const submitProduct = (platformId: number) => {
    const name = newProductName.trim();
    if (!name) return;
    createProductMutation.mutate({ platformId, name });
  };

  const submitEnvironment = (platformId: number, productId: number) => {
    const name = newEnvironmentName.trim();
    if (!name) return;
    createEnvironmentMutation.mutate({ platformId, productId, name });
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
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background">
      <div className="flex items-center gap-3 border-b border-border/50 px-3 py-2">
        <Button size="sm" className="h-8 gap-1.5" onClick={submitPlatform} disabled={!newPlatformName.trim() || createPlatformMutation.isPending}>
          <Plus className="h-3.5 w-3.5" />
          New Platform
        </Button>
        <Input
          value={newPlatformName}
          onChange={(event) => setNewPlatformName(event.target.value)}
          placeholder="Platform name..."
          className="h-8 max-w-sm text-sm"
          onKeyDown={(event) => {
            if (event.key === "Enter") submitPlatform();
          }}
        />
      </div>

      <div className="flex-1 overflow-y-auto p-3 scrollbar-thin">
        <div className="space-y-0.5">
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-8 rounded-md" />
              <Skeleton className="ml-9 h-8 rounded-md" />
              <Skeleton className="h-8 rounded-md" />
            </div>
          ) : platforms.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Boxes className="mb-3 h-6 w-6 text-muted-foreground" />
              <p className="text-sm font-medium text-foreground">No platforms yet</p>
              <p className="mt-1 text-sm text-muted-foreground">Create the first platform, then add products underneath it.</p>
            </div>
          ) : platforms.map(platform => {
            const open = !closedPlatforms.has(platform.id);
            return (
              <div key={platform.id} className="space-y-0.5">
                <div className="group flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground hover-elevate">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                    onClick={() => togglePlatform(platform.id)}
                    title={platform.name}
                  >
                    <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
                    <span className="truncate">{platform.name.toUpperCase()}</span>
                  </button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 gap-1 px-2 text-xs font-normal normal-case tracking-normal opacity-0 transition-opacity group-hover:opacity-100"
                    onClick={(event) => {
                      event.stopPropagation();
                      setAddingProductFor(platform.id);
                      setClosedPlatforms(prev => {
                        const next = new Set(prev);
                        next.delete(platform.id);
                        return next;
                      });
                    }}
                  >
                    <Plus className="h-3 w-3" /> Product
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
                    onClick={(event) => {
                      event.stopPropagation();
                      setPendingDelete({ type: "platform", platform });
                    }}
                    aria-label={`Delete ${platform.name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>

                {open && (
                  <div className="space-y-0.5">
                    {platform.products.length === 0 && addingProductFor !== platform.id ? (
                      <TreeRow depth={0} title="No products yet" muted />
                    ) : platform.products.map(product => {
                      const productOpen = openProducts.has(product.id);
                      return (
                        <div key={product.id} className="space-y-0.5">
                          <TreeRow depth={0} title={product.name} onClick={() => toggleProduct(product.id)}>
                            <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 transition-transform", productOpen && "rotate-90")} />
                            <span className="truncate font-medium">{product.name}</span>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="ml-auto h-6 gap-1 px-2 text-xs opacity-0 transition-opacity group-hover:opacity-100"
                              onClick={(event) => {
                                event.stopPropagation();
                                setAddingEnvironmentFor(product.id);
                                setOpenProducts(prev => new Set(prev).add(product.id));
                              }}
                            >
                              <Plus className="h-3 w-3" /> Env
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 w-6 p-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
                              onClick={(event) => {
                                event.stopPropagation();
                                setPendingDelete({ type: "product", platform, product });
                              }}
                              aria-label={`Delete ${product.name}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </TreeRow>
                          {productOpen && (
                            <>
                              {product.environments.length === 0 && addingEnvironmentFor !== product.id ? (
                                <TreeRow depth={1} title="No environments yet" muted />
                              ) : product.environments.map(environment => (
                                <TreeRow key={environment.id} depth={1} title={environment.name} onClick={() => setLocation(`/platforms/environments/${environment.id}`)}>
                                  <span className="truncate">{environment.name}</span>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="ml-auto h-6 w-6 p-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setPendingDelete({ type: "environment", platform, product, environment });
                                    }}
                                    aria-label={`Delete ${environment.name}`}
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </Button>
                                </TreeRow>
                              ))}
                              {addingEnvironmentFor === product.id && (
                                <InlineCreateRow
                                  depth={1}
                                  placeholder="Environment name..."
                                  value={newEnvironmentName}
                                  onChange={setNewEnvironmentName}
                                  onSubmit={() => submitEnvironment(platform.id, product.id)}
                                  onCancel={() => { setAddingEnvironmentFor(null); setNewEnvironmentName(""); }}
                                  disabled={createEnvironmentMutation.isPending}
                                />
                              )}
                            </>
                          )}
                        </div>
                      );
                    })}
                    {addingProductFor === platform.id && (
                      <InlineCreateRow
                        depth={0}
                        placeholder="Product name..."
                        value={newProductName}
                        onChange={setNewProductName}
                        onSubmit={() => submitProduct(platform.id)}
                        onCancel={() => { setAddingProductFor(null); setNewProductName(""); }}
                        disabled={createProductMutation.isPending}
                      />
                    )}
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
