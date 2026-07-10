import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Vault as VaultIcon,
  Plus,
  Pencil,
  Archive,
  Star,
  Loader2,
  Eye,
  EyeOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useVaults, type Vault } from "@/hooks/use-vaults";
import { useToast } from "@/hooks/use-toast";
import { createLogger } from "@/lib/logger";

const log = createLogger("VaultsAdmin");

// ── Color palette (muted tones matching DESIGN.md) ─────────────────────────

const VAULT_COLORS = [
  { value: "#828A96", label: "Slate" },
  { value: "#6E8B74", label: "Sage" },
  { value: "#7B8CDE", label: "Periwinkle" },
  { value: "#C4956A", label: "Amber" },
  { value: "#B07BAC", label: "Mauve" },
  { value: "#6BA3B5", label: "Teal" },
  { value: "#C27878", label: "Rose" },
  { value: "#9B9B6F", label: "Olive" },
];

function ColorDot({ color, selected, onClick }: { color: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-6 w-6 rounded-full border-2 transition-all ${
        selected ? "border-foreground scale-110" : "border-transparent hover:border-muted-foreground/40"
      }`}
      style={{ backgroundColor: color }}
    />
  );
}

// ── Create vault dialog ────────────────────────────────────────────────────

function CreateVaultDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(VAULT_COLORS[0].value);
  const { toast } = useToast();

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/vaults", { name, color });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/vaults"] });
      toast({ title: "Vault created", description: `"${name}" is ready.` });
      setName("");
      setColor(VAULT_COLORS[0].value);
      onOpenChange(false);
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : "Failed to create vault";
      log.error("create vault failed", { error: msg });
      toast({ title: "Failed to create vault", description: msg, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create vault</DialogTitle>
          <DialogDescription>A vault is a separate data partition. All new data goes to the active vault.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-foreground">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Mantra, Personal"
              className="mt-1.5"
              autoFocus
            />
          </div>
          <div>
            <label className="text-sm font-medium text-foreground">Color</label>
            <div className="mt-1.5 flex gap-2">
              {VAULT_COLORS.map((c) => (
                <ColorDot key={c.value} color={c.value} selected={color === c.value} onClick={() => setColor(c.value)} />
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => createMutation.mutate()} disabled={!name.trim() || createMutation.isPending}>
            {createMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Rename dialog ──────────────────────────────────────────────────────────

function RenameDialog({ vault, open, onOpenChange }: { vault: Vault; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [newName, setNewName] = useState(vault.name);
  const [newColor, setNewColor] = useState(vault.color || VAULT_COLORS[0].value);
  const { toast } = useToast();

  const renameMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, string> = {};
      if (newName !== vault.name) body.name = newName;
      if (newColor !== vault.color) body.color = newColor;
      const res = await apiRequest("PATCH", `/api/vaults/${vault.id}`, body);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/vaults"] });
      toast({ title: "Vault updated" });
      onOpenChange(false);
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : "Failed to update vault";
      log.error("rename vault failed", { error: msg, vaultId: vault.id });
      toast({ title: "Failed to update vault", description: msg, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit vault</DialogTitle>
          <DialogDescription>Rename or change the color of "{vault.name}".</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-foreground">Name</label>
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} className="mt-1.5" autoFocus />
          </div>
          <div>
            <label className="text-sm font-medium text-foreground">Color</label>
            <div className="mt-1.5 flex gap-2">
              {VAULT_COLORS.map((c) => (
                <ColorDot key={c.value} color={c.value} selected={newColor === c.value} onClick={() => setNewColor(c.value)} />
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => renameMutation.mutate()} disabled={!newName.trim() || renameMutation.isPending}>
            {renameMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Archive confirm dialog ─────────────────────────────────────────────────

function ArchiveDialog({ vault, open, onOpenChange }: { vault: Vault; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { toast } = useToast();

  const archiveMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", `/api/vaults/${vault.id}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/vaults"] });
      toast({ title: "Vault archived", description: `"${vault.name}" has been archived. Data is preserved but hidden.` });
      onOpenChange(false);
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : "Failed to archive vault";
      log.error("archive vault failed", { error: msg, vaultId: vault.id });
      toast({ title: "Failed to archive vault", description: msg, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Archive vault</DialogTitle>
          <DialogDescription>
            Archive "{vault.name}"? Data inside will be preserved but hidden from all surfaces.
            This cannot be undone from the UI.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="destructive" onClick={() => archiveMutation.mutate()} disabled={archiveMutation.isPending}>
            {archiveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Archive
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Vault row ──────────────────────────────────────────────────────────────

function VaultRow({ vault }: { vault: Vault }) {
  const { activeVaultId, isVisible, setActiveVault, vaults: allVaults } = useVaults();
  const isActive = vault.id === activeVaultId;
  const visible = isVisible(vault.id);
  const [renameOpen, setRenameOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);

  const nonArchivedCount = allVaults.filter((v) => !v.isArchived).length;
  const canArchive = !isActive && nonArchivedCount > 1;

  return (
    <>
      <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
        {/* Color dot */}
        <div className="h-3 w-3 rounded-full flex-shrink-0" style={{ backgroundColor: vault.color || "#828A96" }} />

        {/* Name + badges */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground truncate">{vault.name}</span>
            {isActive && (
              <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                <Star className="h-3 w-3" />
                Active
              </span>
            )}
            {vault.isDefault && (
              <span className="text-xs text-muted-foreground">(default)</span>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            {visible ? (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Eye className="h-3 w-3" /> Visible
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground/50">
                <EyeOff className="h-3 w-3" /> Hidden
              </span>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1">
          {!isActive && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setActiveVault(vault.id)}>
                  <Star className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Set as active vault</TooltipContent>
            </Tooltip>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setRenameOpen(true)}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Edit vault</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                  onClick={() => setArchiveOpen(true)}
                  disabled={!canArchive}
                >
                  <Archive className="h-3.5 w-3.5" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {isActive
                ? "Switch active vault first"
                : nonArchivedCount <= 1
                  ? "Cannot archive your last vault"
                  : "Archive vault"}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <RenameDialog vault={vault} open={renameOpen} onOpenChange={setRenameOpen} />
      <ArchiveDialog vault={vault} open={archiveOpen} onOpenChange={setArchiveOpen} />
    </>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────

export default function VaultsAdminPage() {
  const { vaults, isLoading } = useVaults();
  const [createOpen, setCreateOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto min-h-0 scrollbar-thin p-6">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <VaultIcon className="h-5 w-5 text-muted-foreground" />
            <div>
              <h2 className="text-xl font-semibold text-foreground">Vaults</h2>
              <p className="text-sm text-muted-foreground">Manage data partitions. Each vault isolates sessions, memory, and all user data.</p>
            </div>
          </div>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Create vault
          </Button>
        </div>

        {vaults.length === 0 ? (
          <div className="rounded-lg border border-border bg-card py-12 text-center">
            <VaultIcon className="h-6 w-6 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No vaults found.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {vaults.map((vault) => (
              <VaultRow key={vault.id} vault={vault} />
            ))}
          </div>
        )}
      </div>

      <CreateVaultDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
