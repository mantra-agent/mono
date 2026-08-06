import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { Eye, EyeOff, KeyRound, Loader2 } from "lucide-react";
import type { SecretMetadata, SecretSection } from "@shared/secrets-catalog";

export function useIsAdmin(): boolean {
  return useAuth().hasPermission("system:write");
}

interface SecretControlProps {
  name: string;
}

/**
 * A single secret rendered as a canonical TreeView row (ProfileTreeRow):
 * label + key icon on the left, masked status on the right, and Rotate/Clear
 * in the hover overflow menu. Editing opens an inline field directly beneath
 * the row — no cards, matching the SOURCE section on the environment detail page.
 */
export function SecretControl({ name }: SecretControlProps) {
  const { toast } = useToast();
  const isAdmin = useIsAdmin();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [showValue, setShowValue] = useState(false);

  const { data, isLoading } = useQuery<{ secrets: SecretMetadata[] }>({
    queryKey: ["/api/secrets/metadata"],
  });

  const meta = data?.secrets.find(s => s.name === name);

  const setMutation = useMutation({
    mutationFn: async (newValue: string) => {
      return apiRequest("POST", "/api/secrets/set", {
        name,
        value: newValue,
        privilegedReason: `Admin updating secret ${name} via integrations UI`,
        privilegedScope: "secrets",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/secrets/metadata"] });
      queryClient.invalidateQueries({ queryKey: ["/api/setup/secrets-status"] });
      toast({ title: "Secret saved", description: `${name} updated.` });
      closeEditor();
    },
    onError: (err: Error) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const clearMutation = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/secrets/clear", {
      name,
      privilegedReason: `Admin clearing secret ${name} via integrations UI`,
      privilegedScope: "secrets",
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/secrets/metadata"] });
      queryClient.invalidateQueries({ queryKey: ["/api/setup/secrets-status"] });
      toast({ title: "Secret cleared", description: `${name} removed from app storage.` });
    },
    onError: (err: Error) => {
      toast({ title: "Clear failed", description: err.message, variant: "destructive" });
    },
  });

  function closeEditor() {
    setEditing(false);
    setValue("");
    setShowValue(false);
  }

  function save() {
    if (!value.trim()) {
      toast({ title: "Value required", variant: "destructive" });
      return;
    }
    setMutation.mutate(value.trim());
  }

  if (isLoading || !meta) {
    return (
      <ProfileTreeRow
        label={name}
        icon={<KeyRound className="h-3.5 w-3.5" />}
        hasValue
        showEmpty
        testId={`secret-loading-${name}`}
      >
        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
      </ProfileTreeRow>
    );
  }

  const status = (() => {
    if (meta.status === "invalid") {
      return <span className="text-xs text-destructive" data-testid={`text-secret-status-${name}`}>Invalid</span>;
    }
    if (meta.status === "set") {
      return (
        <span className="flex items-center gap-1.5" data-testid={`text-secret-status-${name}`}>
          {meta.last4
            ? <span className="font-mono text-xs text-muted-foreground">••••{meta.last4}</span>
            : <span className="text-xs text-muted-foreground">Set</span>}
          {meta.source !== "db" && <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60">env</span>}
        </span>
      );
    }
    return <span className="text-xs text-muted-foreground/60" data-testid={`text-secret-status-${name}`}>Not set</span>;
  })();

  const menuContent = isAdmin ? (
    <>
      <DropdownMenuItem
        onClick={() => { setEditing(true); setShowValue(false); setValue(""); }}
        data-testid={`button-secret-edit-${name}`}
      >
        {meta.source === "db" ? "Rotate" : "Set"}
      </DropdownMenuItem>
      {meta.source === "db" && (
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onClick={() => {
            if (confirm(`Clear ${name}? Reads will fall back to host env (if any).`)) {
              clearMutation.mutate();
            }
          }}
          data-testid={`button-secret-clear-${name}`}
        >
          Clear
        </DropdownMenuItem>
      )}
    </>
  ) : undefined;

  return (
    <>
      <ProfileTreeRow
        label={meta.label}
        icon={<KeyRound className="h-3.5 w-3.5" />}
        hasValue
        showEmpty
        menuContent={menuContent}
        menuVisibility="hover"
        testId={`secret-control-${name}`}
      >
        {status}
      </ProfileTreeRow>
      {isAdmin && editing && (
        <div className="flex items-center gap-1.5 px-2 pb-2 pl-8" data-testid={`secret-editor-${name}`}>
          <Input
            type={showValue ? "text" : "password"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={`Enter ${meta.label}`}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            className="h-6 flex-1 bg-muted/50 px-1.5 py-0 font-mono text-xs"
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); save(); }
              else if (e.key === "Escape") { e.preventDefault(); closeEditor(); }
            }}
            data-testid={`input-secret-${name}`}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0 text-muted-foreground/70"
            onClick={() => setShowValue(s => !s)}
            aria-label={showValue ? "Hide value" : "Show value"}
            data-testid={`button-secret-toggle-${name}`}
          >
            {showValue ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={save}
            disabled={setMutation.isPending}
            data-testid={`button-secret-save-${name}`}
          >
            {setMutation.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
            Save
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-muted-foreground"
            onClick={closeEditor}
            data-testid={`button-secret-cancel-${name}`}
          >
            Cancel
          </Button>
        </div>
      )}
    </>
  );
}

export function SecretsForSection({
  section,
  excludeNames,
}: {
  section: SecretSection;
  /** Names to omit — used when a particular secret has its own dedicated UI. */
  excludeNames?: string[];
}) {
  const isAdmin = useIsAdmin();
  const { data } = useQuery<{ secrets: SecretMetadata[] }>({
    queryKey: ["/api/secrets/metadata"],
    enabled: isAdmin,
    retry: false,
  });
  if (!isAdmin) {
    return (
      <p className="px-2 py-1.5 text-xs italic text-muted-foreground" data-testid={`secrets-section-admin-only-${section}`}>
        Admin only — sign in as an admin to manage credentials for this connection.
      </p>
    );
  }
  const exclude = new Set(excludeNames ?? []);
  const secrets = (data?.secrets ?? []).filter(s => s.section === section && !exclude.has(s.name));
  if (secrets.length === 0) return null;
  return (
    <div data-testid={`secrets-section-${section}`}>
      {secrets.map(s => <SecretControl key={s.name} name={s.name} />)}
    </div>
  );
}
