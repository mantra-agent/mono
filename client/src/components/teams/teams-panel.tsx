import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Trash2, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiRequest } from "@/lib/queryClient";

/**
 * Teams management panel. Teams are account-scoped, grant-addressable groups: creating or editing a
 * team grants no object access on its own — a team only becomes meaningful when the Share sheet
 * targets it. This panel owns the roster; access is always granted per-object elsewhere.
 */
interface TeamSummary {
  id: string;
  name: string;
  memberCount: number;
}

interface TeamMember {
  userId: string;
  role: "admin" | "member";
  label: string;
  email: string | null;
}

export function TeamsPanel() {
  const queryClient = useQueryClient();
  const [newName, setNewName] = useState("");
  const [expandedTeamId, setExpandedTeamId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{ teams: TeamSummary[] }>({
    queryKey: ["/api/teams"],
    queryFn: async () => (await apiRequest("GET", "/api/teams")).json(),
  });
  const teams = data?.teams ?? [];

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["/api/teams"] });

  const createMutation = useMutation<unknown, Error, string>({
    mutationFn: async (name) => (await apiRequest("POST", "/api/teams", { name })).json(),
    onSuccess: () => {
      setNewName("");
      setError(null);
      invalidate();
    },
    onError: (err) => setError(err.message || "Failed to create team"),
  });

  const deleteMutation = useMutation<unknown, Error, string>({
    mutationFn: async (teamId) => {
      await apiRequest("DELETE", `/api/teams/${teamId}`);
    },
    onSuccess: () => {
      setExpandedTeamId(null);
      invalidate();
    },
    onError: (err) => setError(err.message || "Failed to remove team"),
  });

  return (
    <div className="flex flex-col gap-3" data-testid="panel-teams">
      <div className="flex items-center gap-2">
        <Users className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-medium text-foreground">Teams</h2>
      </div>
      <p className="text-xs text-muted-foreground">
        Groups you can share with. A team grants no access on its own — share a page or project with a team to give its members access.
      </p>

      <div className="flex items-center gap-2">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && newName.trim()) {
              e.preventDefault();
              createMutation.mutate(newName.trim());
            }
          }}
          placeholder="New team name"
          className="h-8 flex-1"
          data-testid="input-team-name"
        />
        <Button
          size="sm"
          className="h-8"
          onClick={() => newName.trim() && createMutation.mutate(newName.trim())}
          disabled={createMutation.isPending || !newName.trim()}
          data-testid="button-team-create"
        >
          {createMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
        </Button>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {isLoading ? (
        <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </div>
      ) : teams.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">No teams yet.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {teams.map((team) => (
            <li key={team.id} className="rounded-md border border-border">
              <div className="flex items-center gap-2 px-3 py-2">
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => setExpandedTeamId(expandedTeamId === team.id ? null : team.id)}
                  data-testid={`button-team-expand-${team.id}`}
                >
                  <p className="truncate text-sm text-foreground">{team.name}</p>
                  <p className="text-xs text-muted-foreground">{team.memberCount} member{team.memberCount === 1 ? "" : "s"}</p>
                </button>
                <button
                  type="button"
                  className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-destructive"
                  onClick={() => deleteMutation.mutate(team.id)}
                  disabled={deleteMutation.isPending}
                  title="Delete team"
                  data-testid={`button-team-delete-${team.id}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              {expandedTeamId === team.id && <TeamMembers teamId={team.id} onError={setError} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TeamMembers({ teamId, onError }: { teamId: string; onError: (msg: string) => void }) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");

  const { data, isLoading } = useQuery<{ members: TeamMember[] }>({
    queryKey: [`/api/teams/${teamId}/members`],
    queryFn: async () => (await apiRequest("GET", `/api/teams/${teamId}/members`)).json(),
  });
  const members = data?.members ?? [];

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: [`/api/teams/${teamId}/members`] });
    queryClient.invalidateQueries({ queryKey: ["/api/teams"] });
  };

  const addMutation = useMutation<unknown, Error, string>({
    mutationFn: async (memberEmail) => {
      await apiRequest("POST", `/api/teams/${teamId}/members`, { email: memberEmail });
    },
    onSuccess: () => {
      setEmail("");
      invalidate();
    },
    onError: (err) => onError(err.message || "Failed to add member"),
  });

  const removeMutation = useMutation<unknown, Error, string>({
    mutationFn: async (userId) => {
      await apiRequest("DELETE", `/api/teams/${teamId}/members/${userId}`);
    },
    onSuccess: invalidate,
    onError: (err) => onError(err.message || "Failed to remove member"),
  });

  return (
    <div className="border-t border-border px-3 py-2">
      <div className="mb-2 flex items-center gap-2">
        <Input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && email.trim()) {
              e.preventDefault();
              addMutation.mutate(email.trim());
            }
          }}
          placeholder="Add member by email"
          type="email"
          className="h-8 flex-1"
          data-testid={`input-team-member-email-${teamId}`}
        />
        <Button
          size="sm"
          className="h-8"
          onClick={() => email.trim() && addMutation.mutate(email.trim())}
          disabled={addMutation.isPending || !email.trim()}
          data-testid={`button-team-member-add-${teamId}`}
        >
          {addMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Add"}
        </Button>
      </div>
      {isLoading ? (
        <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Loading…
        </div>
      ) : members.length === 0 ? (
        <p className="py-1 text-xs text-muted-foreground">No members yet.</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {members.map((member) => (
            <li key={member.userId} className="flex items-center gap-2 rounded px-1 py-1 hover:bg-accent">
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-foreground">{member.label}</p>
              </div>
              <span className="text-[10px] uppercase text-muted-foreground">{member.role}</span>
              <button
                type="button"
                className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
                onClick={() => removeMutation.mutate(member.userId)}
                disabled={removeMutation.isPending}
                title="Remove member"
                data-testid={`button-team-member-remove-${member.userId}`}
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
