import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

/** Object types the Share sheet can manage. Mirrors the server GrantableObjectType. */
export type ShareableObjectType = "library_page" | "project" | "milestone" | "task";
export type ShareCapability = "read" | "write" | "admin";

interface GrantRow {
  subjectType: "user" | "invited_subject";
  subjectId: string;
  capability: ShareCapability;
  createdAt: string;
  label: string;
  email: string | null;
}

interface ShareSheetProps {
  objectType: ShareableObjectType;
  objectId: string | number;
  title?: string;
  /** Required for milestone grants (project-local id). */
  projectId?: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function grantsUrl(objectType: ShareableObjectType, objectId: string | number): string {
  return `/api/objects/${objectType}/${encodeURIComponent(String(objectId))}/grants`;
}

export function ShareSheet({ objectType, objectId, title, projectId, open, onOpenChange }: ShareSheetProps) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [capability, setCapability] = useState<ShareCapability>("read");
  const [error, setError] = useState<string | null>(null);

  const queryKey = [grantsUrl(objectType, objectId)] as const;
  const { data, isLoading } = useQuery<{ grants: GrantRow[] }>({
    queryKey,
    queryFn: async () => {
      const res = await apiRequest("GET", grantsUrl(objectType, objectId));
      return res.json();
    },
    enabled: open,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const addMutation = useMutation<unknown, Error, { email: string; capability: ShareCapability }>({
    mutationFn: async ({ email, capability }) => {
      const res = await apiRequest("POST", grantsUrl(objectType, objectId), {
        email,
        capability,
        ...(projectId != null ? { projectId } : {}),
      });
      return res.json();
    },
    onSuccess: () => {
      setEmail("");
      setError(null);
      invalidate();
    },
    onError: (err) => setError(err.message || "Failed to share"),
  });

  const revokeMutation = useMutation<unknown, Error, GrantRow>({
    mutationFn: async (grant) => {
      await apiRequest("DELETE", grantsUrl(objectType, objectId), {
        subjectType: grant.subjectType,
        subjectId: grant.subjectId,
        ...(projectId != null ? { projectId } : {}),
      });
    },
    onSuccess: invalidate,
    onError: (err) => setError(err.message || "Failed to revoke"),
  });

  const grants = data?.grants ?? [];

  const submitAdd = () => {
    const trimmed = email.trim();
    if (!trimmed) return;
    addMutation.mutate({ email: trimmed, capability });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="dialog-share-sheet">
        <DialogHeader>
          <DialogTitle>Share</DialogTitle>
          <DialogDescription className="truncate">{title || "Who has access"}</DialogDescription>
        </DialogHeader>

        {/* Add by email */}
        <div className="flex items-center gap-2">
          <Input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitAdd();
              }
            }}
            placeholder="Add people by email"
            type="email"
            className="flex-1 h-8"
            data-testid="input-share-email"
          />
          <select
            value={capability}
            onChange={(e) => setCapability(e.target.value as ShareCapability)}
            className="h-8 rounded-md border border-input bg-background px-2 text-sm"
            data-testid="select-share-capability"
          >
            <option value="read">Read</option>
            <option value="write">Write</option>
          </select>
          <Button
            size="sm"
            className="h-8"
            onClick={submitAdd}
            disabled={addMutation.isPending || !email.trim()}
            data-testid="button-share-add"
          >
            {addMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Share"}
          </Button>
        </div>

        {error && <p className="text-xs text-destructive" data-testid="text-share-error">{error}</p>}

        {/* Who has access */}
        <div className="mt-1">
          <p className="mb-2 text-xs font-medium text-muted-foreground">Who has access</p>
          {isLoading ? (
            <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
            </div>
          ) : grants.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground" data-testid="text-share-empty">
              Only you have access.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {grants.map((grant) => (
                <li
                  key={`${grant.subjectType}:${grant.subjectId}`}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent"
                  data-testid={`row-share-grant-${grant.subjectId}`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-foreground">{grant.label}</p>
                    {grant.email && grant.email !== grant.label && (
                      <p className="truncate text-xs text-muted-foreground">{grant.email}</p>
                    )}
                  </div>
                  <span className={cn("text-xs capitalize text-muted-foreground")}>{grant.capability}</span>
                  <button
                    type="button"
                    className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
                    onClick={() => revokeMutation.mutate(grant)}
                    disabled={revokeMutation.isPending}
                    title="Remove access"
                    data-testid={`button-share-revoke-${grant.subjectId}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
