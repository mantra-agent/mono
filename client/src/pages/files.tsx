import { useEffect, useMemo, useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearch } from "wouter";
import { Loader2 } from "lucide-react";
import { usePageHeader } from "@/hooks/use-page-header";
import { apiRequest } from "@/lib/queryClient";
import { HierarchySectionHeader } from "@/components/hierarchy-section-header";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import { useVisibleVaults } from "@/pages/library/use-vault-sections";
import {
  DriveResourceGroup,
  DriveResourceTree,
  FilesIndexProgressBanner,
  RecentResourceRow,
  isRunActive,
  type DriveResource,
  type FileIndexStatus,
} from "@/pages/library/drive-tree";

/**
 * Files — the data plane for vault-bound connector resources plus semantic
 * index policy controls.
 *
 * Mirrors the Library tree: a RECENT section followed by one section per
 * visible vault. Connector connect/bind/allow-list UI stays on Integrations.
 * This surface browses authorized resources and opts them into indexing.
 */

const RECENT_LIMIT = 8;
const COMPLETION_HOLD_MS = 8_000;

export default function FilesPage() {
  usePageHeader({ title: "Files" });

  const queryClient = useQueryClient();
  const { visibleVaults, isLoading: vaultsLoading } = useVisibleVaults();
  const search = useSearch();
  // Registry emits /files?driveResource=…; honor that deep link on the destination.
  const focusDriveResourceId = useMemo(() => {
    const raw = new URLSearchParams(search).get("driveResource")?.trim();
    return raw || null;
  }, [search]);
  const [searchQuery, setSearchQuery] = useState("");
  const uploadReconciliation = useQuery({
    queryKey: ["/api/files/uploads/reconcile"],
    queryFn: async () => {
      const res = await apiRequest("POST", "/api/files/uploads/reconcile");
      return res.json() as Promise<{ reconciliation: { scanned: number; registered: number; unassigned: number } }>;
    },
    staleTime: 60_000,
    retry: 1,
  });
  useEffect(() => {
    if (!uploadReconciliation.isSuccess) return;
    void queryClient.invalidateQueries({ queryKey: ["/api/drive/resources"] });
  }, [queryClient, uploadReconciliation.dataUpdatedAt, uploadReconciliation.isSuccess]);
  const trimmedQuery = searchQuery.trim().toLowerCase();
  const isSearching = trimmedQuery.length > 0;

  const resourceQueries = useQueries({
    queries: visibleVaults.map((v) => ({
      queryKey: ["/api/drive/resources", v.id],
      queryFn: async () => {
        const res = await apiRequest(
          "GET",
          `/api/drive/resources?vaultId=${encodeURIComponent(v.id)}`,
        );
        return (await res.json()) as { resources: DriveResource[] };
      },
      enabled: !!v.id,
    })),
  });

  const indexQueries = useQueries({
    queries: visibleVaults.map((v) => ({
      queryKey: ["/api/files/index/status", v.id],
      queryFn: async () => {
        const res = await apiRequest(
          "GET",
          `/api/files/index/status?vaultId=${encodeURIComponent(v.id)}`,
        );
        return (await res.json()) as { statuses: FileIndexStatus[] };
      },
      enabled: !!v.id,
      staleTime: 5_000,
      refetchInterval: (query: { state: { data?: { statuses?: FileIndexStatus[] } } }) => {
        const statuses = query.state.data?.statuses ?? [];
        const hasActive = statuses.some((s) => isRunActive(s.reconciliationRun));
        const hasFreshComplete = statuses.some((s) => {
          const run = s.reconciliationRun;
          if (!run?.completedAt || run.phase !== "complete") return false;
          const age = Date.now() - Date.parse(run.completedAt);
          return Number.isFinite(age) && age >= 0 && age < COMPLETION_HOLD_MS;
        });
        return hasActive || hasFreshComplete ? 2_500 : false;
      },
    })),
  });

  const perVault = useMemo(
    () =>
      visibleVaults.map((vault, i) => {
        const statuses = indexQueries[i]?.data?.statuses ?? [];
        const statusByResourceId = new Map(
          statuses.map((s) => [s.driveResourceId, s] as const),
        );
        return {
          vault,
          resources: resourceQueries[i]?.data?.resources ?? [],
          statuses,
          statusByResourceId,
        };
      }),
    [visibleVaults, resourceQueries, indexQueries],
  );

  const allStatuses = useMemo(
    () => perVault.flatMap((v) => v.statuses),
    [perVault],
  );

  const recent = useMemo(() => {
    const flat: {
      resource: DriveResource;
      vaultId: string;
      vaultColor: string | null;
      status?: FileIndexStatus;
    }[] = [];
    for (const { vault, resources, statusByResourceId } of perVault) {
      for (const resource of resources) {
        flat.push({
          resource,
          vaultId: vault.id,
          vaultColor: vault.color ?? null,
          status: statusByResourceId.get(resource.id),
        });
      }
    }
    return flat.slice(0, RECENT_LIMIT);
  }, [perVault]);

  // Vault sections show only bound roots. A SessionsMenu-style search filters
  // those roots by name; folder descendants load lazily and are not searched.
  const vaultSections = useMemo(
    () =>
      perVault.map(({ vault, resources, statusByResourceId }) => {
        const rootResources = resources.filter((resource) => {
          if (resource.origin === "upload") return false;
          const rootId = statusByResourceId.get(resource.id)?.indexedSource
            ?.rootDriveResourceId;
          return !rootId || rootId === resource.id;
        });
        const uploads = resources.filter((resource) => resource.origin === "upload");
        const visibleResources = isSearching
          ? rootResources.filter((resource) =>
              resource.name.toLowerCase().includes(trimmedQuery),
            )
          : rootResources;
        const visibleUploads = isSearching
          ? uploads.filter((resource) => resource.name.toLowerCase().includes(trimmedQuery))
          : uploads;
        return { vault, visibleResources, visibleUploads, statusByResourceId };
      }),
    [perVault, isSearching, trimmedQuery],
  );

  const noSearchMatches =
    isSearching && vaultSections.every((s) => s.visibleResources.length === 0 && s.visibleUploads.length === 0);

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-y-auto"
      data-testid="files-page"
    >
      <div className="w-full min-w-0 p-2 pb-8">
        {vaultsLoading ? (
          <div className="flex items-center gap-2 px-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading files…
          </div>
        ) : (
          <>
            <div className="pt-4">
              <FilesIndexProgressBanner statuses={allStatuses} />
              {uploadReconciliation.isLoading ? (
                <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reconciling uploads…
                </div>
              ) : uploadReconciliation.isError ? (
                <div className="px-2 py-1.5 text-sm text-destructive">Upload reconciliation failed</div>
              ) : null}
            </div>

            <div className="pt-1">
              <HierarchySearchInput
                value={searchQuery}
                onChange={setSearchQuery}
                inputTestId="input-search-files"
                clearTestId="button-clear-files-search"
                ariaLabel="Search files"
              />
            </div>

            {!isSearching && (
              <>
                <HierarchySectionHeader className="mt-2">
                  Recent
                </HierarchySectionHeader>
                {recent.length === 0 ? (
                  <div className="px-2 py-1.5 text-sm text-muted-foreground">
                    Nothing recent yet.
                  </div>
                ) : (
                  <div className="flex flex-col">
                    {recent.map(({ resource, vaultId, vaultColor }) => (
                      <RecentResourceRow
                        key={resource.id}
                        resource={resource}
                        vaultId={vaultId}
                        vaultColor={vaultColor}
                      />
                    ))}
                  </div>
                )}
              </>
            )}

            {vaultSections.map(({ vault, visibleResources, visibleUploads, statusByResourceId }) => {
              if (isSearching && visibleResources.length === 0 && visibleUploads.length === 0) return null;
              return (
                <div key={vault.id}>
                  <HierarchySectionHeader className="mt-2">
                    {vault.name}
                  </HierarchySectionHeader>
                  <DriveResourceTree
                    vaultId={vault.id}
                    resources={visibleResources}
                    vaultColor={vault.color ?? null}
                    statusByResourceId={statusByResourceId}
                    focusDriveResourceId={focusDriveResourceId}
                  />
                  {visibleUploads.length > 0 ? (
                    <DriveResourceGroup
                      key={`${vault.id}:${isSearching ? "search" : "browse"}`}
                      label="Uploads"
                      defaultOpen={isSearching || (!!focusDriveResourceId && visibleUploads.some((u) => u.id === focusDriveResourceId))}
                      vaultColor={vault.color ?? null}
                    >
                      <DriveResourceTree
                        vaultId={vault.id}
                        resources={visibleUploads}
                        vaultColor={vault.color ?? null}
                        statusByResourceId={statusByResourceId}
                        focusDriveResourceId={focusDriveResourceId}
                      />
                    </DriveResourceGroup>
                  ) : null}
                </div>
              );
            })}

            {noSearchMatches && (
              <div className="px-2 py-1.5 text-sm text-muted-foreground">
                No matching files.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
