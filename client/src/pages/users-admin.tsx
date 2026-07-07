import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Users, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";

interface AdminUserRow {
  id: string;
  email: string;
  role: string;
  createdAt: string;
  hasPendingInvite: boolean;
  permissions: string[];
  permissionOverrides: string[];
}

interface UsersResponse {
  users: AdminUserRow[];
  availablePermissions: string[];
}

function labelForPermission(permission: string): string {
  return permission.replace(":", " ");
}

export default function UsersAdminPage() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission("users:write");
  const { data, isLoading } = useQuery<UsersResponse>({ queryKey: ["/api/auth/users"] });
  const [drafts, setDrafts] = useState<Record<string, Set<string>>>({});

  const availablePermissions = data?.availablePermissions ?? [];
  const users = data?.users ?? [];

  const mutation = useMutation({
    mutationFn: async ({ userId, permissions }: { userId: string; permissions: string[] }) => {
      const res = await apiRequest("PATCH", `/api/auth/users/${userId}/permissions`, { permissions });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/users"] });
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
    },
  });

  const rows = useMemo(() => users.map((user) => ({
    ...user,
    draft: drafts[user.id] ?? new Set(user.permissionOverrides),
  })), [users, drafts]);

  if (!hasPermission("users:read")) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        Users administration requires users:read.
      </div>
    );
  }

  if (isLoading) {
    return <div className="flex items-center justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="flex-1 overflow-y-auto min-h-0 scrollbar-thin p-6">
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Users className="h-5 w-5 text-muted-foreground" />
          <div>
            <h2 className="text-xl font-semibold text-foreground">Users</h2>
            <p className="text-sm text-muted-foreground">Manage explicit access to Users, Build, and System surfaces.</p>
          </div>
        </div>

        {rows.length === 0 ? (
          <div className="rounded-lg border border-border bg-card py-12 text-center text-sm text-muted-foreground">
            No users found.
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-card divide-y divide-border">
            {rows.map((user) => {
              const draft = user.draft;
              const dirty = Array.from(draft).sort().join("|") !== [...user.permissionOverrides].sort().join("|");
              return (
                <div key={user.id} className="p-4 space-y-3">
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-foreground truncate">{user.email}</div>
                      <div className="text-xs text-muted-foreground">{user.role}{user.hasPendingInvite ? " · invite pending" : ""}</div>
                    </div>
                    <Button
                      size="sm"
                      disabled={!canWrite || !dirty || mutation.isPending}
                      onClick={() => mutation.mutate({ userId: user.id, permissions: Array.from(draft) })}
                    >
                      Save
                    </Button>
                  </div>
                  <div className="grid gap-2 @sm:grid-cols-2 @lg:grid-cols-3">
                    {availablePermissions.map((permission) => {
                      const inherited = user.permissions.includes(permission) && !user.permissionOverrides.includes(permission);
                      const checked = inherited || draft.has(permission);
                      return (
                        <label key={permission} className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-sm">
                          <Checkbox
                            checked={checked}
                            disabled={!canWrite || inherited}
                            onCheckedChange={(value) => {
                              setDrafts((current) => {
                                const next = new Set(current[user.id] ?? user.permissionOverrides);
                                if (value) next.add(permission); else next.delete(permission);
                                return { ...current, [user.id]: next };
                              });
                            }}
                          />
                          <span className="capitalize text-foreground">{labelForPermission(permission)}</span>
                          {inherited && <span className="text-xs text-muted-foreground">inherited</span>}
                        </label>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
