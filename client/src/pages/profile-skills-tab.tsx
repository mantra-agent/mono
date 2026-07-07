import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Plus, Trash2, Loader2, Briefcase } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { getInstanceName } from "@/lib/instance-config";

interface ExecSkill {
  id: number;
  name: string;
  category: string | null;
  skillType: string | null;
  proficiency: string | null;
  energyLevel: string | null;
}

const CATEGORIES = ["technical", "business", "creative", "interpersonal", "domain"] as const;
const SKILL_TYPES = ["foundational", "applied", "tool", "domain"] as const;
const PROFICIENCIES = ["novice", "developing", "competent", "proficient", "expert"] as const;
const ENERGY_LEVELS = ["draining", "neutral", "energizing", "flow"] as const;

const ENERGY_COLORS: Record<string, string> = {
  draining: "text-error",
  neutral: "text-muted-foreground",
  energizing: "text-success",
  flow: "text-warning",
};

const SKILL_TYPE_LABELS: Record<string, string> = {
  foundational: "Foundational Capabilities",
  applied: "Applied Skills",
  tool: "Tool Proficiencies",
  domain: "Domain Expertise",
};

function proficiencyIndex(level: string | null): number {
  if (!level) return 0;
  const idx = PROFICIENCIES.indexOf(level as typeof PROFICIENCIES[number]);
  return idx >= 0 ? idx + 1 : 0;
}

// ── Clickable proficiency dots ──────────────────────────────────
function ProficiencyDots({
  value,
  onChange,
}: {
  value: string | null;
  onChange?: (level: string) => void;
}) {
  const filled = proficiencyIndex(value);
  const interactive = !!onChange;
  return (
    <span className={`inline-flex items-center gap-1 ${interactive ? "cursor-pointer hover:bg-muted/50 transition-colors" : ""}`}>
      {PROFICIENCIES.map((level, i) => (
        <span
          key={level}
          title={level}
          className={`inline-block w-2 h-2 rounded-full transition-colors ${
            i < filled ? "bg-primary" : "bg-muted-foreground/20"
          } ${interactive ? "hover:bg-primary/60" : ""}`}
          onClick={interactive ? () => onChange(level) : undefined}
        />
      ))}
    </span>
  );
}

// ── Desktop table row ───────────────────────────────────────────
function SkillRow({
  skill,
  editingCell,
  setEditingCell,
  handleUpdate,
  onDeleteRequest,
  linkedExperience,
}: {
  skill: ExecSkill;
  editingCell: { id: number; field: string } | null;
  setEditingCell: (v: { id: number; field: string } | null) => void;
  handleUpdate: (id: number, field: string, value: unknown) => void;
  onDeleteRequest: (skill: ExecSkill) => void;
  linkedExperience?: Array<{ id: number; domain: string; company: string | null }>;
}) {
  return (
    <tr className="border-b hover:bg-muted/30 transition-colors">
      {/* Name */}
      <td className="px-3 py-1.5">
        {editingCell?.id === skill.id && editingCell.field === "name" ? (
          <Input
            defaultValue={skill.name}
            autoFocus
            className="h-7 text-sm"
            onBlur={(e) => handleUpdate(skill.id, "name", e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleUpdate(skill.id, "name", (e.target as HTMLInputElement).value);
              if (e.key === "Escape") setEditingCell(null);
            }}
          />
        ) : (
          <span
            className="cursor-pointer hover:underline font-medium"
            onClick={() => setEditingCell({ id: skill.id, field: "name" })}
          >
            {skill.name}
          </span>
        )}
      </td>

      {/* Category */}
      <td className="px-3 py-1.5">
        <Select
          value={skill.category || ""}
          onValueChange={(v) => handleUpdate(skill.id, "category", v || null)}
        >
          <SelectTrigger className="h-7 text-xs border-0 bg-transparent shadow-none px-1">
            <SelectValue placeholder="—" />
          </SelectTrigger>
          <SelectContent>
            {CATEGORIES.map((c) => (
              <SelectItem key={c} value={c} className="text-xs">{c}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </td>

      {/* Type */}
      <td className="px-3 py-1.5">
        <Select
          value={skill.skillType || "applied"}
          onValueChange={(v) => handleUpdate(skill.id, "skillType", v || null)}
        >
          <SelectTrigger className="h-7 text-xs border-0 bg-transparent shadow-none px-1">
            <SelectValue placeholder="—" />
          </SelectTrigger>
          <SelectContent>
            {SKILL_TYPES.map((t) => (
              <SelectItem key={t} value={t} className="text-xs">
                {t === "foundational" ? "Foundational" : t === "applied" ? "Applied" : t === "tool" ? "Tool" : "Domain"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </td>

      {/* Proficiency (clickable dots) */}
      <td className="px-3 py-1.5">
        <ProficiencyDots
          value={skill.proficiency}
          onChange={(level) => handleUpdate(skill.id, "proficiency", level)}
        />
      </td>

      {/* Energy */}
      <td className="px-3 py-1.5">
        <Select
          value={skill.energyLevel || ""}
          onValueChange={(v) => handleUpdate(skill.id, "energyLevel", v || null)}
        >
          <SelectTrigger className={`h-7 text-xs border-0 bg-transparent shadow-none px-1 ${ENERGY_COLORS[skill.energyLevel || ""] || ""}`}>
            <SelectValue placeholder="—" />
          </SelectTrigger>
          <SelectContent>
            {ENERGY_LEVELS.map((e) => (
              <SelectItem key={e} value={e} className={`text-xs ${ENERGY_COLORS[e]}`}>{e}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </td>

      {/* Experience */}
      <td className="px-3 py-1.5">
        {(linkedExperience || []).length > 0 && (
          <div className="flex flex-wrap gap-1">
            {linkedExperience!.map(e => (
              <span key={e.id} className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                {e.company || e.domain}
              </span>
            ))}
          </div>
        )}
      </td>

      {/* Delete */}
      <td className="px-3 py-1.5">
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-muted-foreground hover:text-destructive"
          onClick={() => onDeleteRequest(skill)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </td>
    </tr>
  );
}

// ── Mobile card ─────────────────────────────────────────────────
function SkillCard({
  skill,
  handleUpdate,
  onDeleteRequest,
  linkedExperience,
}: {
  skill: ExecSkill;
  handleUpdate: (id: number, field: string, value: unknown) => void;
  onDeleteRequest: (skill: ExecSkill) => void;
  linkedExperience?: Array<{ id: number; domain: string; company: string | null }>;
}) {
  return (
    <div className="rounded-lg border border-border p-3 space-y-2">
      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium text-sm truncate">{skill.name}</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
          onClick={() => onDeleteRequest(skill)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Meta row */}
      <div className="flex items-center gap-2 flex-wrap text-xs">
        {skill.category && (
          <span className="bg-muted px-1.5 py-0.5 rounded text-muted-foreground">{skill.category}</span>
        )}
        {skill.proficiency && (
          <ProficiencyDots
            value={skill.proficiency}
            onChange={(level) => handleUpdate(skill.id, "proficiency", level)}
          />
        )}
        {skill.energyLevel && (
          <span className={`${ENERGY_COLORS[skill.energyLevel] || ""}`}>{skill.energyLevel}</span>
        )}
      </div>

      {/* Type select */}
      <div className="flex items-center gap-2">
        <Select
          value={skill.skillType || "applied"}
          onValueChange={(v) => handleUpdate(skill.id, "skillType", v || null)}
        >
          <SelectTrigger className="h-7 text-xs border-0 bg-muted/50 shadow-none px-2 w-auto">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            {SKILL_TYPES.map((t) => (
              <SelectItem key={t} value={t} className="text-xs">
                {t === "foundational" ? "Foundational" : t === "applied" ? "Applied" : t === "tool" ? "Tool" : "Domain"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Experience refs */}
      {(linkedExperience || []).length > 0 && (
        <div className="flex flex-wrap gap-1">
          {linkedExperience!.map(e => (
            <span key={e.id} className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              {e.company || e.domain}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ExecSkillsTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [newSkillName, setNewSkillName] = useState("");
  const [editingCell, setEditingCell] = useState<{ id: number; field: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ExecSkill | null>(null);

  const { data: skills = [], isLoading } = useQuery<ExecSkill[]>({
    queryKey: ["/api/exec/skills"],
  });

  interface ExperienceRef { id: number; domain: string; company: string | null; }
  const { data: experiences = [] } = useQuery<Array<{ id: number; domain: string; company: string | null; linkedSkills: Array<{ id: number }> }>>({
    queryKey: ["/api/exec/experience"],
  });

  // Build reverse map: skillId → experience refs
  const expBySkill = useMemo(() => {
    const map = new Map<number, ExperienceRef[]>();
    for (const exp of experiences) {
      for (const ls of (exp.linkedSkills || [])) {
        const arr = map.get(ls.id) || [];
        arr.push({ id: exp.id, domain: exp.domain, company: exp.company });
        map.set(ls.id, arr);
      }
    }
    return map;
  }, [experiences]);

  const createMutation = useMutation({
    mutationFn: async (name: string) => {
      const res = await apiRequest("POST", "/api/exec/skills", { name });
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/exec/skills"] });
      setNewSkillName("");
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, updates }: { id: number; updates: Record<string, unknown> }) => {
      const res = await apiRequest("PATCH", `/api/exec/skills/${id}`, updates);
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/exec/skills"] }),
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/exec/skills/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/exec/skills"] });
      setDeleteTarget(null);
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const handleCreate = () => {
    const name = newSkillName.trim();
    if (!name) return;
    createMutation.mutate(name);
  };

  const handleUpdate = (id: number, field: string, value: unknown) => {
    updateMutation.mutate({ id, updates: { [field]: value } });
    setEditingCell(null);
  };

  const handleDeleteConfirm = () => {
    if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
  };

  // Group skills by type
  const grouped = useMemo(() => {
    const groups: Record<string, ExecSkill[]> = {
      foundational: [],
      applied: [],
      tool: [],
      domain: [],
    };
    for (const skill of skills) {
      const type = skill.skillType || "applied";
      if (type in groups) {
        groups[type].push(skill);
      } else {
        groups.applied.push(skill);
      }
    }
    return groups;
  }, [skills]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const renderDesktopTable = (typeSkills: ExecSkill[]) => (
    <div className="overflow-x-auto rounded-lg border border-border hidden @md:block">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50">
            <th className="text-left px-3 py-2 font-medium">Name</th>
            <th className="text-left px-3 py-2 font-medium">Category</th>
            <th className="text-left px-3 py-2 font-medium">Type</th>
            <th className="text-left px-3 py-2 font-medium">Proficiency</th>
            <th className="text-left px-3 py-2 font-medium">Energy</th>
            <th className="text-left px-3 py-2 font-medium">Experience</th>
            <th className="px-3 py-2 w-10"></th>
          </tr>
        </thead>
        <tbody>
          {typeSkills.map((skill) => (
            <SkillRow
              key={skill.id}
              skill={skill}
              editingCell={editingCell}
              setEditingCell={setEditingCell}
              handleUpdate={handleUpdate}
              onDeleteRequest={setDeleteTarget}
              linkedExperience={expBySkill.get(skill.id)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );

  const renderMobileCards = (typeSkills: ExecSkill[]) => (
    <div className="space-y-2 @md:hidden">
      {typeSkills.map((skill) => (
        <SkillCard
          key={skill.id}
          skill={skill}
          handleUpdate={handleUpdate}
          onDeleteRequest={setDeleteTarget}
          linkedExperience={expBySkill.get(skill.id)}
        />
      ))}
    </div>
  );

  const typeOrder: Array<{ key: string; label: string }> = [
    { key: "foundational", label: SKILL_TYPE_LABELS.foundational },
    { key: "applied", label: SKILL_TYPE_LABELS.applied },
    { key: "tool", label: SKILL_TYPE_LABELS.tool },
    { key: "domain", label: SKILL_TYPE_LABELS.domain },
  ];

  return (
    <div className="flex-1 overflow-y-auto min-h-0">
      <div className="p-4 space-y-6">
        {typeOrder.map(({ key, label }) => {
          const typeSkills = grouped[key] || [];
          if (typeSkills.length === 0) return null;
          return (
            <div key={key}>
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                {label} <span className="text-xs font-normal">({typeSkills.length})</span>
              </h3>
              {renderDesktopTable(typeSkills)}
              {renderMobileCards(typeSkills)}
            </div>
          );
        })}

        {/* Add new skill */}
        <div className="flex items-center gap-2 mt-3">
          <Plus className="h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Add skill..."
            value={newSkillName}
            onChange={(e) => setNewSkillName(e.target.value)}
            className="h-8 text-sm max-w-xs"
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreate();
            }}
          />
          <Button size="sm" variant="outline" onClick={handleCreate} disabled={!newSkillName.trim()}>
            Add
          </Button>
        </div>

        {skills.length === 0 && !isLoading && (
          <EmptyState
            icon={Briefcase}
            title="No skills yet"
            message={`Add your first skill above, or talk to ${getInstanceName()} to fill this in.`}
            testId="profile-skills-empty"
          />
        )}
      </div>

      {/* Delete confirmation dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete skill</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{deleteTarget?.name}"? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
