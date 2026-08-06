import { useMemo, type ReactNode } from "react";
import { useQueries } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { usePageHeader } from "@/hooks/use-page-header";
import { apiRequest } from "@/lib/queryClient";
import { useVisibleVaults } from "@/pages/library/use-vault-sections";
import {
  DriveResourceTree,
  RecentResourceRow,
  type DriveResource,
} from "@/pages/library/drive-tree";

/**
 * Files — the read-only data plane for vault-bound connector resources.
 *
 * Mirrors the Library tree: a RECENT section followed by one section per
 * visible vault, rows populated by whatever the connectors (Google Drive, Box,
 * Mantra storage) expose. There is intentionally no connect / bind / allow-list
 * UI here — that control plane lives in the Integrations surface. This surface
 * only browses what is already wired.
 */

const RECENT_LIMIT = 8;

function SectionHeader({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 pt-4 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}

export default function FilesPage() {
  usePageHeader({ title: "Files" });

  const { visibleVaults, isLoading: vaultsLoading } = useVisibleVaults();

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

  const perVault = useMemo(
    () =>
      visibleVaults.map((vault, i) => ({
        vault,
        resources: resourceQueries[i]?.data?.resources ?? [],
      })),
    [visibleVaults, resourceQueries],
  );

  const recent = useMemo(() => {
    const flat: { resource: DriveResource; vaultColor: string | null }[] = [];
    for (const { vault, resources } of perVault) {
      for (const resource of resources) {
        flat.push({ resource, vaultColor: vault.color ?? null });
      }
    }
    return flat.slice(0, RECENT_LIMIT);
  }, [perVault]);

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-y-auto"
      data-testid="files-page"
    >
      <div className="mx-auto w-full max-w-3xl px-4 pb-8">
        {vaultsLoading ? (
          <div className="flex items-center gap-2 px-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading files…
          </div>
        ) : (
          <>
            <SectionHeader>Recent</SectionHeader>
            {recent.length === 0 ? (
              <div className="px-2 py-1 pl-2 text-xs text-muted-foreground">
                No files yet
              </div>
            ) : (
              <div className="flex flex-col gap-0.5">
                {recent.map(({ resource, vaultColor }) => (
                  <RecentResourceRow
                    key={resource.id}
                    resource={resource}
                    vaultColor={vaultColor}
                  />
                ))}
              </div>
            )}

            {perVault.map(({ vault, resources }) => (
              <div key={vault.id}>
                <SectionHeader>{vault.name}</SectionHeader>
                <DriveResourceTree
                  vaultId={vault.id}
                  resources={resources}
                  vaultColor={vault.color ?? null}
                />
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
