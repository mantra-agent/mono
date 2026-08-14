import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties } from "react";
import {
  Building2,
  Code2,
  DollarSign,
  HeartHandshake,
  Loader2,
  Megaphone,
  Package,
  Palette,
  Plus,
  Settings2,
  Trash2,
  Users,
  type LucideProps,
} from "lucide-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { BusinessPageHeader } from "@/components/business/business-page-header";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import { HIERARCHY_PRIMARY_ACTION_CLASS } from "@/components/hierarchy-section-header";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSelectedBusiness } from "@/hooks/use-selected-business";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import type { BusinessHiringProjection, BusinessHiringSlot } from "@shared/models/business-hiring";
import { currentCalendarMonth } from "@shared/models/business-hiring";
import type { JobRole, JobTeam } from "@shared/models/job-roles";

const ROLE_COL_STORAGE_KEY = "hiring-role-column-width";
const ROLE_COL_DEFAULT = 192;
const ROLE_COL_MIN = 128;
const ROLE_COL_MAX = 420;

/** Match SessionMenu row geometry: px-2 py-1.5, text-sm, icon + label. Width is runtime-driven. */
const FROZEN_CELL =
  "sticky left-0 z-10 border-r border-border/20 bg-background px-2 py-1.5 text-left align-middle";
/** Same vertical padding as SessionMenu rows — no fixed h-8 that stretches past py-1.5. */
const MONTH_CELL = "min-w-[2.75rem] px-0 py-1.5 text-center align-middle";
const YEAR_DIVIDER = "border-l-2 border-border/70";
/** Thinner than year, brighter than prior /10 so the grid is readable. */
const MONTH_DIVIDER = "border-l border-border/35";
/**
 * SessionMenu section-header typography ONLY — never flex/w-full, which would
 * turn a table `<th>` into a flex box and collapse the column model.
 */
const SHEET_HEADER_CLASS = "text-xs font-bold uppercase tracking-wider text-muted-foreground";

const TEAM_ICONS: Record<JobTeam, ComponentType<LucideProps>> = {
  Executive: Building2,
  Product: Package,
  Engineering: Code2,
  Design: Palette,
  "Go-to-Market": Megaphone,
  "Customer Success": HeartHandshake,
  Operations: Settings2,
  Finance: DollarSign,
  People: Users,
};

function clampRoleColWidth(width: number): number {
  return Math.min(ROLE_COL_MAX, Math.max(ROLE_COL_MIN, Math.round(width)));
}

function readStoredRoleColWidth(): number {
  if (typeof window === "undefined") return ROLE_COL_DEFAULT;
  try {
    const raw = window.localStorage.getItem(ROLE_COL_STORAGE_KEY);
    if (!raw) return ROLE_COL_DEFAULT;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? clampRoleColWidth(parsed) : ROLE_COL_DEFAULT;
  } catch {
    return ROLE_COL_DEFAULT;
  }
}

function TeamIcon({ team }: { team: JobTeam | undefined }) {
  const Icon = team ? TEAM_ICONS[team] : Package;
  return <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />;
}

function startMonthOf(slot: BusinessHiringSlot): string {
  return slot.plannedStartMonth ?? slot.approvalMonth;
}

function monthShort(calendarMonth: string): string {
  const [year, month] = calendarMonth.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month - 1, 1)))
    .toUpperCase();
}

function isYearStart(calendarMonth: string, index: number): boolean {
  return index > 0 && calendarMonth.endsWith("-01");
}

function approvedSlots(data: BusinessHiringProjection): BusinessHiringSlot[] {
  return data.slots.filter((slot) => slot.status === "approved");
}

function RoleRow({
  slot,
  role,
  months,
  businessId,
  frozenStyle,
}: {
  slot: BusinessHiringSlot;
  role: JobRole | undefined;
  months: BusinessHiringProjection["months"];
  businessId: string;
  frozenStyle: CSSProperties;
}) {
  const { toast } = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["/api/business/hiring", businessId] });
  const startMonth = startMonthOf(slot);
  const update = useMutation({
    mutationFn: async (plannedStartMonth: string) => apiRequest("PATCH", `/api/business/hiring/slots/${slot.id}`, {
      businessId,
      plannedStartMonth,
      idempotencyKey: `ui-start-${slot.id}-${plannedStartMonth}`,
    }),
    onSuccess: invalidate,
    onError: (error: Error) => toast({ title: "Could not set start month", description: error.message, variant: "destructive" }),
  });
  const remove = useMutation({
    mutationFn: async () => apiRequest("DELETE", `/api/business/hiring/slots/${slot.id}?businessId=${encodeURIComponent(businessId)}`),
    onSuccess: () => { setConfirmOpen(false); invalidate(); },
    onError: (error: Error) => toast({ title: "Could not remove role", description: error.message, variant: "destructive" }),
  });
  const title = role?.title ?? "Unresolved role";
  return (
    <tr>
      <td className={FROZEN_CELL} style={frozenStyle}>
        <div className="group relative flex w-full items-center gap-2">
          <TeamIcon team={role?.team} />
          <span className="min-w-0 flex-1 truncate text-sm text-foreground" title={role?.team ? `${title} · ${role.team}` : title}>
            {title}
          </span>
          <button
            type="button"
            className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none group-hover:opacity-100 group-focus-within:opacity-100"
            aria-label={`Remove ${title}`}
            onClick={() => setConfirmOpen(true)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove {title}?</AlertDialogTitle>
              <AlertDialogDescription>This removes the approved role from the hiring plan.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
              <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={remove.isPending} onClick={(event) => { event.preventDefault(); remove.mutate(); }}>
                Remove
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </td>
      {months.map((month, index) => {
        const isStart = startMonth === month.calendarMonth;
        const isActive = startMonth <= month.calendarMonth;
        return (
          <td key={month.calendarMonth} className={cn(MONTH_CELL, isYearStart(month.calendarMonth, index) ? YEAR_DIVIDER : MONTH_DIVIDER)}>
            <button
              type="button"
              aria-label={`Start ${title} in ${monthShort(month.calendarMonth)}`}
              aria-pressed={isStart}
              disabled={update.isPending}
              onClick={() => update.mutate(month.calendarMonth)}
              className="group relative flex w-full items-center justify-center"
            >
              {isStart ? (
                <>
                  <span className="absolute left-1/2 right-0 h-0.5 bg-success" />
                  <span className="relative h-2.5 w-2.5 rotate-45 rounded-[1px] bg-success" />
                </>
              ) : isActive ? (
                <span className="h-0.5 w-full bg-success" />
              ) : (
                <span className="h-0.5 w-full bg-transparent group-hover:bg-muted-foreground/30" />
              )}
            </button>
          </td>
        );
      })}
    </tr>
  );
}

function AddRoleRow({
  roles,
  months,
  businessId,
  onDone,
  frozenStyle,
}: {
  roles: JobRole[];
  months: BusinessHiringProjection["months"];
  businessId: string;
  onDone: () => void;
  frozenStyle: CSSProperties;
}) {
  const [roleId, setRoleId] = useState(roles[0]?.id ?? "");
  const { toast } = useToast();
  const create = useMutation({
    mutationFn: async (startMonth: string) => apiRequest("POST", "/api/business/hiring/slots", {
      businessId,
      roleId,
      approvalMonth: startMonth,
      plannedStartMonth: startMonth,
      idempotencyKey: `ui-add-${businessId}-${roleId}-${startMonth}-${Date.now()}`,
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/business/hiring", businessId] });
      onDone();
    },
    onError: (error: Error) => toast({ title: "Could not add role", description: error.message, variant: "destructive" }),
  });
  return (
    <tr>
      <td className={FROZEN_CELL} style={frozenStyle}>
        <Select value={roleId} onValueChange={setRoleId}>
          <SelectTrigger className="h-7" aria-label="Job Role"><SelectValue placeholder="Choose a Job Role" /></SelectTrigger>
          <SelectContent>{roles.map((role) => <SelectItem key={role.id} value={role.id}>{role.title}</SelectItem>)}</SelectContent>
        </Select>
      </td>
      {months.map((month, index) => (
        <td key={month.calendarMonth} className={cn(MONTH_CELL, isYearStart(month.calendarMonth, index) ? YEAR_DIVIDER : MONTH_DIVIDER)}>
          <button
            type="button"
            disabled={!roleId || create.isPending}
            aria-label={`Start selected role in ${monthShort(month.calendarMonth)}`}
            onClick={() => create.mutate(month.calendarMonth)}
            className="group flex w-full items-center justify-center disabled:opacity-50"
          >
            <span className="h-0.5 w-full bg-transparent group-hover:bg-success/50" />
          </button>
        </td>
      ))}
    </tr>
  );
}

export default function BusinessHiringPage() {
  const { businesses, selectedId, setSelectedId, isLoading: businessesLoading } = useSelectedBusiness();
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [roleColWidth, setRoleColWidth] = useState(ROLE_COL_DEFAULT);
  const resizeStartRef = useRef<{ startX: number; startW: number } | null>(null);

  useEffect(() => {
    setRoleColWidth(readStoredRoleColWidth());
  }, []);

  const startRoleColResize = useCallback((event: React.MouseEvent | React.PointerEvent) => {
    if (typeof window === "undefined") return;
    event.preventDefault();
    event.stopPropagation();
    const startX = "clientX" in event ? event.clientX : 0;
    resizeStartRef.current = { startX, startW: roleColWidth };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: MouseEvent) => {
      if (!resizeStartRef.current) return;
      const delta = ev.clientX - resizeStartRef.current.startX;
      setRoleColWidth(clampRoleColWidth(resizeStartRef.current.startW + delta));
    };
    const onUp = (ev: MouseEvent) => {
      if (!resizeStartRef.current) {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        return;
      }
      const delta = ev.clientX - resizeStartRef.current.startX;
      const finalW = clampRoleColWidth(resizeStartRef.current.startW + delta);
      setRoleColWidth(finalW);
      try {
        window.localStorage.setItem(ROLE_COL_STORAGE_KEY, String(finalW));
      } catch {
        // ignore quota / private mode
      }
      resizeStartRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [roleColWidth]);

  const frozenStyle = useMemo<CSSProperties>(() => ({
    width: roleColWidth,
    minWidth: roleColWidth,
    maxWidth: roleColWidth,
  }), [roleColWidth]);

  const key = ["/api/business/hiring", selectedId] as const;
  const { data, isLoading } = useQuery<BusinessHiringProjection>({
    queryKey: key,
    enabled: Boolean(selectedId),
    queryFn: async () => (await apiRequest("GET", `/api/business/hiring?businessId=${encodeURIComponent(selectedId ?? "")}`)).json(),
  });
  const roleById = useMemo(() => new Map((data?.roles ?? []).map((role) => [role.id, role])), [data?.roles]);
  const rows = useMemo(() => {
    if (!data) return [];
    const term = query.trim().toLowerCase();
    return approvedSlots(data)
      .filter((slot) => {
        if (!term) return true;
        const role = roleById.get(slot.roleId);
        return `${role?.title ?? ""} ${role?.team ?? ""}`.toLowerCase().includes(term);
      })
      .sort((a, b) => {
        const byStart = startMonthOf(a).localeCompare(startMonthOf(b));
        if (byStart !== 0) return byStart;
        return (roleById.get(a.roleId)?.title ?? "").localeCompare(roleById.get(b.roleId)?.title ?? "");
      });
  }, [data, query, roleById]);
  if (businessesLoading || isLoading) return <div className="flex h-full items-center justify-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  const months = data?.months ?? [];
  return (
    <div className="w-full p-4">
      <BusinessPageHeader page="Hiring" businesses={businesses} selectedId={selectedId} onSelect={setSelectedId} />
      <div className="flex items-center gap-2 pb-2">
        <div className="min-w-0 flex-1"><HierarchySearchInput value={query} onChange={setQuery} placeholder="Search roles" /></div>
      </div>
      {!selectedId || !data ? (
        <div className="px-2 py-1.5 text-sm text-muted-foreground">No Business selected.</div>
      ) : (
        <>
          {adding ? null : (
            <button type="button" className={HIERARCHY_PRIMARY_ACTION_CLASS} onClick={() => setAdding(true)} disabled={data.roles.length === 0}>
              <Plus className="h-3.5 w-3.5" />Add Role
            </button>
          )}
          {data.roles.length === 0 ? <div className="px-2 py-1.5 text-sm text-muted-foreground">Create a Job Role first in Roles.</div> : null}
          <div className="overflow-x-auto border-y border-border/20 scrollbar-visible">
            <table className="w-max min-w-full border-collapse text-sm tabular-nums">
              <thead>
                <tr>
                  <th className={cn(FROZEN_CELL, SHEET_HEADER_CLASS, "relative z-20 border-b")} style={frozenStyle}>
                    Role
                    <div
                      role="separator"
                      aria-orientation="vertical"
                      aria-label="Resize role column"
                      aria-valuemin={ROLE_COL_MIN}
                      aria-valuemax={ROLE_COL_MAX}
                      aria-valuenow={roleColWidth}
                      onMouseDown={startRoleColResize}
                      className="absolute inset-y-0 -right-1.5 z-30 w-3 cursor-col-resize"
                      data-testid="handle-hiring-role-resize"
                    >
                      <span className="pointer-events-none absolute inset-y-1 left-1/2 w-px -translate-x-1/2 bg-border/40" />
                    </div>
                  </th>
                  {months.map((month, index) => (
                    <th
                      key={month.calendarMonth}
                      className={cn(
                        MONTH_CELL,
                        SHEET_HEADER_CLASS,
                        "border-b",
                        isYearStart(month.calendarMonth, index) ? YEAR_DIVIDER : MONTH_DIVIDER,
                        month.calendarMonth === currentCalendarMonth() && "text-foreground",
                      )}
                    >
                      <div>{monthShort(month.calendarMonth)}</div>
                      {index === 0 || isYearStart(month.calendarMonth, index) ? (
                        <div className="text-2xs font-normal normal-case tracking-normal text-muted-foreground/70">
                          {month.calendarMonth.slice(0, 4)}
                        </div>
                      ) : null}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((slot) => (
                  <RoleRow
                    key={slot.id}
                    slot={slot}
                    role={roleById.get(slot.roleId)}
                    months={months}
                    businessId={selectedId}
                    frozenStyle={frozenStyle}
                  />
                ))}
                {adding ? (
                  <AddRoleRow
                    roles={data.roles}
                    months={months}
                    businessId={selectedId}
                    onDone={() => setAdding(false)}
                    frozenStyle={frozenStyle}
                  />
                ) : null}
                {rows.length === 0 && !adding ? (
                  <tr>
                    <td colSpan={months.length + 1} className="px-2 py-1.5 text-sm text-muted-foreground">{query ? "No matching roles." : "No approved roles yet."}</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
