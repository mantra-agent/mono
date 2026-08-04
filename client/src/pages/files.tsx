// Use createLogger for logging ONLY
import { createLogger } from "@/lib/logger";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePageHeader } from "@/hooks/use-page-header";
import { useVaults } from "@/hooks/use-vaults";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { HardDrive, Loader2, Plug, FolderOpen } from "lucide-react";
import { Link } from "wouter";
import { DriveBranch } from "@/pages/library/drive-branch";

const log = createLogger("files-page");

type ConnectedAccount = {
  accountId?: number | string;
  id?: number | string;
  provider: string;
  email?: string | null;
  displayName?: string | null;
  label?: string | null;
  status?: string | null;
};

const FILE_PROVIDERS = [
  {
    id: "google",
    label: "Google Drive",
    description: "Bound Drive folders and files via Picker",
  },
  {
    id: "box",
    label: "Box",
    description: "Bound Box folders through the Files API",
  },
  {
    id: "mantra",
    label: "Mantra Storage",
    description: "Native object storage for agent and user files",
  },
] as const;

export default function FilesPage() {
  usePageHeader({ title: "Files" });
  const { vaults, activeVaultId, isLoading: vaultsLoading } = useVaults();
  const [selectedVaultId, setSelectedVaultId] = useState<string | null>(null);

  const vaultId = selectedVaultId ?? activeVaultId ?? vaults[0]?.id ?? null;

  const { data: accountsPayload, isLoading: accountsLoading } = useQuery<{
    accounts?: ConnectedAccount[];
  }>({
    queryKey: ["/api/accounts"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/accounts");
      return res.json();
    },
  });
  const accounts = accountsPayload?.accounts ?? [];

  const accountsByProvider = useMemo(() => {
    const map = new Map<string, ConnectedAccount[]>();
    for (const account of accounts) {
      const key = String(account.provider || "").toLowerCase();
      const list = map.get(key) ?? [];
      list.push(account);
      map.set(key, list);
    }
    return map;
  }, [accounts]);

  const selectedVault = vaults.find((vault) => vault.id === vaultId) ?? null;

  log.debug("files page render", {
    vaultId,
    vaultCount: vaults.length,
    accountCount: accounts.length,
  });

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="files-page">
      <div className="border-b border-border px-6 py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <HardDrive className="h-5 w-5 text-muted-foreground" />
              <h1 className="text-xl font-semibold tracking-tight">Files</h1>
            </div>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Connected file providers and the folders bound into each vault.
              Library pages stay on Library — this surface is connectors only.
            </p>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href="/integrations">
              <Plug className="mr-2 h-4 w-4" />
              Manage connectors
            </Link>
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-medium text-muted-foreground">Providers</h2>
          <div className="grid gap-3 md:grid-cols-3">
            {FILE_PROVIDERS.map((provider) => {
              const connected = accountsByProvider.get(provider.id) ?? [];
              const isNative = provider.id === "mantra";
              const statusLabel = isNative
                ? "Built-in"
                : connected.length > 0
                  ? "Connected"
                  : "Not connected";
              return (
                <div
                  key={provider.id}
                  className="rounded-lg border border-border bg-card p-4"
                  data-testid={`files-provider-${provider.id}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-medium">{provider.label}</div>
                      <p className="mt-1 text-sm text-muted-foreground">{provider.description}</p>
                    </div>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 text-xs",
                        isNative || connected.length > 0
                          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      {accountsLoading && !isNative ? "…" : statusLabel}
                    </span>
                  </div>
                  {!isNative && connected.length > 0 && (
                    <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
                      {connected.map((account) => {
                        const key = String(account.accountId ?? account.id ?? account.email ?? account.provider);
                        return (
                          <li key={key}>
                            {account.email || account.displayName || account.label || `Account ${key}`}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {!isNative && connected.length === 0 && (
                    <Button asChild variant="link" className="mt-2 h-auto px-0 text-sm">
                      <Link href="/integrations">Connect {provider.label}</Link>
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <section>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-medium text-muted-foreground">Bound folders</h2>
            {vaults.length > 1 && (
              <div className="flex flex-wrap gap-2">
                {vaults.map((vault) => (
                  <button
                    key={vault.id}
                    type="button"
                    onClick={() => setSelectedVaultId(vault.id)}
                    className={cn(
                      "rounded-md border px-2.5 py-1 text-xs transition-colors",
                      vaultId === vault.id
                        ? "border-foreground/20 bg-muted font-medium"
                        : "border-border text-muted-foreground hover:bg-muted/60",
                    )}
                    data-testid={`files-vault-${vault.id}`}
                  >
                    {vault.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          {vaultsLoading ? (
            <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading vaults…
            </div>
          ) : !vaultId || !selectedVault ? (
            <div className="rounded-lg border border-dashed border-border px-6 py-12 text-center">
              <FolderOpen className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
              <p className="text-sm font-medium">No vault available</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Create a vault before binding external folders.
              </p>
              <Button asChild variant="outline" size="sm" className="mt-4">
                <Link href="/vaults">Open Vaults</Link>
              </Button>
            </div>
          ) : (
            <div className="rounded-lg border border-border bg-card">
              <div className="border-b border-border px-4 py-3">
                <div className="text-sm font-medium">{selectedVault.name}</div>
                <p className="text-xs text-muted-foreground">
                  Explicit binds only — browse children through the Files API, no ambient crawl.
                </p>
              </div>
              <div className="px-2 py-3">
                <DriveBranch vaultId={vaultId} />
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
