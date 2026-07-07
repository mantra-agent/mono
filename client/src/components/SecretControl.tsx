import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import type { SecretMetadata, SecretSection } from "@shared/secrets-catalog";

interface AuthMe {
  user?: { id?: string; role?: string } | null;
}

export function useIsAdmin(): boolean {
  const { data } = useQuery<AuthMe>({ queryKey: ["/api/auth/me"], retry: false });
  return data?.user?.role === "admin";
}

interface SecretControlProps {
  name: string;
  compact?: boolean;
}

export function SecretControl({ name, compact = false }: SecretControlProps) {
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
      setEditing(false);
      setValue("");
      setShowValue(false);
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

  if (isLoading || !meta) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid={`secret-loading-${name}`}>
        <Loader2 className="h-3 w-3 animate-spin" /> Loading {name}…
      </div>
    );
  }

  const statusBadge = (() => {
    if (meta.status === "invalid") return <Badge variant="destructive" data-testid={`badge-secret-status-${name}`}>Invalid</Badge>;
    if (meta.status === "set") return <Badge variant="default" data-testid={`badge-secret-status-${name}`}>Set</Badge>;
    return <Badge variant="outline" data-testid={`badge-secret-status-${name}`}>Not set</Badge>;
  })();
  const sourceHint = meta.status === "set" ? (meta.source === "db" ? "app" : "host env") : null;

  return (
    <div className={compact ? "space-y-1.5" : "space-y-2 p-3 rounded-md border bg-muted/20"} data-testid={`secret-control-${name}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-medium" data-testid={`text-secret-label-${name}`}>{meta.label}</span>
        {statusBadge}
        {sourceHint && (
          <span className="text-xs text-muted-foreground" data-testid={`text-secret-source-${name}`}>via {sourceHint}</span>
        )}
        {meta.last4 && (
          <span className="text-xs text-muted-foreground font-mono" data-testid={`text-secret-last4-${name}`}>
            ••••{meta.last4}
          </span>
        )}
        {meta.updatedAt && (
          <span className="text-xs text-muted-foreground" data-testid={`text-secret-updated-${name}`}>
            updated {new Date(meta.updatedAt).toLocaleDateString()}
          </span>
        )}
      </div>
      {meta.description && !editing && (
        <p className="text-xs text-muted-foreground">{meta.description}</p>
      )}
      {!isAdmin && (
        <p className="text-xs text-muted-foreground italic">Admin only — sign in as an admin to manage.</p>
      )}
      {isAdmin && !editing && (
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setEditing(true)}
            data-testid={`button-secret-edit-${name}`}
          >
            {meta.source === "db" ? "Rotate" : "Set"}
          </Button>
          {meta.source === "db" && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                if (confirm(`Clear ${name}? Reads will fall back to host env (if any).`)) {
                  clearMutation.mutate();
                }
              }}
              disabled={clearMutation.isPending}
              data-testid={`button-secret-clear-${name}`}
            >
              Clear
            </Button>
          )}
        </div>
      )}
      {isAdmin && editing && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Input
              type={showValue ? "text" : "password"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={`Enter ${meta.label}`}
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-xs"
              data-testid={`input-secret-${name}`}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setShowValue(s => !s)}
              data-testid={`button-secret-toggle-${name}`}
            >
              {showValue ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => {
                if (!value.trim()) {
                  toast({ title: "Value required", variant: "destructive" });
                  return;
                }
                setMutation.mutate(value);
              }}
              disabled={setMutation.isPending}
              data-testid={`button-secret-save-${name}`}
            >
              {setMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
              Save
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => { setEditing(false); setValue(""); setShowValue(false); }}
              data-testid={`button-secret-cancel-${name}`}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function SecretsForSection({
  section,
  excludeNames,
}: {
  section: SecretSection;
  /** Names to omit — used when a particular secret has its own dedicated UI card. */
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
      <p className="text-xs text-muted-foreground italic" data-testid={`secrets-section-admin-only-${section}`}>
        Admin only — sign in as an admin to manage credentials for this connection.
      </p>
    );
  }
  const exclude = new Set(excludeNames ?? []);
  const secrets = (data?.secrets ?? []).filter(s => s.section === section && !exclude.has(s.name));
  if (secrets.length === 0) return null;
  return (
    <div className="space-y-2" data-testid={`secrets-section-${section}`}>
      {secrets.map(s => <SecretControl key={s.name} name={s.name} />)}
    </div>
  );
}
