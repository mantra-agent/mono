import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, Users, X } from "lucide-react";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InlineReferenceText } from "@/components/references/inline-reference-text";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { createLogger } from "@/lib/logger";

const log = createLogger("GoalRelationshipsRow");

/** Mirror of the server ResolvedGoalRelationship shape returned by the relationships route. */
interface GoalRelationship {
  linkId: string;
  goalId: string;
  targetType: "person" | "meeting";
  targetId: string;
  targetAddress: string;
  createdAt: string;
  label: string;
  route?: string;
}

interface PersonSearchResult {
  id?: string;
  slug?: string;
  name?: string;
  role?: string;
  company?: string;
}

/**
 * Editable Goal↔Person / Goal↔Meeting relationships. People are added through a
 * lightweight search; meetings are shown read-only (they are linked by the
 * assistant / goal-manager, distinct from calendar title-search suggestions).
 * All mutations go through the canonical /api/life-goals/:id/relationships path.
 */
export function GoalRelationshipsRow({ goalId }: { goalId: string }) {
  const { toast } = useToast();
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");

  const { data } = useQuery<{ relationships: GoalRelationship[] }>({
    queryKey: ["/api/life-goals", goalId, "relationships"],
    queryFn: async () => {
      const res = await fetch(`/api/life-goals/${goalId}/relationships`, { credentials: "include" });
      if (!res.ok) return { relationships: [] };
      return res.json();
    },
  });
  const relationships = data?.relationships ?? [];

  const { data: peopleData } = useQuery<{ people?: PersonSearchResult[] }>({
    queryKey: ["/api/people/search", search],
    queryFn: async () => {
      const res = await fetch(`/api/people/search?q=${encodeURIComponent(search)}`, { credentials: "include" });
      if (!res.ok) return { people: [] };
      return res.json();
    },
    enabled: adding && search.trim().length > 0,
  });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ["/api/life-goals", goalId, "relationships"] });
    queryClient.invalidateQueries({ queryKey: ["/api/life-goals/graph"] });
  }

  const addMutation = useMutation({
    mutationFn: async (targetId: string) => {
      const res = await apiRequest("POST", `/api/life-goals/${goalId}/relationships`, {
        targetType: "person",
        targetId,
      });
      return res.json();
    },
    onSuccess: () => {
      invalidate();
      setSearch("");
      setAdding(false);
    },
    onError: (error: Error) => {
      log.error("Add goal relationship failed", { goalId, errorType: error.name });
      toast({ title: "Could not link person", variant: "destructive" });
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (linkId: string) => {
      await apiRequest("DELETE", `/api/life-goals/${goalId}/relationships/${linkId}`);
    },
    onSuccess: invalidate,
    onError: (error: Error) => {
      log.error("Remove goal relationship failed", { goalId, errorType: error.name });
      toast({ title: "Could not remove link", variant: "destructive" });
    },
  });

  const linkedIds = new Set(relationships.map((rel) => `${rel.targetType}:${rel.targetId}`));

  return (
    <ProfileTreeRow
      label="Related"
      icon={<Users className="h-3.5 w-3.5" />}
      hasValue={relationships.length > 0}
      showEmpty
      mobileLayout="inline"
      expandedContent={(
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {relationships.map((rel) => (
              <span
                key={rel.linkId}
                className="inline-flex items-center gap-1 rounded-md border border-border/30 bg-accent/40 px-1.5 py-0.5 text-sm"
                data-testid={`goal-relationship-${rel.linkId}`}
              >
                <InlineReferenceText text={`@${rel.targetType}:${rel.targetId}`} />
                <button
                  type="button"
                  onClick={() => removeMutation.mutate(rel.linkId)}
                  disabled={removeMutation.isPending}
                  aria-label={`Remove ${rel.label}`}
                  className="text-muted-foreground transition-colors hover:text-destructive"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            {relationships.length === 0 && (
              <span className="text-sm text-muted-foreground">No linked people or meetings.</span>
            )}
          </div>

          {adding ? (
            <div className="space-y-1">
              <Input
                autoFocus
                value={search}
                onChange={(event) => setSearch(event.currentTarget.value)}
                placeholder="Search people…"
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setAdding(false);
                    setSearch("");
                  }
                }}
                data-testid={`input-goal-relationship-search-${goalId}`}
              />
              <div className="max-h-40 overflow-y-auto">
                {(peopleData?.people || [])
                  .filter((person) => person.id && !linkedIds.has(`person:${person.id}`))
                  .slice(0, 6)
                  .map((person) => (
                    <button
                      key={person.id}
                      type="button"
                      className="block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent/70"
                      onClick={() => addMutation.mutate(String(person.id))}
                      disabled={addMutation.isPending}
                      data-testid={`option-goal-relationship-${person.id}`}
                    >
                      <span className="font-medium">{person.name || person.id}</span>
                      {(person.role || person.company) && (
                        <span className="text-muted-foreground">
                          {" · "}
                          {[person.role, person.company].filter(Boolean).join(" at ")}
                        </span>
                      )}
                    </button>
                  ))}
                {search.trim() && (peopleData?.people || []).length === 0 && (
                  <p className="px-2 py-1.5 text-sm text-muted-foreground">No matches.</p>
                )}
              </div>
            </div>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setAdding(true)}
              className="gap-1"
              data-testid={`button-add-goal-relationship-${goalId}`}
            >
              <Plus className="h-3.5 w-3.5" /> Link person
            </Button>
          )}
        </div>
      )}
      expandedContentClassName="px-2 pb-2 pl-2"
      testId={`row-goal-relationships-${goalId}`}
    >
      <span className="text-muted-foreground">{relationships.length || "Add"}</span>
    </ProfileTreeRow>
  );
}
