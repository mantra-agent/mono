import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Plus, Trash2, Pencil, X, Check, Loader2, Users, DollarSign, MapPin, Building2, Trophy, ChevronDown, ChevronRight } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { getInstanceName } from "@/lib/instance-config";

function formatDateRange(startDate: string | null, endDate: string | null): string {
  if (!startDate) return "";
  const fmt = (d: string) => {
    const [y, m] = d.split("-");
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${months[parseInt(m, 10) - 1]} ${y}`;
  };
  return `${fmt(startDate)} – ${endDate ? fmt(endDate) : "Present"}`;
}

interface LinkedSkill {
  id: number;
  name: string;
  category: string | null;
  skillType: string | null;
  proficiency: string | null;
  energyLevel: string | null;
}

interface ExecExperience {
  id: number;
  domain: string;
  narrative: string | null;
  years: number | null;
  keyOutcomes: string[];
  transferableAssets: string[];
  linkedSkills: LinkedSkill[];
  startDate: string | null;
  endDate: string | null;
  company: string | null;
  title: string | null;
  location: string | null;
  teamSizePeak: number | null;
  directReports: number | null;
  pnlOwned: string | null;
  budgetManaged: string | null;
  fundingRaised: string | null;
  companyContext: string | null;
}

interface ExecSkill {
  id: number;
  name: string;
  category: string | null;
  skillType: string | null;
  proficiency: string | null;
  energyLevel: string | null;
}

interface ExecMetric {
  id: number;
  experienceId: number | null;
  metric: string;
  value: string;
  context: string | null;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface EditState {
  domain: string;
  narrative: string;
  years: string;
  keyOutcomes: string;
  startDate: string;
  endDate: string;
  company: string;
  title: string;
  location: string;
  teamSizePeak: string;
  directReports: string;
  pnlOwned: string;
  budgetManaged: string;
  fundingRaised: string;
  companyContext: string;
}

const EMPTY_EDIT: EditState = {
  domain: "", narrative: "", years: "", keyOutcomes: "",
  startDate: "", endDate: "", company: "", title: "", location: "",
  teamSizePeak: "", directReports: "", pnlOwned: "", budgetManaged: "",
  fundingRaised: "", companyContext: "",
};

function buildPayload(state: EditState): Record<string, unknown> {
  return {
    domain: state.domain,
    narrative: state.narrative || null,
    years: state.years ? parseInt(state.years, 10) : null,
    keyOutcomes: state.keyOutcomes.split("\n").map(s => s.trim()).filter(Boolean),
    startDate: state.startDate || null,
    endDate: state.endDate || null,
    company: state.company || null,
    title: state.title || null,
    location: state.location || null,
    teamSizePeak: state.teamSizePeak ? parseInt(state.teamSizePeak, 10) : null,
    directReports: state.directReports ? parseInt(state.directReports, 10) : null,
    pnlOwned: state.pnlOwned || null,
    budgetManaged: state.budgetManaged || null,
    fundingRaised: state.fundingRaised || null,
    companyContext: state.companyContext || null,
  };
}

/** Scope chips shown on role cards in read mode */
function ScopeChips({ exp }: { exp: ExecExperience }) {
  const chips: { icon: React.ReactNode; label: string }[] = [];
  if (exp.location) chips.push({ icon: <MapPin className="h-3 w-3" />, label: exp.location });
  if (exp.teamSizePeak) chips.push({ icon: <Users className="h-3 w-3" />, label: `Team ${exp.teamSizePeak}` });
  if (exp.directReports) chips.push({ icon: <Users className="h-3 w-3" />, label: `${exp.directReports} reports` });
  if (exp.pnlOwned) chips.push({ icon: <DollarSign className="h-3 w-3" />, label: `P&L ${exp.pnlOwned}` });
  if (exp.budgetManaged) chips.push({ icon: <DollarSign className="h-3 w-3" />, label: `Budget ${exp.budgetManaged}` });
  if (exp.fundingRaised) chips.push({ icon: <DollarSign className="h-3 w-3" />, label: `Raised ${exp.fundingRaised}` });
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mt-1.5">
      {chips.map((c, i) => (
        <Badge key={i} variant="outline" className="text-xs font-normal gap-1 px-2 py-0.5 text-muted-foreground">
          {c.icon} {c.label}
        </Badge>
      ))}
    </div>
  );
}

/** Inline metrics bank for an experience entry */
function MetricsBank({ experienceId }: { experienceId: number }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [addingMetric, setAddingMetric] = useState(false);
  const [editingMetricId, setEditingMetricId] = useState<number | null>(null);
  const [metricForm, setMetricForm] = useState({ metric: "", value: "", context: "" });

  const { data: metrics = [] } = useQuery<ExecMetric[]>({
    queryKey: ["/api/exec/metrics", experienceId],
    queryFn: async () => {
      const res = await fetch(`/api/exec/metrics?experienceId=${experienceId}`);
      if (!res.ok) throw new Error("Failed to load metrics");
      return res.json();
    },
  });

  const createMetric = useMutation({
    mutationFn: async (data: { metric: string; value: string; context?: string; experienceId: number }) => {
      const res = await apiRequest("POST", "/api/exec/metrics", data);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/exec/metrics", experienceId] });
      setAddingMetric(false);
      setMetricForm({ metric: "", value: "", context: "" });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const updateMetric = useMutation({
    mutationFn: async ({ id, updates }: { id: number; updates: Record<string, unknown> }) => {
      const res = await apiRequest("PATCH", `/api/exec/metrics/${id}`, updates);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/exec/metrics", experienceId] });
      setEditingMetricId(null);
      setMetricForm({ metric: "", value: "", context: "" });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const deleteMetric = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/exec/metrics/${id}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/exec/metrics", experienceId] }),
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const startEditMetric = (m: ExecMetric) => {
    setEditingMetricId(m.id);
    setMetricForm({ metric: m.metric, value: m.value, context: m.context || "" });
  };

  const cancelEdit = () => {
    setEditingMetricId(null);
    setAddingMetric(false);
    setMetricForm({ metric: "", value: "", context: "" });
  };

  return (
    <div className="mt-2">
      <button
        type="button"
        className="flex items-center gap-1 text-xs font-medium text-muted-foreground uppercase tracking-wide hover:text-foreground transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <Trophy className="h-3 w-3" />
        Metrics
        {metrics.length > 0 && (
          <span className="text-xs font-normal normal-case ml-1">({metrics.length})</span>
        )}
      </button>

      {expanded && (
        <div className="mt-1.5 space-y-1.5 pl-1">
          {metrics.map((m) => (
            <div key={m.id}>
              {editingMetricId === m.id ? (
                <div className="flex items-start gap-1.5">
                  <Input
                    value={metricForm.metric}
                    onChange={(e) => setMetricForm({ ...metricForm, metric: e.target.value })}
                    placeholder="Metric name"
                    className="h-7 text-xs flex-1"
                    autoFocus
                  />
                  <Input
                    value={metricForm.value}
                    onChange={(e) => setMetricForm({ ...metricForm, value: e.target.value })}
                    placeholder="Value"
                    className="h-7 text-xs w-32"
                  />
                  <Input
                    value={metricForm.context}
                    onChange={(e) => setMetricForm({ ...metricForm, context: e.target.value })}
                    placeholder="Context (optional)"
                    className="h-7 text-xs flex-1"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    onClick={() => updateMetric.mutate({
                      id: m.id,
                      updates: {
                        metric: metricForm.metric,
                        value: metricForm.value,
                        context: metricForm.context || null,
                      },
                    })}
                    disabled={!metricForm.metric.trim() || !metricForm.value.trim()}
                  >
                    <Check className="h-3 w-3" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={cancelEdit}>
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2 group text-sm">
                  <Trophy className="h-3 w-3 text-amber-500 shrink-0" />
                  <span className="font-medium text-xs">{m.metric}</span>
                  <span className="text-xs text-muted-foreground">—</span>
                  <span className="text-xs">{m.value}</span>
                  {m.context && <span className="text-xs text-muted-foreground italic">({m.context})</span>}
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity ml-auto">
                    <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => startEditMetric(m)}>
                      <Pencil className="h-2.5 w-2.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 text-muted-foreground hover:text-destructive"
                      onClick={() => deleteMetric.mutate(m.id)}
                    >
                      <Trash2 className="h-2.5 w-2.5" />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))}

          {addingMetric ? (
            <div className="flex items-start gap-1.5">
              <Input
                value={metricForm.metric}
                onChange={(e) => setMetricForm({ ...metricForm, metric: e.target.value })}
                placeholder="Metric name (e.g. Team Size)"
                className="h-7 text-xs flex-1"
                autoFocus
              />
              <Input
                value={metricForm.value}
                onChange={(e) => setMetricForm({ ...metricForm, value: e.target.value })}
                placeholder="Value (e.g. 40+)"
                className="h-7 text-xs w-32"
              />
              <Input
                value={metricForm.context}
                onChange={(e) => setMetricForm({ ...metricForm, context: e.target.value })}
                placeholder="Context (optional)"
                className="h-7 text-xs flex-1"
              />
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                onClick={() => createMetric.mutate({
                  metric: metricForm.metric,
                  value: metricForm.value,
                  context: metricForm.context || undefined,
                  experienceId,
                })}
                disabled={!metricForm.metric.trim() || !metricForm.value.trim()}
              >
                <Check className="h-3 w-3" />
              </Button>
              <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={cancelEdit}>
                <X className="h-3 w-3" />
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-xs px-2 text-muted-foreground"
              onClick={() => { setAddingMetric(true); setMetricForm({ metric: "", value: "", context: "" }); }}
            >
              <Plus className="h-3 w-3 mr-0.5" /> Add metric
            </Button>
          )}

          {metrics.length === 0 && !addingMetric && (
            <p className="text-xs text-muted-foreground italic pl-1">
              No verified metrics yet. Add quantified claims like "99.9% uptime" or "40+ engineers."
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Grouped edit form: Identity, Scope, Story */
function ExperienceForm({
  state,
  onChange,
  onSave,
  onCancel,
  saving,
  exp,
  allSkills,
  skillSearch,
  setSkillSearch,
  skillPickerOpen,
  setSkillPickerOpen,
  getAvailableSkills,
  linkSkillMutation,
  unlinkSkillMutation,
}: {
  state: EditState;
  onChange: (s: EditState) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  exp?: ExecExperience;
  allSkills: ExecSkill[];
  skillSearch: string;
  setSkillSearch: (s: string) => void;
  skillPickerOpen: number | null;
  setSkillPickerOpen: (id: number | null) => void;
  getAvailableSkills: (exp: ExecExperience) => ExecSkill[];
  linkSkillMutation: { mutate: (p: { experienceId: number; skillId: number }) => void };
  unlinkSkillMutation: { mutate: (p: { experienceId: number; skillId: number }) => void };
}) {
  return (
    <div className="space-y-4">
      {/* Identity group */}
      <div className="space-y-2">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Identity</span>
        <div className="grid grid-cols-2 gap-2">
          <Input
            value={state.company}
            onChange={(e) => onChange({ ...state, company: e.target.value })}
            placeholder="Company"
            className="h-8 text-sm"
            autoFocus
          />
          <Input
            value={state.title}
            onChange={(e) => onChange({ ...state, title: e.target.value })}
            placeholder="Title"
            className="h-8 text-sm"
          />
        </div>
        <div className="grid grid-cols-[1fr_80px] gap-2">
          <Input
            value={state.domain}
            onChange={(e) => onChange({ ...state, domain: e.target.value })}
            placeholder="Domain (e.g. Engineering Leadership)"
            className="h-8 text-sm"
          />
          <Input
            value={state.years}
            onChange={(e) => onChange({ ...state, years: e.target.value })}
            placeholder="Yrs"
            type="number"
            className="h-8 text-sm"
          />
        </div>
        <div className="grid grid-cols-[1fr_1fr_1fr] gap-2">
          <Input
            value={state.location}
            onChange={(e) => onChange({ ...state, location: e.target.value })}
            placeholder="Location"
            className="h-8 text-sm"
          />
          <div className="flex items-center gap-1.5">
            <label className="text-xs text-muted-foreground whitespace-nowrap">Start</label>
            <Input
              value={state.startDate}
              onChange={(e) => onChange({ ...state, startDate: e.target.value })}
              type="month"
              className="h-8 text-sm"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <label className="text-xs text-muted-foreground whitespace-nowrap">End</label>
            <Input
              value={state.endDate}
              onChange={(e) => onChange({ ...state, endDate: e.target.value })}
              type="month"
              placeholder="Present"
              className="h-8 text-sm"
            />
          </div>
        </div>
      </div>

      {/* Scope group */}
      <div className="space-y-2">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Scope</span>
        <div className="grid grid-cols-2 gap-2">
          <Input
            value={state.teamSizePeak}
            onChange={(e) => onChange({ ...state, teamSizePeak: e.target.value })}
            placeholder="Peak team size"
            type="number"
            className="h-8 text-sm"
          />
          <Input
            value={state.directReports}
            onChange={(e) => onChange({ ...state, directReports: e.target.value })}
            placeholder="Direct reports"
            type="number"
            className="h-8 text-sm"
          />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Input
            value={state.pnlOwned}
            onChange={(e) => onChange({ ...state, pnlOwned: e.target.value })}
            placeholder="P&L owned"
            className="h-8 text-sm"
          />
          <Input
            value={state.budgetManaged}
            onChange={(e) => onChange({ ...state, budgetManaged: e.target.value })}
            placeholder="Budget managed"
            className="h-8 text-sm"
          />
          <Input
            value={state.fundingRaised}
            onChange={(e) => onChange({ ...state, fundingRaised: e.target.value })}
            placeholder="Funding raised"
            className="h-8 text-sm"
          />
        </div>
        <Input
          value={state.companyContext}
          onChange={(e) => onChange({ ...state, companyContext: e.target.value })}
          placeholder="Company context (e.g. Series B AR startup, 50 employees)"
          className="h-8 text-sm"
        />
      </div>

      {/* Story group */}
      <div className="space-y-2">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Story</span>
        <Textarea
          value={state.narrative}
          onChange={(e) => onChange({ ...state, narrative: e.target.value })}
          placeholder="Narrative (2-3 sentences about what you built and learned)"
          className="text-sm min-h-[60px]"
        />
        <Textarea
          value={state.keyOutcomes}
          onChange={(e) => onChange({ ...state, keyOutcomes: e.target.value })}
          placeholder="Key outcomes (one per line)"
          className="text-sm min-h-[40px]"
        />
      </div>

      {/* Skills tagging (only when editing existing) */}
      {exp && (
        <div>
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Skills</span>
          <div className="flex flex-wrap gap-1.5 mt-1">
            {(exp.linkedSkills || []).map(s => (
              <Badge key={s.id} variant="secondary" className="bg-primary/10 text-primary border border-primary/20 rounded-sm text-xs px-2 py-0.5 gap-1">
                {s.name}
                <button
                  type="button"
                  className="ml-0.5 hover:text-destructive"
                  onClick={() => unlinkSkillMutation.mutate({ experienceId: exp.id, skillId: s.id })}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
            <Popover open={skillPickerOpen === exp.id} onOpenChange={(open) => { setSkillPickerOpen(open ? exp.id : null); setSkillSearch(""); }}>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="h-6 text-xs px-2">
                  <Plus className="h-3 w-3 mr-0.5" /> Add
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-56 p-2" align="start">
                <Input
                  placeholder="Search skills..."
                  value={skillSearch}
                  onChange={(e) => setSkillSearch(e.target.value)}
                  className="h-7 text-xs mb-1"
                  autoFocus
                />
                <div className="max-h-40 overflow-y-auto space-y-0.5">
                  {getAvailableSkills(exp).map(s => (
                    <button
                      key={s.id}
                      type="button"
                      className="w-full text-left px-2 py-1 text-xs rounded hover:bg-muted transition-colors"
                      onClick={() => {
                        linkSkillMutation.mutate({ experienceId: exp.id, skillId: s.id });
                        setSkillPickerOpen(null);
                        setSkillSearch("");
                      }}
                    >
                      {s.name}
                      {s.category && <span className="text-muted-foreground ml-1">({s.category})</span>}
                    </button>
                  ))}
                  {getAvailableSkills(exp).length === 0 && (
                    <p className="text-xs text-muted-foreground px-2 py-1">No matching skills</p>
                  )}
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          <X className="h-3.5 w-3.5 mr-1" /> Cancel
        </Button>
        <Button size="sm" onClick={onSave} disabled={saving}>
          {saving && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
          <Check className="h-3.5 w-3.5 mr-1" /> Save
        </Button>
      </div>
    </div>
  );
}

export default function ExecExperienceTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editState, setEditState] = useState<EditState | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addState, setAddState] = useState<EditState>({ ...EMPTY_EDIT });
  const [skillPickerOpen, setSkillPickerOpen] = useState<number | null>(null);
  const [skillSearch, setSkillSearch] = useState("");

  const { data: experiences = [], isLoading } = useQuery<ExecExperience[]>({
    queryKey: ["/api/exec/experience"],
  });

  const { data: allSkills = [] } = useQuery<ExecSkill[]>({
    queryKey: ["/api/exec/skills"],
  });

  const createMutation = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const res = await apiRequest("POST", "/api/exec/experience", data);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/exec/experience"] });
      setShowAdd(false);
      setAddState({ ...EMPTY_EDIT });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, updates }: { id: number; updates: Record<string, unknown> }) => {
      const res = await apiRequest("PATCH", `/api/exec/experience/${id}`, updates);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/exec/experience"] });
      setEditingId(null);
      setEditState(null);
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/exec/experience/${id}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/exec/experience"] }),
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const linkSkillMutation = useMutation({
    mutationFn: async ({ experienceId, skillId }: { experienceId: number; skillId: number }) => {
      await apiRequest("POST", `/api/exec/experience/${experienceId}/skills/${skillId}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/exec/experience"] }),
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const unlinkSkillMutation = useMutation({
    mutationFn: async ({ experienceId, skillId }: { experienceId: number; skillId: number }) => {
      await apiRequest("DELETE", `/api/exec/experience/${experienceId}/skills/${skillId}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/exec/experience"] }),
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const startEdit = (exp: ExecExperience) => {
    setEditingId(exp.id);
    setEditState({
      domain: exp.domain,
      narrative: exp.narrative || "",
      years: exp.years != null ? String(exp.years) : "",
      keyOutcomes: (exp.keyOutcomes || []).join("\n"),
      startDate: exp.startDate || "",
      endDate: exp.endDate || "",
      company: exp.company || "",
      title: exp.title || "",
      location: exp.location || "",
      teamSizePeak: exp.teamSizePeak != null ? String(exp.teamSizePeak) : "",
      directReports: exp.directReports != null ? String(exp.directReports) : "",
      pnlOwned: exp.pnlOwned || "",
      budgetManaged: exp.budgetManaged || "",
      fundingRaised: exp.fundingRaised || "",
      companyContext: exp.companyContext || "",
    });
  };

  const getAvailableSkills = useCallback((exp: ExecExperience) => {
    const linkedIds = new Set((exp.linkedSkills || []).map(s => s.id));
    return allSkills.filter(s => !linkedIds.has(s.id) && (!skillSearch || s.name.toLowerCase().includes(skillSearch.toLowerCase())));
  }, [allSkills, skillSearch]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto min-h-0">
      <div className="p-4 space-y-3">
        {experiences.map((exp) => (
          <Card key={exp.id} className="overflow-hidden">
            <CardContent className="p-4">
              {editingId === exp.id && editState ? (
                <ExperienceForm
                  state={editState}
                  onChange={setEditState}
                  onSave={() => updateMutation.mutate({ id: exp.id, updates: buildPayload(editState) })}
                  onCancel={() => { setEditingId(null); setEditState(null); }}
                  saving={updateMutation.isPending}
                  exp={exp}
                  allSkills={allSkills}
                  skillSearch={skillSearch}
                  setSkillSearch={setSkillSearch}
                  skillPickerOpen={skillPickerOpen}
                  setSkillPickerOpen={setSkillPickerOpen}
                  getAvailableSkills={getAvailableSkills}
                  linkSkillMutation={linkSkillMutation}
                  unlinkSkillMutation={unlinkSkillMutation}
                />
              ) : (
                <div>
                  {/* Role card header: Company — Title, right-aligned dates */}
                  <div className="flex items-start justify-between mb-1">
                    <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        {exp.company && (
                          <span className="text-sm font-semibold flex items-center gap-1.5">
                            <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                            {exp.company}
                          </span>
                        )}
                        {exp.title && (
                          <>
                            {exp.company && <span className="text-muted-foreground text-sm">—</span>}
                            <span className="text-sm font-medium">{exp.title}</span>
                          </>
                        )}
                        {!exp.title && (
                          <Badge variant="secondary" className="bg-cat-event/15 text-cat-event-foreground border border-cat-event/30 rounded-sm text-xs font-medium px-2 py-0.5">
                            {exp.domain}
                          </Badge>
                        )}
                      </div>
                      {exp.title && (
                        <span className="text-xs text-muted-foreground">{exp.domain}{exp.years != null ? ` · ${exp.years}y` : ""}</span>
                      )}
                      {!exp.title && exp.years != null && (
                        <span className="text-xs text-muted-foreground">{exp.years}y</span>
                      )}
                      {exp.companyContext && (
                        <span className="text-xs text-muted-foreground italic">{exp.companyContext}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0 ml-2">
                      {exp.startDate && (
                        <span className="text-xs text-muted-foreground whitespace-nowrap mr-1">
                          {formatDateRange(exp.startDate, exp.endDate)}
                        </span>
                      )}
                      <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => startEdit(exp)}>
                        <Pencil className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-muted-foreground hover:text-destructive"
                        onClick={() => deleteMutation.mutate(exp.id)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>

                  {/* Scope chips */}
                  <ScopeChips exp={exp} />

                  {exp.narrative && (
                    <p className="text-sm text-foreground mt-2">{exp.narrative}</p>
                  )}
                  {(exp.keyOutcomes || []).length > 0 && (
                    <div className="mt-2">
                      <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Outcomes</span>
                      <ul className="list-disc list-inside text-sm text-muted-foreground mt-0.5">
                        {exp.keyOutcomes.map((o, i) => <li key={i}>{o}</li>)}
                      </ul>
                    </div>
                  )}
                  {(exp.linkedSkills || []).length > 0 && (
                    <div className="mt-2">
                      <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Skills</span>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {exp.linkedSkills.map(s => (
                          <Badge key={s.id} variant="secondary" className="bg-primary/10 text-primary border border-primary/20 rounded-sm text-xs px-2 py-0.5">
                            {s.name}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Metrics bank */}
                  <MetricsBank experienceId={exp.id} />

                  {!exp.narrative && !(exp.keyOutcomes || []).length && !(exp.linkedSkills || []).length && (
                    <p className="text-sm text-muted-foreground italic mt-2">Click edit to add details.</p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        ))}

        {/* Add experience form */}
        {showAdd ? (
          <Card className="border-dashed">
            <CardContent className="p-4">
              <ExperienceForm
                state={addState}
                onChange={setAddState}
                onSave={() => {
                  if (!addState.domain.trim()) return;
                  createMutation.mutate(buildPayload(addState));
                }}
                onCancel={() => setShowAdd(false)}
                saving={createMutation.isPending}
                allSkills={allSkills}
                skillSearch={skillSearch}
                setSkillSearch={setSkillSearch}
                skillPickerOpen={skillPickerOpen}
                setSkillPickerOpen={setSkillPickerOpen}
                getAvailableSkills={getAvailableSkills}
                linkSkillMutation={linkSkillMutation}
                unlinkSkillMutation={unlinkSkillMutation}
              />
            </CardContent>
          </Card>
        ) : (
          <Button variant="outline" size="sm" className="w-full" onClick={() => setShowAdd(true)}>
            <Plus className="h-4 w-4 mr-1" /> Add Experience
          </Button>
        )}

        {experiences.length === 0 && !showAdd && (
          <EmptyState
            icon={Trophy}
            title="No experience entries yet"
            message={`Add your first domain experience, or talk to ${getInstanceName()}.`}
            testId="profile-experience-empty"
          />
        )}
      </div>
    </div>
  );
}
