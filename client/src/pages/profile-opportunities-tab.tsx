import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useFocusContext } from "@/hooks/use-focus-context";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Plus, Trash2, Loader2, DollarSign, Check, Search, FileText, ExternalLink, Download, ChevronRight, MoreHorizontal, X, Briefcase, Handshake, Building2, PiggyBank } from "lucide-react";
import { ReferenceChip } from "@/components/references/reference-chip";
import { resolveReference } from "@/components/references/reference-registry";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { ProfileDetailSection } from "@/components/profile-detail-section";
import { ExpandableInteractionRow } from "@/components/people/expandable-interaction-row";
import type { OpportunityInteractionActivity } from "@shared/models/opportunities";

// ── Types ──────────────────────────────────────────────────────────
interface LinkedSkill {
  id: number;
  name: string;
  category: string | null;
  skillType: string | null;
  proficiency: string | null;
  energyLevel: string | null;
}

interface Opportunity {
  id: number;
  title: string;
  description: string | null;
  type: string;
  status: string;
  probability: number;
  isFullTime: boolean;
  hoursPerWeek: number | null;
  timeCommitmentPeriod: string | null;
  timeHorizonMonths: number | null;
  evInputs: Record<string, any>;
  computedEv: number | null;
  company: string | null;
  location: string | null;
  nextSteps: string | null;
  priority: string | null;
  contactPersonId: string | null;
  championPersonId: string | null;
  followUpBy: string | null;
  followUpNote: string | null;
  sourceType: string;
  sourceSignalId: string | null;
  requiredSkills: string[];
  jdText: string | null;
  jobUrl: string | null;
  linkedSkills?: LinkedSkill[];
  createdAt: string;
  updatedAt: string;
}

interface CatalogSkill {
  id: number;
  name: string;
  category: string | null;
  skillType: string | null;
  proficiency: string | null;
  energyLevel: string | null;
}

interface PersonResult {
  id: string;
  name: string;
}

const TYPES = ["job", "consulting", "business", "passive_income"] as const;
const STATUSES = ["discovered", "qualified", "researched", "pursuing", "active", "passed", "lost"] as const;
const PRIORITIES = ["high", "mid", "low"] as const;

const TYPE_LABELS: Record<string, string> = {
  job: "Job",
  consulting: "Consulting",
  business: "Business",
  passive_income: "Passive Income",
};

const PRIORITY_COLORS: Record<string, string> = {
  high: "text-error",
  mid: "text-warning",
  low: "text-neutral-foreground",
};

function formatEv(ev: number | null | undefined): string {
  if (ev == null || ev === 0) return "—";
  if (ev >= 1000000) return `$${(ev / 1000000).toFixed(1)}M`;
  if (ev >= 1000) return `$${(ev / 1000).toFixed(0)}K`;
  return `$${Math.round(ev)}`;
}

const TYPE_ICONS: Record<string, typeof Briefcase> = {
  job: Briefcase,
  consulting: Handshake,
  business: Building2,
  passive_income: PiggyBank,
};

function matchesOpportunity(opportunity: Opportunity, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [
    opportunity.title,
    opportunity.company,
    opportunity.location,
    opportunity.status,
    TYPE_LABELS[opportunity.type] || opportunity.type,
    opportunity.nextSteps,
    opportunity.description,
  ]
    .filter(Boolean)
    .some(value => String(value).toLowerCase().includes(q));
}

// ── People Search Dropdown ─────────────────────────────────────────
function PeopleSearch({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (personId: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Fetch person name on mount if we have a value
  const { data: currentPerson } = useQuery<PersonResult>({
    queryKey: ["/api/people", value],
    queryFn: async () => {
      if (!value) return null;
      const res = await fetch(`/api/people/${value}`);
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!value && !selectedName,
  });

  useEffect(() => {
    if (currentPerson?.name && !selectedName) {
      setSelectedName(currentPerson.name);
    }
  }, [currentPerson, selectedName]);

  const { data: results = [] } = useQuery<PersonResult[]>({
    queryKey: ["/api/people/search", query],
    queryFn: async () => {
      if (!query || query.length < 2) return [];
      const res = await fetch(`/api/people/search?q=${encodeURIComponent(query)}`);
      if (!res.ok) return [];
      const data = await res.json();
      return (data?.people || []).map((p: any) => ({ id: p.id, name: p.name }));
    },
    enabled: query.length >= 2 && open,
  });

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  if (value && selectedName) {
    return (
      <div className="flex items-center gap-2">
        <ReferenceChip resolved={resolveReference({ type: "person", id: value, canonical: `@person:${value}` })} />
        <button
          className="text-xs text-muted-foreground hover:text-foreground"
          onClick={() => {
            onChange(null);
            setSelectedName(null);
            setQuery("");
          }}
        >
          ✕
        </button>
      </div>
    );
  }

  return (
    <div ref={wrapperRef} className="relative">
      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          value={query}
          onChange={e => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => query.length >= 2 && setOpen(true)}
          placeholder="Search people..."
          className="pl-8 h-8 text-sm"
        />
      </div>
      {open && results.length > 0 && (
        <div className="absolute z-50 w-full mt-1 bg-popover border rounded-md shadow-md max-h-40 overflow-y-auto">
          {results.map(p => (
            <button
              key={p.id}
              className="w-full text-left px-3 py-1.5 text-sm hover:bg-accent transition-colors"
              onClick={() => {
                onChange(p.id);
                setSelectedName(p.name);
                setQuery("");
                setOpen(false);
              }}
            >
              {p.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const PROFICIENCY_COLORS: Record<string, string> = {
  expert: "bg-success/10 text-success-foreground border-success/30",
  proficient: "bg-info/10 text-info-foreground dark:bg-info/10 dark:text-info border-info/30",
  competent: "bg-warning/10 text-warning-foreground dark:bg-warning/10/50 dark:text-warning border-warning/30",
  developing: "bg-cat-event/15 text-cat-event-foreground border-cat-event/30",
  novice: "bg-error/10 text-error-foreground dark:bg-error/50 dark:text-error border-error/30",
};

const SKILL_TYPE_LABELS: Record<string, string> = {
  foundational: "Foundational",
  applied: "Applied",
  tool: "Tool",
  domain: "Domain",
};

// ── Skill Multi-Select ─────────────────────────────────────────────
function SkillMultiSelect({
  opportunityId,
  linkedSkills,
  onChanged,
}: {
  opportunityId: number;
  linkedSkills: LinkedSkill[];
  onChanged: () => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  const { data: allSkills = [] } = useQuery<CatalogSkill[]>({
    queryKey: ["/api/exec/skills"],
  });

  const linkedIds = useMemo(() => new Set(linkedSkills.map(s => s.id)), [linkedSkills]);

  const filtered = useMemo(() => {
    const available = allSkills.filter(s => !linkedIds.has(s.id));
    if (!query) return available;
    const q = query.toLowerCase();
    return available.filter(s => s.name.toLowerCase().includes(q));
  }, [allSkills, linkedIds, query]);

  // Group by skillType
  const grouped = useMemo(() => {
    const groups: Record<string, CatalogSkill[]> = {};
    for (const s of filtered) {
      const key = s.skillType || "applied";
      if (!groups[key]) groups[key] = [];
      groups[key].push(s);
    }
    // Sort each group alphabetically
    for (const key of Object.keys(groups)) {
      groups[key].sort((a, b) => a.name.localeCompare(b.name));
    }
    return Object.entries(groups).sort(([a], [b]) => {
      const order = ["foundational", "applied", "tool", "domain"];
      return order.indexOf(a) - order.indexOf(b);
    });
  }, [filtered]);

  const linkMutation = useMutation({
    mutationFn: async (skillId: number) => {
      await apiRequest("POST", `/api/exec/opportunities/${opportunityId}/skills/${skillId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/exec/opportunities"] });
      onChanged();
    },
  });

  const unlinkMutation = useMutation({
    mutationFn: async (skillId: number) => {
      await apiRequest("DELETE", `/api/exec/opportunities/${opportunityId}/skills/${skillId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/exec/opportunities"] });
      onChanged();
    },
  });

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <div ref={wrapperRef} className="space-y-2">
      {/* Selected skills as chips */}
      {linkedSkills.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {linkedSkills.map(s => (
            <span
              key={s.id}
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border ${
                PROFICIENCY_COLORS[s.proficiency || ""] || "bg-neutral/10 text-neutral-foreground border-neutral/30"
              }`}
            >
              {s.name}
              <button
                onClick={() => unlinkMutation.mutate(s.id)}
                className="ml-0.5 hover:opacity-70 transition-opacity"
                disabled={unlinkMutation.isPending}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Search input */}
      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          value={query}
          onChange={e => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder="Search skills to add..."
          className="pl-8 h-8 text-sm"
        />
      </div>

      {/* Dropdown */}
      {open && grouped.length > 0 && (
        <div className="border rounded-md shadow-md max-h-52 overflow-y-auto bg-popover">
          {grouped.map(([type, skills]) => (
            <div key={type}>
              <div className="px-3 py-1 text-xs font-medium text-muted-foreground uppercase tracking-wide bg-muted/30 sticky top-0">
                {SKILL_TYPE_LABELS[type] || type} ({skills.length})
              </div>
              {skills.map(s => (
                <button
                  key={s.id}
                  className="w-full text-left px-3 py-1.5 text-sm hover:bg-accent transition-colors flex items-center justify-between"
                  onClick={() => {
                    linkMutation.mutate(s.id);
                    setQuery("");
                  }}
                  disabled={linkMutation.isPending}
                >
                  <span>{s.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {s.proficiency || "—"} · {s.energyLevel || "—"}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
      {open && query && grouped.length === 0 && (
        <div className="border rounded-md p-3 text-sm text-muted-foreground text-center bg-popover">
          No matching skills
        </div>
      )}
    </div>
  );
}

// ── EV Input Form (type-specific) ──────────────────────────────────
function EvInputForm({
  type,
  evInputs,
  onChange,
}: {
  type: string;
  evInputs: Record<string, any>;
  onChange: (inputs: Record<string, any>) => void;
}) {
  const set = (key: string, value: number) => onChange({ ...evInputs, [key]: value });

  switch (type) {
    case "job":
      return (
        <div className="space-y-2">
          <label className="text-xs text-muted-foreground">Annual Compensation ($)</label>
          <Input type="number" value={evInputs.annualComp || ""} onChange={e => set("annualComp", parseFloat(e.target.value) || 0)} placeholder="150000" />
        </div>
      );
    case "consulting":
      return (
        <div className="space-y-2">
          <label className="text-xs text-muted-foreground">Hourly/Daily Rate ($)</label>
          <Input type="number" value={evInputs.rate || ""} onChange={e => set("rate", parseFloat(e.target.value) || 0)} placeholder="200" />
          <label className="text-xs text-muted-foreground">Duration (months)</label>
          <Input type="number" value={evInputs.durationMonths || ""} onChange={e => set("durationMonths", parseFloat(e.target.value) || 0)} placeholder="6" />
        </div>
      );
    case "business":
      return (
        <div className="space-y-2">
          <label className="text-xs text-muted-foreground">Monthly Revenue ($)</label>
          <Input type="number" value={evInputs.monthlyRevenue || ""} onChange={e => set("monthlyRevenue", parseFloat(e.target.value) || 0)} placeholder="10000" />
          <label className="text-xs text-muted-foreground">Growth Rate (% per month)</label>
          <Input type="number" step="0.01" value={evInputs.growthRate != null ? evInputs.growthRate * 100 : ""} onChange={e => set("growthRate", (parseFloat(e.target.value) || 0) / 100)} placeholder="5" />
          <label className="text-xs text-muted-foreground">Margin (%)</label>
          <Input type="number" step="0.01" value={evInputs.margin != null ? evInputs.margin * 100 : ""} onChange={e => set("margin", (parseFloat(e.target.value) || 0) / 100)} placeholder="80" />
          <label className="text-xs text-muted-foreground">Projection Horizon (months)</label>
          <Input type="number" value={evInputs.projectionMonths || ""} onChange={e => set("projectionMonths", parseFloat(e.target.value) || 0)} placeholder="12" />
        </div>
      );
    case "passive_income":
      return (
        <div className="space-y-2">
          <label className="text-xs text-muted-foreground">Monthly Yield ($)</label>
          <Input type="number" value={evInputs.monthlyYield || ""} onChange={e => set("monthlyYield", parseFloat(e.target.value) || 0)} placeholder="500" />
          <label className="text-xs text-muted-foreground">Growth Rate (% per month)</label>
          <Input type="number" step="0.01" value={evInputs.growthRate != null ? evInputs.growthRate * 100 : ""} onChange={e => set("growthRate", (parseFloat(e.target.value) || 0) / 100)} placeholder="2" />
          <label className="text-xs text-muted-foreground">Projection Horizon (months)</label>
          <Input type="number" value={evInputs.projectionMonths || ""} onChange={e => set("projectionMonths", parseFloat(e.target.value) || 0)} placeholder="12" />
        </div>
      );
    default:
      return null;
  }
}

// ── Artifact Rail ────────────────────────────────────────────────────
const ARTIFACT_KINDS = ["research", "cover_letter", "resume"] as const;
type ArtifactKind = typeof ARTIFACT_KINDS[number];

const KIND_LABELS: Record<ArtifactKind, string> = {
  research: "Research",
  cover_letter: "Cover Letter",
  resume: "Resume",
};

interface ArtifactSlot {
  id: number;
  kind: string;
  libraryPageId: string;
  sessionId: string | null;
  docxFileName: string | null;
  generatedAt: string | null;
}

function ArtifactRail({ opportunityId, jdText }: { opportunityId: number; jdText: string | null }) {
  const { toast } = useToast();
  const { data: artifacts = [], refetch } = useQuery<ArtifactSlot[]>({
    queryKey: ["/api/exec/opportunities", opportunityId, "artifacts"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/exec/opportunities/${opportunityId}/artifacts`);
      return res.json();
    },
  });

  const [generating, setGenerating] = useState<ArtifactKind | null>(null);

  const slotMap = useMemo(() => {
    const m = new Map<string, ArtifactSlot>();
    for (const a of artifacts) m.set(a.kind, a);
    return m;
  }, [artifacts]);

  const generate = async (kind: ArtifactKind) => {
    if (kind !== "research" && !jdText?.trim()) {
      toast({ title: "Job description required", description: "Paste the JD before generating a cover letter or resume.", variant: "destructive" });
      return;
    }
    setGenerating(kind);
    try {
      const res = await apiRequest("POST", `/api/exec/opportunities/${opportunityId}/artifacts/${kind}/generate`, {});
      const data = await res.json();
      if (data.sessionId) {
        toast({ title: `${KIND_LABELS[kind]} generation started`, description: "Opening session..." });
        window.location.href = `/session?c=${encodeURIComponent(data.sessionId)}`;
      }
    } catch (err: any) {
      const msg = err?.message || `Failed to generate ${KIND_LABELS[kind].toLowerCase()}`;
      toast({ title: "Generation failed", description: msg, variant: "destructive" });
    } finally {
      setGenerating(null);
      refetch();
    }
  };

  return (
    <div className="border rounded-lg p-3 space-y-2 bg-muted/30">
      <div className="flex items-center gap-2 mb-2">
        <FileText className="h-4 w-4 text-primary" />
        <span className="text-sm font-medium">Artifacts</span>
      </div>
      {ARTIFACT_KINDS.map((kind) => {
        const slot = slotMap.get(kind);
        const isGenerating = generating === kind;
        return (
          <div key={kind} className="flex items-center justify-between gap-2 py-1">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm">{KIND_LABELS[kind]}</span>
              {slot?.generatedAt && (
                <span className="text-xs text-muted-foreground">
                  {new Date(slot.generatedAt).toLocaleDateString()}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              {slot?.docxFileName && (
                <a
                  href={slot.docxFileName.startsWith('/objects/') ? slot.docxFileName : `/api/exec/artifacts/download/${encodeURIComponent(slot.docxFileName)}`}
                  download
                  className="text-primary hover:text-primary/80"
                  title="Download DOCX"
                >
                  <Download className="h-3.5 w-3.5" />
                </a>
              )}
              {slot?.libraryPageId && (
                <a
                  href={`/info#library?page=${encodeURIComponent(slot.libraryPageId)}`}
                  className="text-primary hover:text-primary/80"
                  title="View in Library"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
              <Button
                size="sm"
                variant={slot ? "outline" : "default"}
                className="h-7 text-xs px-2"
                onClick={() => generate(kind)}
                disabled={isGenerating}
              >
                {isGenerating ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : slot ? (
                  "Regenerate"
                ) : (
                  "Generate"
                )}
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Detail Panel ───────────────────────────────────────────────────
function OpportunityDetail({
  opportunity,
  onSave,
  onDelete,
  saving,
}: {
  opportunity: Opportunity;
  onSave: (updates: Partial<Opportunity>) => void;
  onDelete: () => void;
  saving: boolean;
}) {
  const [form, setForm] = useState(() => ({ ...opportunity }));
  const [showDelete, setShowDelete] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const formRef = useRef(form);
  formRef.current = form;

  // Reset form when opportunity selection changes
  useEffect(() => {
    setForm({ ...opportunity });
    setSaveStatus("idle");
  }, [opportunity.id]);

  // Sync server data back into form when not actively editing
  useEffect(() => {
    // Only sync if the server version is newer (e.g. after a save completes)
    if (opportunity.updatedAt !== formRef.current.updatedAt) {
      setForm(prev => {
        // Merge server values for fields that haven't diverged
        const merged = { ...prev };
        merged.computedEv = opportunity.computedEv;
        merged.updatedAt = opportunity.updatedAt;
        return merged;
      });
    }
  }, [opportunity.updatedAt]);

  const flushSave = useCallback(() => {
    const current = formRef.current;
    const updates: Record<string, any> = {};
    for (const key of Object.keys(current) as (keyof Opportunity)[]) {
      if (JSON.stringify(current[key]) !== JSON.stringify(opportunity[key])) {
        updates[key] = current[key];
      }
    }
    if (Object.keys(updates).length > 0) {
      setSaveStatus("saving");
      onSave(updates);
      // The saving prop from parent will handle the transition
    }
  }, [opportunity, onSave]);

  // Track when saving completes
  useEffect(() => {
    if (!saving && saveStatus === "saving") {
      setSaveStatus("saved");
      const t = setTimeout(() => setSaveStatus("idle"), 2000);
      return () => clearTimeout(t);
    }
  }, [saving, saveStatus]);

  // Debounced auto-save
  const patch = useCallback((key: string, value: any) => {
    setForm(prev => ({ ...prev, [key]: value }));
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      // Need to read formRef.current after the state update has been applied
      requestAnimationFrame(() => flushSave());
    }, 800);
  }, [flushSave]);

  // Flush on blur
  const handleBlur = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    // Small delay to let state settle
    requestAnimationFrame(() => flushSave());
  }, [flushSave]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const { data: activities = [], isLoading: activitiesLoading } = useQuery<OpportunityInteractionActivity[]>({
    queryKey: ["/api/exec/opportunities", opportunity.id, "activities"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/exec/opportunities/${opportunity.id}/activities`);
      return res.json();
    },
  });

  const sortedActivities = useMemo(
    () => [...activities].sort((a, b) => new Date(b.interaction.date).getTime() - new Date(a.interaction.date).getTime()),
    [activities],
  );

  return (
    <div className="h-full space-y-6 overflow-y-auto p-4" onBlur={handleBlur} data-testid="opportunity-detail-view">
      <div className="space-y-0">
        <ProfileDetailSection
          title={(
            <Input
              value={form.title}
              onChange={e => patch("title", e.target.value)}
              className="h-auto w-full border-0 bg-transparent p-0 text-xs font-bold uppercase leading-none tracking-wider text-muted-foreground shadow-none outline-none ring-0 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
              placeholder="Opportunity title"
            />
          )}
          defaultOpen
          testId="section-opportunity-profile"
          headerAction={(
            <div className="w-16 shrink-0 text-right text-xs font-normal normal-case tracking-normal text-muted-foreground">
              {saveStatus === "saving" && <span className="flex items-center justify-end gap-1"><Loader2 className="h-3 w-3 animate-spin" />Saving</span>}
              {saveStatus === "saved" && <span className="flex items-center justify-end gap-1 text-success"><Check className="h-3 w-3" />Saved</span>}
            </div>
          )}
        >
          <div className="space-y-4 overflow-hidden rounded-md border border-border/20 p-3">
      {/* Type, Status & Priority */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_7rem]">
        <div className="flex-1">
          <label className="text-xs text-muted-foreground mb-1 block">Type</label>
          <Select value={form.type} onValueChange={v => patch("type", v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {TYPES.map(t => <SelectItem key={t} value={t}>{TYPE_LABELS[t]}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex-1">
          <label className="text-xs text-muted-foreground mb-1 block">Status</label>
          <Select value={form.status} onValueChange={v => patch("status", v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {STATUSES.map(s => <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="sm:w-28">
          <label className="text-xs text-muted-foreground mb-1 block">Priority</label>
          <Select value={form.priority || ""} onValueChange={v => patch("priority", v || null)}>
            <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
            <SelectContent>
              {PRIORITIES.map(p => (
                <SelectItem key={p} value={p}>
                  <span className={`capitalize ${PRIORITY_COLORS[p]}`}>{p}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Company (job only) */}
      {form.type === "job" && (
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Company</label>
          <Input
            value={form.company || ""}
            onChange={e => patch("company", e.target.value || null)}
            placeholder="Company name"
          />
        </div>
      )}

      {/* Location */}
      <div>
        <label className="text-xs text-muted-foreground mb-1 block">Location</label>
        <Input
          value={form.location || ""}
          onChange={e => patch("location", e.target.value || null)}
          placeholder="Remote, Chicago, San Francisco..."
        />
      </div>

      {/* Introduction (Contact Person) */}
      <div>
        <label className="text-xs text-muted-foreground mb-1 block">Introduction</label>
        <PeopleSearch
          value={form.contactPersonId}
          onChange={(id) => patch("contactPersonId", id)}
        />
      </div>

      {/* Champion */}
      <div>
        <label className="text-xs text-muted-foreground mb-1 block">Champion</label>
        <PeopleSearch
          value={form.championPersonId}
          onChange={(id) => patch("championPersonId", id)}
        />
      </div>

      {/* Probability */}
      <div>
        <label className="text-xs text-muted-foreground mb-1 block">Probability: {Math.round(form.probability * 100)}%</label>
        <input
          type="range" min="0" max="100" step="5"
          value={Math.round(form.probability * 100)}
          onChange={e => patch("probability", parseInt(e.target.value) / 100)}
          className="w-full accent-primary"
        />
      </div>

      {/* Computed EV */}
      <div className="bg-muted/50 rounded-lg p-3 text-center">
        <div className="text-xs text-muted-foreground">Expected Value</div>
        <div className="text-2xl font-bold">{formatEv(form.computedEv)}</div>
      </div>

      {/* EV Inputs */}
      <div>
        <label className="text-xs text-muted-foreground mb-1 block font-medium">EV Inputs</label>
        <EvInputForm type={form.type} evInputs={form.evInputs || {}} onChange={inputs => patch("evInputs", inputs)} />
      </div>

      {/* Time Commitment */}
      <div className="flex gap-3 items-end">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.isFullTime}
            onChange={e => {
              patch("isFullTime", e.target.checked);
              if (e.target.checked) patch("hoursPerWeek", null);
            }}
          />
          Full Time
        </label>
        {!form.isFullTime && (
          <div className="flex-1">
            <label className="text-xs text-muted-foreground mb-1 block">Hours per week</label>
            <Input type="number" value={form.hoursPerWeek ?? ""} onChange={e => patch("hoursPerWeek", parseInt(e.target.value) || null)} />
          </div>
        )}
      </div>

      {/* Time Horizon */}
      <div>
        <label className="text-xs text-muted-foreground mb-1 block">Income starts in (months)</label>
        <Input type="number" value={form.timeHorizonMonths ?? ""} onChange={e => patch("timeHorizonMonths", parseInt(e.target.value) || null)} />
      </div>

      {/* Follow-Up */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="flex-1">
          <label className="text-xs text-muted-foreground mb-1 block">Follow Up By</label>
          <Input
            type="date"
            value={form.followUpBy || ""}
            onChange={e => patch("followUpBy", e.target.value || null)}
          />
        </div>
        <div className="sm:col-span-2">
          <label className="text-xs text-muted-foreground mb-1 block">Follow-Up Note</label>
          <Input
            value={form.followUpNote || ""}
            onChange={e => patch("followUpNote", e.target.value || null)}
            placeholder="What to follow up on..."
          />
        </div>
      </div>

      {/* Next Steps */}
      <div>
        <label className="text-xs text-muted-foreground mb-1 block">Next Steps</label>
        <Textarea
          value={form.nextSteps || ""}
          onChange={e => patch("nextSteps", e.target.value || null)}
          rows={2}
          placeholder="What needs to happen next..."
        />
      </div>

      {/* Description */}
      <div>
        <label className="text-xs text-muted-foreground mb-1 block">Description</label>
        <Textarea
          value={form.description || ""}
          onChange={e => patch("description", e.target.value)}
          rows={4}
          placeholder="Notes, context, analysis..."
        />
      </div>

      {/* Job URL */}
      <div>
        <label className="text-xs text-muted-foreground mb-1 block">Job Posting URL</label>
        <div className="flex gap-2">
          <Input
            value={form.jobUrl || ""}
            onChange={e => patch("jobUrl", e.target.value || null)}
            placeholder="https://..."
            className="flex-1"
          />
          {form.jobUrl && (
            <a href={form.jobUrl} target="_blank" rel="noopener noreferrer">
              <Button variant="outline" size="icon" className="shrink-0" type="button">
                <ExternalLink className="h-4 w-4" />
              </Button>
            </a>
          )}
        </div>
      </div>

      {/* Job Description */}
      <div>
        <label className="text-xs text-muted-foreground mb-1 block">Job Description</label>
        <Textarea
          value={form.jdText || ""}
          onChange={e => patch("jdText", e.target.value || null)}
          rows={8}
          placeholder="Paste the full job description here..."
          className="text-sm font-mono"
        />
      </div>

      {/* Artifact Rail */}
      <ArtifactRail opportunityId={opportunity.id} jdText={form.jdText} />

      {/* Linked Skills */}
      <div>
        <label className="text-xs text-muted-foreground mb-1 block">Skills</label>
        <SkillMultiSelect
          opportunityId={opportunity.id}
          linkedSkills={opportunity.linkedSkills || []}
          onChanged={() => {}}
        />
      </div>

          {/* Delete button */}
          <div className="flex justify-end border-t pt-4">
            <Button variant="destructive" size="sm" onClick={() => setShowDelete(true)}>
              <Trash2 className="mr-1 h-4 w-4" /> Delete
            </Button>
          </div>
        </div>
      </ProfileDetailSection>

      <ProfileDetailSection title="Activities" count={sortedActivities.length} defaultOpen testId="section-opportunity-activities">
        <div className="overflow-hidden rounded-md border border-border/20" data-testid="opportunity-activity-tree">
          {activitiesLoading ? (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">Loading activities…</div>
          ) : sortedActivities.length === 0 ? (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">No linked activities.</div>
          ) : sortedActivities.map(activity => (
            <ExpandableInteractionRow
              key={activity.associationId}
              interaction={activity.interaction}
              personName={activity.personName}
              testId={`opportunity-activity-${activity.associationId}`}
              leadingContent={(
                <div className="flex min-w-0 items-center gap-1.5">
                  <ReferenceChip resolved={resolveReference({ type: "interaction", id: `${activity.personId}~${activity.interaction.id}`, canonical: activity.reference })} />
                  <ReferenceChip resolved={resolveReference({ type: "person", id: activity.personId, canonical: `@person:${activity.personId}` })} />
                </div>
              )}
            />
          ))}
        </div>
      </ProfileDetailSection>
      </div>

      <AlertDialog open={showDelete} onOpenChange={setShowDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete opportunity?</AlertDialogTitle>
            <AlertDialogDescription>This will permanently delete "{opportunity.title}".</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onDelete} className="bg-destructive text-destructive-foreground">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────
export default function OpportunitiesTab() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(() => new Set());
  const [openStatuses, setOpenStatuses] = useState<Set<string>>(() => new Set(["active", "pursuing", "researched", "qualified", "discovered"]));
  const [creating, setCreating] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newType, setNewType] = useState<string>("job");

  const { data: opportunities = [], isLoading } = useQuery<Opportunity[]>({
    queryKey: ["/api/exec/opportunities"],
    refetchInterval: 30000,
  });

  const selected = useMemo(() => opportunities.find(o => o.id === selectedId), [opportunities, selectedId]);

  // Publish the selected opportunity so the focus widget's pageContext carries it.
  useFocusContext(
    selected
      ? { entity: { type: "opportunity", id: String(selected.id), label: selected.title } }
      : null
  );

  const grouped = useMemo(() => {
    const order = ["active", "pursuing", "researched", "qualified", "discovered", "passed", "lost"];
    const groups: Record<string, Opportunity[]> = {};
    for (const s of order) groups[s] = [];
    for (const opportunity of opportunities) {
      if (!matchesOpportunity(opportunity, searchQuery)) continue;
      if (!groups[opportunity.status]) groups[opportunity.status] = [];
      groups[opportunity.status].push(opportunity);
    }
    for (const s of Object.keys(groups)) {
      groups[s].sort((a, b) => (b.computedEv ?? 0) - (a.computedEv ?? 0));
    }
    return Object.entries(groups).filter(([, items]) => items.length > 0);
  }, [opportunities, searchQuery]);

  const createMutation = useMutation({
    mutationFn: async (data: { title: string; type: string }) => {
      const res = await apiRequest("POST", "/api/exec/opportunities", data);
      return res.json();
    },
    onSuccess: (row: Opportunity) => {
      queryClient.invalidateQueries({ queryKey: ["/api/exec/opportunities"] });
      setSelectedId(row.id);
      setExpandedIds(prev => new Set(prev).add(row.id));
      setOpenStatuses(prev => new Set(prev).add(row.status));
      setCreating(false);
      setNewTitle("");
      toast({ title: "Created", description: `"${row.title}" added to pipeline.` });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, updates }: { id: number; updates: Partial<Opportunity> }) => {
      const res = await apiRequest("PATCH", `/api/exec/opportunities/${id}`, updates);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/exec/opportunities"] });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/exec/opportunities/${id}`);
    },
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ["/api/exec/opportunities"] });
      setSelectedId(prev => prev === id ? null : prev);
      setExpandedIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      toast({ title: "Deleted" });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const createOpportunity = useCallback(() => {
    const title = newTitle.trim();
    if (!title) return;
    createMutation.mutate({ title, type: newType });
  }, [createMutation, newTitle, newType]);

  const toggleExpanded = useCallback((id: number) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleStatus = useCallback((status: string) => {
    setOpenStatuses(prev => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }, []);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (opportunities.length === 0 && !creating) {
    return (
      <EmptyState
        icon={DollarSign}
        title="No opportunities yet"
        message="Add one manually or let landscape signals surface them."
        action={(
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4 mr-1" /> Add Opportunity
          </Button>
        )}
        testId="exec-opportunities-empty"
      />
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <div className="flex-1 overflow-y-auto p-2">
        <div className="min-w-0 space-y-1">
          <div className="relative mb-1 min-w-0">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={event => setSearchQuery(event.target.value)}
              placeholder=""
              className="h-7 w-full rounded-md border border-input bg-background pl-7 pr-7 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              aria-label="Search opportunities"
              data-testid="input-search-opportunities"
            />
            {searchQuery ? (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="absolute right-1.5 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                aria-label="Clear opportunity search"
                data-testid="button-clear-opportunity-search"
              >
                <X className="h-3 w-3" />
              </button>
            ) : null}
          </div>

          <button
            type="button"
            onClick={() => setCreating(true)}
            className={cn(
              "mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-cta transition-colors hover:bg-accent/70 hover:text-cta/80",
              creating && "bg-accent",
            )}
            data-testid="button-new-opportunity"
          >
            <Plus className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">New Opportunity</span>
          </button>

          {creating ? (
            <div className="mb-1 space-y-2 rounded-md border border-border/20 bg-muted/20 p-2">
              <Input
                value={newTitle}
                onChange={event => setNewTitle(event.target.value)}
                placeholder="Opportunity title"
                autoFocus
                className="h-8 text-sm"
                onKeyDown={event => {
                  if (event.key === "Enter") createOpportunity();
                  if (event.key === "Escape") { setCreating(false); setNewTitle(""); }
                }}
              />
              <Select value={newType} onValueChange={setNewType}>
                <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TYPES.map(t => <SelectItem key={t} value={t}>{TYPE_LABELS[t]}</SelectItem>)}
                </SelectContent>
              </Select>
              <div className="flex gap-1">
                <Button
                  size="sm"
                  className="h-7 flex-1"
                  disabled={!newTitle.trim() || createMutation.isPending}
                  onClick={createOpportunity}
                >
                  {createMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Add"}
                </Button>
                <Button size="sm" variant="ghost" className="h-7" onClick={() => { setCreating(false); setNewTitle(""); }}>Cancel</Button>
              </div>
            </div>
          ) : null}

          {grouped.length === 0 ? (
            <div className="py-12 text-center">
              <Search className="mx-auto mb-2 h-6 w-6 text-muted-foreground/50" />
              <p className="text-xs text-muted-foreground">
                {searchQuery.trim() ? `No opportunities match "${searchQuery.trim()}"` : "No opportunities in this pipeline."}
              </p>
            </div>
          ) : grouped.map(([status, items]) => {
            const sectionOpen = openStatuses.has(status) || searchQuery.trim().length > 0;
            return (
              <div key={status} className="min-w-0">
                <button
                  type="button"
                  className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground hover:bg-accent/70 hover:text-foreground"
                  onClick={() => toggleStatus(status)}
                  aria-expanded={sectionOpen}
                >
                  <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", sectionOpen && "rotate-90")} />
                  <span className="truncate">{status}</span>
                  <span className="text-muted-foreground/70">{items.length}</span>
                </button>
                {sectionOpen ? items.map(opportunity => {
                  const Icon = TYPE_ICONS[opportunity.type] || Briefcase;
                  const selected = selectedId === opportunity.id;
                  const expanded = expandedIds.has(opportunity.id);
                  return (
                    <div key={opportunity.id} className="min-w-0">
                      <div className="flex min-w-0 items-stretch">
                        <div className="relative mr-1 w-5 shrink-0 self-stretch" aria-hidden="true">
                          <div className="absolute bottom-1/2 left-1/2 top-0 -translate-x-px border-l border-border" />
                          <div className="absolute left-1/2 right-0 top-1/2 border-t border-border" />
                        </div>
                        <div className="relative min-w-0 flex-1 overflow-hidden">
                          <div
                            role="button"
                            tabIndex={0}
                            className={cn(
                              "group relative flex w-full cursor-pointer select-none items-center gap-2 overflow-hidden rounded-md px-2 py-1.5 pr-16 text-left text-sm transition-colors",
                              selected ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
                            )}
                            onClick={() => setSelectedId(opportunity.id)}
                            onKeyDown={event => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                setSelectedId(opportunity.id);
                              }
                            }}
                          >
                            <Icon className="h-3.5 w-3.5 shrink-0" />
                            <span className="min-w-0 flex-1 truncate">{opportunity.title}</span>
                            <button
                              type="button"
                              className="absolute right-8 top-1/2 z-10 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
                              aria-label={`${expanded ? "Collapse" : "Expand"} ${opportunity.title}`}
                              aria-expanded={expanded}
                              onClick={event => {
                                event.stopPropagation();
                                setSelectedId(opportunity.id);
                                toggleExpanded(opportunity.id);
                              }}
                            >
                              <ChevronRight className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")} />
                            </button>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <button
                                  type="button"
                                  className={cn(
                                    "absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-all hover:bg-accent hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100",
                                    selected ? "bg-accent" : "bg-background",
                                  )}
                                  aria-label={`${opportunity.title} actions`}
                                  onClick={event => event.stopPropagation()}
                                >
                                  <MoreHorizontal className="h-3.5 w-3.5" />
                                </button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => setSelectedId(opportunity.id)}>Select row</DropdownMenuItem>
                                <DropdownMenuItem onClick={() => { setSelectedId(opportunity.id); toggleExpanded(opportunity.id); }}>
                                  {expanded ? "Collapse" : "Expand"}
                                </DropdownMenuItem>
                                <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => deleteMutation.mutate(opportunity.id)}>
                                  Delete
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </div>
                      </div>
                      {expanded ? (
                        <div className="ml-6 min-w-0 border-l border-border pl-3 pb-3 pt-1">
                          <div className="rounded-md border border-border/20 bg-card">
                            <OpportunityDetail
                              key={opportunity.id}
                              opportunity={opportunity}
                              onSave={updates => updateMutation.mutate({ id: opportunity.id, updates })}
                              onDelete={() => deleteMutation.mutate(opportunity.id)}
                              saving={updateMutation.isPending}
                            />
                          </div>
                        </div>
                      ) : null}
                    </div>
                  );
                }) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
