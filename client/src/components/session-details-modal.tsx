import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { emitSessionListChanged } from "@/hooks/use-data-sync";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Clock, Zap, FileText, AlertCircle, Loader2, ShieldCheck, Layers, Hash } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";

interface SessionDetailsModalProps {
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigateSession: (id: string) => void;
}

interface ProvenanceData {
  triggerType: string;
  triggerId?: string;
  triggerName?: string;
  parentSessionId?: string;
  parentTitle?: string;
  rootSessionId?: string;
  rootTitle?: string;
  depth: number;
  spawnReason?: string;
}

interface ArtifactData {
  type: string;
  id: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

interface CostData {
  calls: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalTokens: number;
  totalCost: number;
}

interface SkillRunData {
  skillName: string;
  status: string;
  passRate: number | null;
  durationMs: number | null;
}

interface SessionDetailsResponse {
  session: {
    id: string;
    title: string;
    status: string;
    sessionType: string;
    createdAt: string;
    updatedAt: string;
    topics?: string[];
  };
  provenance: ProvenanceData;
  artifacts: ArtifactData[];
  cost: CostData | null;
  skillRun: SkillRunData | null;
}

interface SectionEntry {
  id: string;
  label: string;
  bootstrap?: boolean;
  defaultIncluded?: boolean;
}

interface SectionGroup {
  label: string;
  sections: SectionEntry[];
}

const SECTION_GROUPS: SectionGroup[] = [
  {
    label: "Identity & Voice",
    sections: [
      { id: "world_model.people.self.persona", label: "Persona", defaultIncluded: true },
      { id: "world_model.people.self.emotional_guidance", label: "Emotional Guidance", defaultIncluded: true },
      { id: "world_model.people.self.emotional_state", label: "Emotional State", defaultIncluded: true },
      { id: "world_model.people.self.emotional_expression", label: "Expression Tags", defaultIncluded: true },
      { id: "world_model.people.self.general_instructions", label: "General Instructions" },
      { id: "world_model.people.self.chat_instructions", label: "Chat Instructions" },
    ],
  },
  {
    label: "Partner",
    sections: [
      { id: "world_model.people.partner.identity", label: "Identity", defaultIncluded: true },
      { id: "world_model.people.partner.preferences", label: "Preferences", defaultIncluded: true },
      { id: "world_model.people.partner.goals", label: "Goals" },
      { id: "world_model.people.partner.goals", label: "Goals", defaultIncluded: true },
    ],
  },
  {
    label: "People",
    sections: [
      { id: "world_model.people.others", label: "Close Contacts" },
    ],
  },
  {
    label: "Work",
    sections: [
      { id: "world_model.active_work", label: "Active Work" },
      { id: "world_model.decisions", label: "Decisions" },
      { id: "world_model.beliefs", label: "Beliefs" },
    ],
  },
  {
    label: "Memory",
    sections: [
      { id: "memory.graph", label: "Graph" },
      { id: "memory.recent_sessions", label: "Recent Sessions" },
    ],
  },
  {
    label: "Context",
    sections: [
      { id: "session_context", label: "Session Context" },
      { id: "thoughts", label: "Observations" },
      { id: "world_model.people.self.principles", label: "Principles" },
      { id: "world_model.people.self.journal", label: "Journal" },
      { id: "world_model.people.self.rules", label: "Rules", defaultIncluded: true },
    ],
  },
  {
    label: "Capabilities",
    sections: [
      { id: "capabilities.code_instructions", label: "Code Instructions", bootstrap: true },
      { id: "capabilities.goals_instructions", label: "Goals Instructions", bootstrap: true },
      { id: "capabilities.skills", label: "Skills" },
      { id: "capabilities.library", label: "Library" },
    ],
  },
];

function formatDuration(createdAt: string): string {
  const ms = Date.now() - new Date(createdAt).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return `${hours}h ${remainMins}m`;
}

function formatTokens(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function triggerBadge(type: string) {
  const colors: Record<string, string> = {
    user: "bg-muted text-muted-foreground",
    system: "bg-neutral/10 text-neutral-foreground",
    agent: "bg-info/10 text-info-foreground",
    intention: "bg-cta/10 text-cta",
    timer: "bg-info/10 text-info-foreground",
    hook: "bg-neutral/10 text-neutral-foreground",
    skill: "bg-neutral/10 text-neutral-foreground",
    plan: "bg-success/10 text-success-foreground",
    spawn: "bg-info/10 text-info-foreground",
    voice: "bg-cta/10 text-cta",
    unknown: "bg-muted text-muted-foreground",
  };
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${colors[type] || colors.unknown}`}>
      {type}
    </span>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider shrink-0">{label}</span>
      <span className="text-sm text-foreground text-right">{children}</span>
    </div>
  );
}

function SessionLink({ id, title, onClick }: { id: string; title?: string; onClick: () => void }) {
  if (!title) {
    return <span className="text-sm text-muted-foreground">{id.slice(0, 12)}… (deleted)</span>;
  }
  return (
    <button
      className="text-sm text-primary hover:underline cursor-pointer text-right"
      onClick={onClick}
    >
      {title}
    </button>
  );
}

const ARTIFACT_ICONS: Record<string, string> = {
  library_page: "📄",
  file: "📎",
  memory_entry: "🧠",
  content_draft: "✏️",
  docx: "📝",
};

export function SessionDetailsModal({ sessionId, open, onOpenChange, onNavigateSession }: SessionDetailsModalProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const gitWriteMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      await apiRequest("PATCH", `/api/sessions/${sessionId}/git-write-override`, { enabled });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sessions", sessionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/sessions", sessionId, "details"] });
      emitSessionListChanged("git-write-override");
    },
    onError: (err) => {
      toast({ title: "Failed to toggle git writes", description: String(err), variant: "destructive" });
    },
  });

  // Context sections state
  const [optimisticFlags, setOptimisticFlags] = useState<Record<string, boolean>>({});

  const { data: sessionData } = useQuery<{ contextFlags?: Record<string, boolean> }>({
    queryKey: ["/api/sessions", sessionId],
    enabled: open && !!sessionId,
  });

  const currentFlags: Record<string, boolean> = {
    ...(sessionData?.contextFlags ?? {}),
    ...optimisticFlags,
  };

  const orientMutation = useMutation({
    mutationFn: async (flags: Record<string, boolean>) => {
      await apiRequest("POST", "/api/agent/tools/orient", {
        arguments: { contextFlags: flags, reasoning: "Context flags updated via UI" },
        sessionId,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sessions", sessionId] });
      setOptimisticFlags({});
    },
    onError: (err) => {
      setOptimisticFlags({});
      toast({ title: "Failed to update context", description: String(err), variant: "destructive" });
    },
  });

  const handleToggle = useCallback((sectionId: string, checked: boolean) => {
    const newFlags = { ...currentFlags, [sectionId]: checked };
    setOptimisticFlags(prev => ({ ...prev, [sectionId]: checked }));
    orientMutation.mutate(newFlags);
  }, [currentFlags, orientMutation]);

  const isChecked = useCallback((section: SectionEntry): boolean => {
    if (section.bootstrap) return true;
    if (section.id in currentFlags) return currentFlags[section.id];
    return section.defaultIncluded ?? false;
  }, [currentFlags]);

  const { data, isLoading, error } = useQuery<SessionDetailsResponse>({
    queryKey: ["/api/sessions", sessionId, "details"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/sessions/${sessionId}/details`);
      return res.json();
    },
    enabled: open && !!sessionId,
    staleTime: 30000,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[85vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-6 pt-6 pb-4 shrink-0">
          <DialogTitle className="text-sm font-medium">Session Details</DialogTitle>
        </DialogHeader>

        {isLoading && (
          <div className="flex items-center justify-center py-8 px-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 py-4 px-6 text-destructive text-sm">
            <AlertCircle className="h-4 w-4" />
            Failed to load session details
          </div>
        )}

        {data && (
          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-6 pb-6 space-y-4">
            {/* Provenance */}
            <div>
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <Zap className="h-3 w-3" /> Provenance
              </h4>
              <div className="space-y-0.5">
                <DetailRow label="Trigger">
                  <span className="flex items-center gap-1.5 justify-end">
                    {triggerBadge(data.provenance.triggerType)}
                    {data.provenance.triggerName && (
                      <span className="text-sm">"{data.provenance.triggerName}"</span>
                    )}
                  </span>
                </DetailRow>
                {data.provenance.parentSessionId && (
                  <DetailRow label="Parent">
                    <SessionLink
                      id={data.provenance.parentSessionId}
                      title={data.provenance.parentTitle}
                      onClick={() => {
                        onNavigateSession(data.provenance.parentSessionId!);
                      }}
                    />
                  </DetailRow>
                )}
                {data.provenance.rootSessionId && data.provenance.rootSessionId !== data.session.id && (
                  <DetailRow label="Root">
                    <SessionLink
                      id={data.provenance.rootSessionId}
                      title={data.provenance.rootTitle}
                      onClick={() => {
                        onNavigateSession(data.provenance.rootSessionId!);
                      }}
                    />
                  </DetailRow>
                )}
                <DetailRow label="Depth">{data.provenance.depth}</DetailRow>
                {data.provenance.spawnReason && (
                  <DetailRow label="Spawn Reason">
                    <span className="font-mono text-xs">{data.provenance.spawnReason}</span>
                  </DetailRow>
                )}
              </div>
            </div>

            <div className="border-t border-border" />

            {/* Session Metadata */}
            <div>
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <Clock className="h-3 w-3" /> Session
              </h4>
              <div className="space-y-0.5">
                <DetailRow label="Created">
                  {new Date(data.session.createdAt).toLocaleString(undefined, {
                    month: "short", day: "numeric", year: "numeric",
                    hour: "numeric", minute: "2-digit",
                  })}
                </DetailRow>
                <DetailRow label="Duration">{formatDuration(data.session.createdAt)}</DetailRow>
                <DetailRow label="Turn">
                  <span className="capitalize">{data.session.status === "streaming" ? "active" : "idle"}</span>
                </DetailRow>
                <DetailRow label="Outcome">
                  <span className="capitalize">{data.session.status === "saved" ? "complete" : data.session.status === "failed" ? "failed" : "pending"}</span>
                </DetailRow>
                <DetailRow label="Type">
                  <span className="capitalize">{data.session.sessionType}</span>
                </DetailRow>
                <div className="flex items-center justify-between gap-4 py-1">
                  <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider shrink-0 flex items-center gap-1.5">
                    <ShieldCheck className="h-3 w-3" /> Git Writes
                  </span>
                  <Switch
                    checked={!!(data.session as any).gitWriteOverride}
                    onCheckedChange={(checked) => gitWriteMutation.mutate(checked)}
                    disabled={gitWriteMutation.isPending}
                    data-testid="toggle-git-write-override"
                  />
                </div>
                {data.cost && (
                  <DetailRow label="Calls">{data.cost.calls}</DetailRow>
                )}
                {data.cost && (
                  <DetailRow label="Tokens">
                    {formatTokens(data.cost.totalTokens)} total · {formatTokens(data.cost.totalTokensIn)} in / {formatTokens(data.cost.totalTokensOut)} out
                  </DetailRow>
                )}
                {data.cost && data.cost.totalCost > 0 && (
                  <DetailRow label="Cost">${data.cost.totalCost.toFixed(4)}</DetailRow>
                )}
              </div>
            </div>

            {/* Topics */}
            {data.session.topics && data.session.topics.length > 0 && (
              <>
                <div className="border-t border-border" />
                <div>
                  <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
                    <Hash className="h-3 w-3" /> Topics
                  </h4>
                  <div className="flex flex-wrap gap-1.5">
                    {data.session.topics.map((topic, i) => (
                      <span
                        key={i}
                        className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                      >
                        {topic}
                      </span>
                    ))}
                  </div>
                </div>
              </>
            )}

            {/* Skill Run */}
            {data.skillRun && (
              <>
                <div className="border-t border-border" />
                <div>
                  <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
                    <Zap className="h-3 w-3" /> Skill Run
                  </h4>
                  <div className="space-y-0.5">
                    <DetailRow label="Skill">{data.skillRun.skillName}</DetailRow>
                    <DetailRow label="Status">
                      <span className="capitalize">{data.skillRun.status}</span>
                    </DetailRow>
                    {data.skillRun.passRate !== null && (
                      <DetailRow label="Score">{Math.round(data.skillRun.passRate * 100)}%</DetailRow>
                    )}
                    {data.skillRun.durationMs !== null && (
                      <DetailRow label="Duration">{Math.round(data.skillRun.durationMs / 1000)}s</DetailRow>
                    )}
                  </div>
                </div>
              </>
            )}

            {/* Artifacts */}
            {data.artifacts.length > 0 && (
              <>
                <div className="border-t border-border" />
                <div>
                  <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
                    <FileText className="h-3 w-3" /> Artifacts
                  </h4>
                  <div className="space-y-1">
                    {data.artifacts.map((artifact, i) => (
                      <div key={i} className="flex items-center gap-2 text-sm">
                        <span>{ARTIFACT_ICONS[artifact.type] || "📄"}</span>
                        <span className="truncate">
                          {(artifact.metadata as any)?.title || artifact.id}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
            {data.artifacts.length === 0 && (
              <>
                <div className="border-t border-border" />
                <div>
                  <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
                    <FileText className="h-3 w-3" /> Artifacts
                  </h4>
                  <p className="text-xs text-muted-foreground">No artifacts produced</p>
                </div>
              </>
            )}

            {/* Context Sections */}
            <div className="border-t border-border" />
            <div>
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <Layers className="h-3 w-3" /> Context Sections
              </h4>
              <div className="space-y-3">
                {SECTION_GROUPS.map((group) => (
                  <div key={group.label}>
                    <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
                      {group.label}
                    </p>
                    <div className="space-y-0.5">
                      {group.sections.map((section) => (
                        <label
                          key={section.id}
                          className="flex items-center gap-2 px-1 py-1 text-sm cursor-pointer hover:bg-accent rounded-sm"
                          title={section.bootstrap ? "Always included" : undefined}
                        >
                          <Checkbox
                            checked={isChecked(section)}
                            onCheckedChange={(checked) => {
                              if (!section.bootstrap) handleToggle(section.id, !!checked);
                            }}
                            disabled={section.bootstrap || orientMutation.isPending}
                            data-testid={`ctx-toggle-${section.id}`}
                          />
                          <span className="text-xs truncate">{section.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
