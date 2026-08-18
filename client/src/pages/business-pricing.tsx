import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, Package, Tag } from "lucide-react";
import type {
  BusinessPricing,
  BusinessPricingMutation,
  PricingPackageKey,
  PricingPackageView,
} from "@shared/models/business-pricing";
import { PRICING_PACKAGE_KEYS } from "@shared/models/business-pricing";
import { BusinessPageHeader } from "@/components/business/business-page-header";
import { HierarchyTreeRow } from "@/components/hierarchy-tree";
import { HIERARCHY_TREE_STACK_CLASS } from "@/components/hierarchy-section-header";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSelectedBusiness } from "@/hooks/use-selected-business";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

function formatMoney(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

function formatCount(value: number | null): string {
  return value === null ? "Unlimited" : String(value);
}

function parseMoney(value: string): number | null {
  const amount = Number(value.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(amount) || amount < 0) return null;
  return amount;
}

function parseOptionalCount(value: string): number | null | undefined {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (trimmed === "unlimited" || trimmed === "null") return null;
  const amount = Number(trimmed.replace(/[,\s]/g, ""));
  if (!Number.isInteger(amount) || amount < 0) return undefined;
  return amount;
}

function InlineNumber({
  label,
  display,
  onCommit,
}: {
  label: string;
  display: string;
  onCommit: (raw: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(display);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(display);
  }, [display, editing]);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  if (editing) {
    return (
      <Input
        ref={inputRef}
        className="!mr-5 !h-5 !w-24 text-right tabular-nums"
        aria-label={label}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          onCommit(draft);
          setEditing(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setDraft(display);
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className="mr-5 tabular-nums text-muted-foreground"
      aria-label={`Edit ${label}`}
      onClick={() => setEditing(true)}
    >
      {display}
    </button>
  );
}

function EnumValue({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-6 w-auto border-0 bg-transparent px-0 shadow-none focus:ring-0" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function FieldRow({
  label,
  continues,
  children,
}: {
  label: string;
  continues: boolean;
  children: ReactNode;
}) {
  return (
    <HierarchyTreeRow continues={continues} connectorAnchor="first-row-center" indent="icon">
      <ProfileTreeRow label={label} hasValue showEmpty mobileLayout="inline" valueLayout="compact">
        {children}
      </ProfileTreeRow>
    </HierarchyTreeRow>
  );
}

function PackageSection({
  pkg,
  mutate,
}: {
  pkg: PricingPackageView;
  mutate: (mutation: BusinessPricingMutation) => void;
}) {
  const patch = (next: Record<string, unknown>, clearFields?: string[]) => {
    mutate({
      action: "update_package",
      key: pkg.key,
      patch: { ...next, ...(clearFields?.length ? { clearFields } : {}) },
    });
  };
  const money = (field: string, raw: string) => {
    const next = parseMoney(raw);
    if (next === null || next === (pkg as Record<string, number | null>)[field]) return;
    patch({ [field]: next });
  };
  const nullableMoney = (field: "extraAgentMonthly" | "extraPrincipalMonthly" | "extraParticipantMonthly", raw: string) => {
    const trimmed = raw.trim().toLowerCase();
    if (!trimmed || trimmed === "—" || trimmed === "n/a" || trimmed === "null") {
      if (pkg[field] !== null) patch({}, [field]);
      return;
    }
    const next = parseMoney(raw);
    if (next === null || next === pkg[field]) return;
    patch({ [field]: next });
  };
  const count = (field: "includedAgents" | "includedPrincipals" | "includedTokensMillions", raw: string) => {
    const next = Number(raw.replace(/[,\s]/g, ""));
    if (!Number.isFinite(next) || next < 0 || next === pkg[field]) return;
    patch({ [field]: field === "includedTokensMillions" ? next : Math.round(next) });
  };
  const participants = (raw: string) => {
    const next = parseOptionalCount(raw);
    if (next === undefined) return;
    if (next === null) {
      if (pkg.includedParticipants !== null) patch({}, ["includedParticipants"]);
      return;
    }
    if (next === pkg.includedParticipants) return;
    patch({ includedParticipants: next });
  };

  return (
    <ProfileTreeRow
      label={pkg.name}
      icon={<Package className="h-3.5 w-3.5" />}
      hasValue
      showEmpty
      defaultOpen
      expandedContent={
        <div>
          <FieldRow label="Name" continues>
            <InlineNumber label={`${pkg.name} name`} display={pkg.name} onCommit={(raw) => {
              const name = raw.trim();
              if (name && name !== pkg.name) patch({ name });
            }} />
          </FieldRow>
          <FieldRow label="List monthly" continues>
            <InlineNumber label={`${pkg.name} list monthly`} display={formatMoney(pkg.listMonthly)} onCommit={(raw) => money("listMonthly", raw)} />
          </FieldRow>
          <FieldRow label="Year-one cash" continues>
            <InlineNumber label={`${pkg.name} year-one cash`} display={formatMoney(pkg.yearOneCash)} onCommit={(raw) => money("yearOneCash", raw)} />
          </FieldRow>
          <FieldRow label="Year-one monthly" continues>
            <span className="mr-5 tabular-nums text-muted-foreground">{formatMoney(pkg.yearOneMonthly)}</span>
          </FieldRow>
          <FieldRow label="Year-two monthly" continues>
            <InlineNumber label={`${pkg.name} year-two monthly`} display={formatMoney(pkg.yearTwoMonthly)} onCommit={(raw) => money("yearTwoMonthly", raw)} />
          </FieldRow>
          <FieldRow label="Included Agents" continues>
            <InlineNumber label={`${pkg.name} included Agents`} display={String(pkg.includedAgents)} onCommit={(raw) => count("includedAgents", raw)} />
          </FieldRow>
          <FieldRow label="Included Principals" continues>
            <InlineNumber label={`${pkg.name} included Principals`} display={String(pkg.includedPrincipals)} onCommit={(raw) => count("includedPrincipals", raw)} />
          </FieldRow>
          <FieldRow label="Included Participants" continues>
            <InlineNumber label={`${pkg.name} included Participants`} display={formatCount(pkg.includedParticipants)} onCommit={participants} />
          </FieldRow>
          <FieldRow label="Extra Agent" continues>
            <InlineNumber label={`${pkg.name} extra Agent`} display={pkg.extraAgentMonthly === null ? "—" : formatMoney(pkg.extraAgentMonthly)} onCommit={(raw) => nullableMoney("extraAgentMonthly", raw)} />
          </FieldRow>
          <FieldRow label="Extra Principal" continues>
            <InlineNumber label={`${pkg.name} extra Principal`} display={pkg.extraPrincipalMonthly === null ? "—" : formatMoney(pkg.extraPrincipalMonthly)} onCommit={(raw) => nullableMoney("extraPrincipalMonthly", raw)} />
          </FieldRow>
          <FieldRow label="Extra Participant" continues>
            <InlineNumber label={`${pkg.name} extra Participant`} display={pkg.extraParticipantMonthly === null ? "—" : formatMoney(pkg.extraParticipantMonthly)} onCommit={(raw) => nullableMoney("extraParticipantMonthly", raw)} />
          </FieldRow>
          <FieldRow label="Included tokens (M)" continues>
            <InlineNumber label={`${pkg.name} included tokens`} display={String(pkg.includedTokensMillions)} onCommit={(raw) => count("includedTokensMillions", raw)} />
          </FieldRow>
          <FieldRow label="Factory" continues>
            <EnumValue
              label={`${pkg.name} Factory`}
              value={pkg.factory ? "yes" : "no"}
              options={[{ value: "no", label: "No" }, { value: "yes", label: "Yes" }]}
              onChange={(value) => patch({ factory: value === "yes" })}
            />
          </FieldRow>
          <FieldRow label="Router" continues>
            <EnumValue
              label={`${pkg.name} Router`}
              value={pkg.router}
              options={[{ value: "default", label: "Default" }, { value: "dedicated", label: "Dedicated" }]}
              onChange={(value) => patch({ router: value })}
            />
          </FieldRow>
          <FieldRow label="Customization" continues>
            <EnumValue
              label={`${pkg.name} customization`}
              value={pkg.customization}
              options={[{ value: "standard", label: "Standard" }, { value: "software_factory", label: "Software Factory" }]}
              onChange={(value) => patch({ customization: value })}
            />
          </FieldRow>
          <FieldRow label="Support" continues={false}>
            <EnumValue
              label={`${pkg.name} support`}
              value={pkg.support}
              options={[
                { value: "activation_concierge", label: "Activation Concierge" },
                { value: "elite_concierge", label: "Elite Concierge" },
              ]}
              onChange={(value) => patch({ support: value })}
            />
          </FieldRow>
        </div>
      }
      expandedContentClassName="px-0 pb-0 pl-0"
    >
      <span className="tabular-nums text-muted-foreground">{formatMoney(pkg.listMonthly)} / mo</span>
    </ProfileTreeRow>
  );
}

export default function BusinessPricingPage() {
  const { businesses, selectedId, setSelectedId, selected, isLoading: businessesLoading } = useSelectedBusiness();
  const { toast } = useToast();
  const key = ["/api/business/pricing", selectedId] as const;
  const pricingQuery = useQuery<BusinessPricing>({
    queryKey: key,
    enabled: Boolean(selectedId),
    queryFn: async () => (await apiRequest("GET", `/api/business/pricing?businessId=${encodeURIComponent(selectedId ?? "")}`)).json(),
  });
  const mutation = useMutation({
    mutationFn: async (body: BusinessPricingMutation) => (await apiRequest("PATCH", `/api/business/pricing?businessId=${encodeURIComponent(selectedId ?? "")}`, body)).json(),
    onSuccess: (catalog: BusinessPricing) => queryClient.setQueryData(key, catalog),
    onError: (error: unknown) => toast({ title: "Pricing change failed", description: error instanceof Error ? error.message : "Unknown error", variant: "destructive" }),
  });
  const packages = useMemo(() => {
    const byKey = new Map((pricingQuery.data?.packages ?? []).map((pkg) => [pkg.key, pkg]));
    return PRICING_PACKAGE_KEYS.map((keyName: PricingPackageKey) => byKey.get(keyName)).filter(Boolean) as PricingPackageView[];
  }, [pricingQuery.data?.packages]);
  const extras = pricingQuery.data?.extras;
  const loading = businessesLoading || pricingQuery.isLoading;

  return (
    <div className="p-4">
      <BusinessPageHeader page="Pricing" businesses={businesses} selectedId={selectedId} onSelect={setSelectedId} />
      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="mr-2 h-5 w-5 animate-spin" />Loading pricing…</div>
      ) : selected && pricingQuery.data && extras ? (
        <div className={HIERARCHY_TREE_STACK_CLASS}>
          {packages.map((pkg) => (
            <PackageSection key={pkg.key} pkg={pkg} mutate={(body) => mutation.mutate(body)} />
          ))}
          <ProfileTreeRow
            label="Extras"
            icon={<Tag className="h-3.5 w-3.5" />}
            hasValue
            showEmpty
            defaultOpen
            expandedContent={
              <div>
                <FieldRow label="Extra usage / M" continues>
                  <InlineNumber
                    label="Extra usage per million"
                    display={formatMoney(extras.extraUsagePerMillion)}
                    onCommit={(raw) => {
                      const next = parseMoney(raw);
                      if (next === null || next === extras.extraUsagePerMillion) return;
                      mutation.mutate({ action: "update_extras", patch: { extraUsagePerMillion: next } });
                    }}
                  />
                </FieldRow>
                <FieldRow label="Workhorse input / M" continues={false}>
                  <InlineNumber
                    label="Workhorse input per million"
                    display={formatMoney(extras.workhorseInputPerMillion)}
                    onCommit={(raw) => {
                      const next = parseMoney(raw);
                      if (next === null || next === extras.workhorseInputPerMillion) return;
                      mutation.mutate({ action: "update_extras", patch: { workhorseInputPerMillion: next } });
                    }}
                  />
                </FieldRow>
              </div>
            }
            expandedContentClassName="px-0 pb-0 pl-0"
          />
        </div>
      ) : (
        <div className="px-2 py-1.5 text-sm text-muted-foreground">No Business selected.</div>
      )}
    </div>
  );
}
