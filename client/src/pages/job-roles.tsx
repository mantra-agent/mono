import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createReferenceRef } from "@shared/references";
import {
  BadgeDollarSign,
  BookOpen,
  BriefcaseBusiness,
  Building2,
  FileText,
  Loader2,
  Percent,
  Plus,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { JOB_TEAMS, type JobRole, type JobRoleCreate, type JobRoleScorecardPage, type JobRoleUpdate, type JobTeam } from "@shared/models/job-roles";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import { HIERARCHY_PRIMARY_ACTION_CLASS, HierarchySectionHeader } from "@/components/hierarchy-section-header";
import { SimpleTextFrame } from "@/components/home/simple-text-frame";
import { ReferencePicker } from "@/components/references/reference-picker";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import type { LibraryPageFull } from "@/pages/library/types";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { usePageHeader } from "@/hooks/use-page-header";
import { useToast } from "@/hooks/use-toast";
import { usePageLoadActivity } from "@/hooks/use-page-activity";
import { cn } from "@/lib/utils";

interface JobRolesResponse {
  roles: JobRole[];
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function NumberEditor({ value, onCommit, prefix, suffix, testId }: { value: number; onCommit: (value: number) => void; prefix?: string; suffix?: string; testId: string }) {
  return (
    <div className="flex items-center justify-end gap-1">
      {prefix && <span className="text-muted-foreground">{prefix}</span>}
      <Input
        key={value}
        type="number"
        min={0}
        step={1}
        defaultValue={value}
        onBlur={(event) => {
          const next = Number(event.currentTarget.value);
          if (Number.isFinite(next) && next >= 0 && next !== value) onCommit(next);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") event.currentTarget.value = String(value);
        }}
        data-testid={testId}
      />
      {suffix && <span className="text-muted-foreground">{suffix}</span>}
    </div>
  );
}

function ScorecardPagePicker({
  current,
  onAssign,
  onCancel,
  testId,
}: {
  current?: JobRoleScorecardPage | null;
  onAssign: (pageId: string) => void;
  onCancel?: () => void;
  testId: string;
}) {
  return (
    <div className="flex w-full items-center gap-1" onClick={(event) => event.stopPropagation()}>
      <ReferencePicker
        value={current ? [{ type: "page", id: current.id, label: current.title }] : []}
        onChange={(next) => {
          const selected = next[0];
          if (selected) onAssign(selected.id);
        }}
        types={["page"]}
        mode="single"
        variant="compact"
        placeholder="Choose Scorecard page"
        showToken={false}
        className={HIERARCHY_PRIMARY_ACTION_CLASS}
        testId={testId}
      />
      {onCancel ? (
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 text-muted-foreground/70"
          onClick={onCancel}
          aria-label="Cancel"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      ) : null}
    </div>
  );
}

function RoleScorecardBody({ page }: { page: JobRoleScorecardPage }) {
  const { data, isLoading, isError } = useQuery<LibraryPageFull>({
    queryKey: ["/api/info/library", page.id],
  });
  return (
    <div onClick={(event) => event.stopPropagation()}>
      <SimpleTextFrame
        content={data?.plainTextContent}
        loading={isLoading}
        error={isError ? "This page could not be loaded." : null}
      />
    </div>
  );
}

function RoleEditor({ role, onDeleted }: { role: JobRole; onDeleted: () => void }) {
  const { toast } = useToast();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingScorecard, setEditingScorecard] = useState(false);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["/api/business/roles"] });
  const update = useMutation({
    mutationFn: async (patch: JobRoleUpdate) => (await apiRequest("PATCH", `/api/business/roles/${role.id}`, patch)).json() as Promise<JobRole>,
    onSuccess: invalidate,
    onError: (error: Error) => toast({ title: "Failed to update role", description: error.message, variant: "destructive" }),
  });
  const remove = useMutation({
    mutationFn: async () => apiRequest("DELETE", `/api/business/roles/${role.id}`),
    onSuccess: () => { invalidate(); onDeleted(); },
    onError: (error: Error) => toast({ title: "Failed to delete role", description: error.message, variant: "destructive" }),
  });
  const scorecardPage = role.scorecardPage;
  const scorecardRef = scorecardPage
    ? createReferenceRef({
        type: "page",
        id: scorecardPage.id,
        metadata: {
          label: scorecardPage.title,
          href: `/info#library?page=${encodeURIComponent(scorecardPage.slug || scorecardPage.id)}`,
        },
      })
    : null;

  return (
    <div className="overflow-hidden rounded-md border border-border/20" data-testid={`role-editor-${role.id}`}>
      <ProfileTreeRow label="Job Title" icon={<BriefcaseBusiness className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline">
        <Input
          key={role.title}
          defaultValue={role.title}
          onBlur={(event) => {
            const title = event.currentTarget.value.trim();
            if (title && title !== role.title) update.mutate({ title });
          }}
          onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") event.currentTarget.value = role.title; }}
          data-testid={`input-role-title-${role.id}`}
        />
      </ProfileTreeRow>
      <ProfileTreeRow label="Description" icon={<FileText className="h-3.5 w-3.5" />} hasValue={Boolean(role.description)} showEmpty expandedContent={(
        <Textarea
          key={role.description}
          defaultValue={role.description}
          placeholder="Define the role, outcomes, and responsibilities."
          className="min-h-36 w-full"
          onBlur={(event) => { const description = event.currentTarget.value.trim(); if (description !== role.description) update.mutate(description ? { description } : { clearFields: ["description"] }); }}
          data-testid={`textarea-role-description-${role.id}`}
        />
      )} mobileLayout="inline">
        <span className="truncate text-muted-foreground">{role.description || "Add description"}</span>
      </ProfileTreeRow>
      <ProfileTreeRow
        label="Scorecard"
        icon={<BookOpen className="h-3.5 w-3.5" />}
        hasValue={Boolean(scorecardPage)}
        showEmpty
        mobileLayout="inline"
        menuVisibility="hover"
        testId={`role-scorecard-${role.id}`}
        expandedContent={scorecardPage ? <RoleScorecardBody page={scorecardPage} /> : undefined}
        menuContent={
          scorecardPage ? (
            <>
              <DropdownMenuItem
                disabled={update.isPending}
                onSelect={() => setEditingScorecard(true)}
                data-testid={`menu-role-scorecard-change-${role.id}`}
              >
                Change page
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                disabled={update.isPending}
                onSelect={() => update.mutate({ clearFields: ["scorecardPageId"] })}
                data-testid={`menu-role-scorecard-clear-${role.id}`}
              >
                Clear
              </DropdownMenuItem>
            </>
          ) : undefined
        }
      >
        {scorecardPage && scorecardRef && !editingScorecard ? (
          <span className="inline-flex max-w-full" onClick={(event) => event.stopPropagation()}>
            <ReferenceRenderer refValue={scorecardRef} surface="simple-row" />
          </span>
        ) : (
          <ScorecardPagePicker
            current={scorecardPage}
            testId={`picker-role-scorecard-${role.id}`}
            onAssign={(pageId) => {
              update.mutate({ scorecardPageId: pageId });
              setEditingScorecard(false);
            }}
            onCancel={scorecardPage ? () => setEditingScorecard(false) : undefined}
          />
        )}
      </ProfileTreeRow>
      <ProfileTreeRow label="Team" icon={<Building2 className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline">
        <Select value={role.team} onValueChange={(team) => update.mutate({ team: team as JobTeam })}>
          <SelectTrigger data-testid={`select-role-team-${role.id}`}><SelectValue /></SelectTrigger>
          <SelectContent>{JOB_TEAMS.map((team) => <SelectItem key={team} value={team}>{team}</SelectItem>)}</SelectContent>
        </Select>
      </ProfileTreeRow>
      <ProfileTreeRow label="Salary Minimum" icon={<BadgeDollarSign className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline">
        <NumberEditor value={role.annualSalaryMin} onCommit={(annualSalaryMin) => update.mutate({ annualSalaryMin })} prefix="$" testId={`input-role-salary-min-${role.id}`} />
      </ProfileTreeRow>
      <ProfileTreeRow label="Salary Maximum" icon={<BadgeDollarSign className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline">
        <NumberEditor value={role.annualSalaryMax} onCommit={(annualSalaryMax) => update.mutate({ annualSalaryMax })} prefix="$" testId={`input-role-salary-max-${role.id}`} />
      </ProfileTreeRow>
      <ProfileTreeRow label="Target Bonus" icon={<Percent className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline">
        <NumberEditor value={role.targetBonusPercent} onCommit={(targetBonusPercent) => update.mutate({ targetBonusPercent })} suffix="%" testId={`input-role-bonus-${role.id}`} />
      </ProfileTreeRow>
      <ProfileTreeRow label="Equity Shares" icon={<Save className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline">
        <NumberEditor value={role.equityShareCount} onCommit={(equityShareCount) => update.mutate({ equityShareCount })} testId={`input-role-equity-${role.id}`} />
      </ProfileTreeRow>
      <div className="flex justify-end px-2 py-1">
        <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)} data-testid={`button-delete-role-${role.id}`}>
          <Trash2 className="mr-1.5 h-3.5 w-3.5" />Delete
        </Button>
      </div>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Delete {role.title}?</AlertDialogTitle><AlertDialogDescription>This role will no longer be available to future hiring plans.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => remove.mutate()} className="bg-destructive text-destructive-foreground">Delete</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function RoleRow({ role, open, onToggle }: { role: JobRole; open: boolean; onToggle: () => void }) {
  return (
    <div className="relative ml-3 border-l border-border/40 pl-3">
      <button
        type="button"
        onClick={onToggle}
        className={cn("flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/70", open && "bg-accent text-foreground")}
        aria-expanded={open}
        data-testid={`button-role-${role.id}`}
      >
        <BriefcaseBusiness className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{role.title}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{formatCurrency(role.annualSalaryMin)}–{formatCurrency(role.annualSalaryMax)}</span>
      </button>
      {open && <div className="pb-2 pl-2 pt-1"><RoleEditor role={role} onDeleted={onToggle} /></div>}
    </div>
  );
}

function NewRoleForm({ onCancel }: { onCancel: () => void }) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<JobRoleCreate>({ title: "", description: "", team: "Engineering", annualSalaryMin: 0, annualSalaryMax: 0, targetBonusPercent: 0, equityShareCount: 0 });
  const create = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/business/roles", draft)).json() as Promise<JobRole>,
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/business/roles"] }); onCancel(); },
    onError: (error: Error) => toast({ title: "Failed to create role", description: error.message, variant: "destructive" }),
  });
  const numberField = (label: string, key: "annualSalaryMin" | "annualSalaryMax" | "targetBonusPercent" | "equityShareCount", suffix?: string) => (
    <label className="space-y-1 text-xs text-muted-foreground"><span>{label}</span><div className="flex items-center gap-1"><Input type="number" min={0} value={draft[key]} onChange={(event) => setDraft((current) => ({ ...current, [key]: Number(event.target.value) }))} />{suffix && <span>{suffix}</span>}</div></label>
  );
  return (
    <div className="space-y-3 rounded-md border border-border/20 p-3" data-testid="new-role-form">
      <Input autoFocus value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} placeholder="Job title" data-testid="input-new-role-title" />
      <Select value={draft.team} onValueChange={(team) => setDraft((current) => ({ ...current, team: team as JobTeam }))}><SelectTrigger data-testid="select-new-role-team"><SelectValue /></SelectTrigger><SelectContent>{JOB_TEAMS.map((team) => <SelectItem key={team} value={team}>{team}</SelectItem>)}</SelectContent></Select>
      <Textarea value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} placeholder="Job description" className="min-h-28" />
      <div className="grid grid-cols-2 gap-2">{numberField("Salary minimum", "annualSalaryMin")}{numberField("Salary maximum", "annualSalaryMax")}{numberField("Target bonus", "targetBonusPercent", "%")}{numberField("Equity shares", "equityShareCount")}</div>
      <div className="flex justify-end gap-2"><Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button><Button size="sm" disabled={!draft.title.trim() || draft.annualSalaryMax < draft.annualSalaryMin || create.isPending} onClick={() => create.mutate()}>{create.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}Add Role</Button></div>
    </div>
  );
}

export default function JobRolesPage() {
  usePageHeader({ title: "Roles" });
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useQuery<JobRolesResponse>({ queryKey: ["/api/business/roles"] });
  usePageLoadActivity("page:job-roles", isLoading);
  const grouped = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const roles = (data?.roles || []).filter((role) => !needle || `${role.title} ${role.description} ${role.team}`.toLowerCase().includes(needle));
    return JOB_TEAMS.map((team) => ({ team, roles: roles.filter((role) => role.team === team) })).filter((group) => group.roles.length > 0);
  }, [data?.roles, search]);

  let content: ReactNode;
  if (isLoading) content = null;
  else if (error) content = <div className="px-2 py-3 text-sm text-destructive">Roles unavailable. <button className="text-cta" onClick={() => void refetch()}>Try again</button></div>;
  else if (grouped.length === 0) content = <div className="px-2 py-1.5 text-sm text-muted-foreground">{search ? "No roles match this search." : "No roles defined yet."}</div>;
  else content = grouped.map(({ team, roles }) => <section key={team} className="space-y-0.5"><HierarchySectionHeader>{team} · {formatNumber(roles.length)}</HierarchySectionHeader>{roles.map((role) => <RoleRow key={role.id} role={role} open={openId === role.id} onToggle={() => setOpenId((current) => current === role.id ? null : role.id)} />)}</section>);

  return (
    <div className="h-full overflow-y-auto bg-background" data-testid="job-roles-page">
      <div className="w-full p-2 @md:w-1/3 @md:min-w-[24rem]">
        <HierarchySearchInput value={search} onChange={setSearch} inputTestId="input-search-roles" clearTestId="button-clear-roles-search" ariaLabel="Search roles" />
        {creating ? <NewRoleForm onCancel={() => setCreating(false)} /> : <button type="button" onClick={() => setCreating(true)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-cta transition-colors hover:bg-accent/70" data-testid="button-new-role"><Plus className="h-3.5 w-3.5" />New Role</button>}
        <div className="mt-1 space-y-1">{content}</div>
      </div>
    </div>
  );
}
