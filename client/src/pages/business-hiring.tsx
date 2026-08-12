import { useMemo, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { BusinessPageHeader } from "@/components/business/business-page-header";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import { HIERARCHY_PRIMARY_ACTION_CLASS } from "@/components/hierarchy-section-header";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSelectedBusiness } from "@/hooks/use-selected-business";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import type { BusinessHiringProjection, BusinessHiringSlot } from "@shared/models/business-hiring";
import { currentCalendarMonth } from "@shared/models/business-hiring";
import type { JobRole } from "@shared/models/job-roles";

const FROZEN_CELL = "sticky left-0 z-10 min-w-[13rem] max-w-[13rem] border-r border-border/20 bg-background px-3 py-1.5 text-left";

function approvedSlots(data: BusinessHiringProjection): BusinessHiringSlot[] {
  return data.slots.filter((slot) => slot.status === "approved");
}

function RoleRow({
  slot,
  role,
  months,
  businessId,
}: {
  slot: BusinessHiringSlot;
  role: JobRole | undefined;
  months: BusinessHiringProjection["months"];
  businessId: string;
}) {
  const { toast } = useToast();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["/api/business/hiring", businessId] });
  const startMonth = slot.plannedStartMonth ?? slot.approvalMonth;
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
    onSuccess: invalidate,
    onError: (error: Error) => toast({ title: "Could not remove role", description: error.message, variant: "destructive" }),
  });
  const title = role?.title ?? "Unresolved role";
  return (
    <tr className="border-t border-border/10">
      <td className={cn(FROZEN_CELL, "z-10")}>
        <div className="flex min-h-8 items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-sm text-foreground">{title}</div>
            {role?.team ? <div className="truncate text-xs text-muted-foreground">{role.team}</div> : null}
          </div>
          <button type="button" className="shrink-0 text-muted-foreground hover:text-destructive" aria-label={`Remove ${title}`} onClick={() => remove.mutate()}>
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </td>
      {months.map((month) => {
        const isStart = startMonth === month.calendarMonth;
        const isActive = startMonth <= month.calendarMonth;
        return (
          <td key={month.calendarMonth} className="border-l border-border/10 px-1 py-1 text-center">
            <button
              type="button"
              aria-label={`Start ${title} in ${month.label}`}
              aria-pressed={isStart}
              disabled={update.isPending}
              onClick={() => update.mutate(month.calendarMonth)}
              className={cn(
                "flex h-8 w-full items-center justify-center rounded text-sm tabular-nums",
                isStart ? "bg-cta text-cta-foreground" : isActive ? "text-foreground" : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
              )}
            >
              {isStart ? "Start" : isActive ? "•" : "·"}
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
}: {
  roles: JobRole[];
  months: BusinessHiringProjection["months"];
  businessId: string;
  onDone: () => void;
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
    <tr className="border-t border-border/20">
      <td className={cn(FROZEN_CELL, "z-10")}>
        <Select value={roleId} onValueChange={setRoleId}>
          <SelectTrigger className="h-8" aria-label="Job Role"><SelectValue placeholder="Choose a Job Role" /></SelectTrigger>
          <SelectContent>{roles.map((role) => <SelectItem key={role.id} value={role.id}>{role.title}</SelectItem>)}</SelectContent>
        </Select>
      </td>
      {months.map((month) => (
        <td key={month.calendarMonth} className="border-l border-border/10 px-1 py-1 text-center">
          <button
            type="button"
            disabled={!roleId || create.isPending}
            aria-label={`Start selected role in ${month.label}`}
            onClick={() => create.mutate(month.calendarMonth)}
            className="flex h-8 w-full items-center justify-center rounded text-sm text-muted-foreground hover:bg-accent/70 hover:text-foreground disabled:opacity-50"
          >
            ·
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
    return approvedSlots(data).filter((slot) => {
      if (!term) return true;
      const role = roleById.get(slot.roleId);
      return `${role?.title ?? ""} ${role?.team ?? ""}`.toLowerCase().includes(term);
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
          <div className="overflow-x-auto border-y border-border/20">
            <table className="w-max min-w-full border-collapse text-sm tabular-nums">
              <thead>
                <tr>
                  <th className={cn(FROZEN_CELL, "z-20 border-b py-2 font-medium text-muted-foreground")}>Role</th>
                  {months.map((month) => (
                    <th key={month.calendarMonth} className={cn("min-w-[4.75rem] border-b border-l border-border/10 px-2 py-2 text-center font-medium text-muted-foreground", month.calendarMonth === currentCalendarMonth() && "text-foreground")}>
                      {month.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((slot) => <RoleRow key={slot.id} slot={slot} role={roleById.get(slot.roleId)} months={months} businessId={selectedId} />)}
                {adding ? (
                  <AddRoleRow roles={data.roles} months={months} businessId={selectedId} onDone={() => setAdding(false)} />
                ) : null}
                {rows.length === 0 && !adding ? (
                  <tr>
                    <td colSpan={months.length + 1} className="px-3 py-1.5 text-sm text-muted-foreground">{query ? "No matching roles." : "No approved roles yet."}</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          {adding ? null : (
            <button type="button" className={HIERARCHY_PRIMARY_ACTION_CLASS} onClick={() => setAdding(true)} disabled={data.roles.length === 0}>
              <Plus className="h-3.5 w-3.5" />Add Role
            </button>
          )}
          {data.roles.length === 0 ? <div className="px-2 py-1.5 text-sm text-muted-foreground">Create a Job Role first in Roles.</div> : null}
        </>
      )}
    </div>
  );
}
