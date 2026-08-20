import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CreditCard, Loader2 } from "lucide-react";
import { ProfileDetailSection } from "@/components/profile-detail-section";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import { usePageLoadActivity } from "@/hooks/use-page-activity";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { BillingPriceKey, BillingPriceMapRow } from "@shared/billing";

const BILLING_PRICES_QUERY_KEY = ["/api/admin/billing/prices"] as const;

interface BillingPricesResponse {
  prices: BillingPriceMapRow[];
  requiredForTive: string[];
  completeForTive: boolean;
}

function formatAmount(cents: number | null | undefined): string {
  if (cents == null) return "metered";
  return `$${(cents / 100).toLocaleString("en-US")}/mo`;
}

function PriceRow({
  row,
  canWrite,
}: {
  row: BillingPriceMapRow;
  canWrite: boolean;
}) {
  const { toast } = useToast();
  const [draft, setDraft] = useState(row.stripePriceId ?? "");
  const dirty = draft.trim() !== (row.stripePriceId ?? "");

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body = {
        stripePriceId: draft.trim(),
        amountCents: row.expectedAmountCents,
      };
      return (await apiRequest("PUT", `/api/admin/billing/prices/${row.key}`, body)).json() as Promise<{ price: BillingPriceMapRow }>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: BILLING_PRICES_QUERY_KEY });
      toast({ title: "Price mapped", description: `${row.key} → ${draft.trim()}` });
    },
    onError: (error: Error) => {
      toast({ title: "Could not save price", description: error.message, variant: "destructive" });
    },
  });

  return (
    <ProfileTreeRow
      label={row.key}
      icon={<CreditCard className="h-3.5 w-3.5" />}
      hasValue={row.mapped || dirty}
      showEmpty
      mobileLayout="inline"
      valueLayout="compact"
      defaultOpen={!row.mapped}
      testId={`billing-price-${row.key}`}
      expandedContent={
        <div className="space-y-2 px-2 pb-2">
          <p className="text-xs text-muted-foreground">{row.label} · {formatAmount(row.expectedAmountCents)}</p>
          {canWrite ? (
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="h-8 min-w-[16rem] flex-1 font-mono text-xs"
                placeholder="price_…"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
              <Button
                type="button"
                size="sm"
                className="h-8"
                disabled={!dirty || !draft.trim().startsWith("price_") || saveMutation.isPending}
                onClick={() => saveMutation.mutate()}
              >
                {saveMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
              </Button>
            </div>
          ) : (
            <p className="font-mono text-xs text-muted-foreground">{row.stripePriceId ?? "Not mapped"}</p>
          )}
        </div>
      }
    >
      <span className={row.mapped ? "font-mono text-xs text-foreground" : "text-muted-foreground"}>
        {row.mapped ? row.stripePriceId : "Not mapped"}
      </span>
    </ProfileTreeRow>
  );
}

export default function BillingAdminPage() {
  const { hasPermission } = useAuth();
  const canRead = hasPermission("system:read") || hasPermission("system:write");
  const canWrite = hasPermission("system:write");

  const { data, isLoading, error } = useQuery<BillingPricesResponse>({
    queryKey: BILLING_PRICES_QUERY_KEY,
    enabled: canRead,
  });
  usePageLoadActivity(isLoading);

  const groups = useMemo(() => {
    const prices = data?.prices ?? [];
    const by = (keys: BillingPriceKey[]) => prices.filter((row) => keys.includes(row.key));
    return {
      tive: by(["tive_custom", "token_overage"]),
      ladder: by(["max", "max_plus", "factory_plus"]),
      extras: by(["extra_principal", "extra_agent", "extra_participant"]),
    };
  }, [data?.prices]);

  if (!canRead) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Billing price map requires system access.
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 text-sm text-destructive">
        {(error as Error).message || "Failed to load billing prices"}
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 p-6">
      <p className="text-sm text-muted-foreground">
        Map closed Mantra collector keys to Stripe Price IDs from the Dashboard.
        Create Prices in Stripe first; this screen only stores the id map used by Checkout.
        TIVE needs <span className="font-mono">tive_custom</span> +{" "}
        <span className="font-mono">token_overage</span>
        {data?.completeForTive ? " — ready." : " — incomplete."}
      </p>

      <ProfileDetailSection title="TIVE first" defaultOpen testId="billing-section-tive">
        {groups.tive.map((row) => (
          <PriceRow key={row.key} row={row} canWrite={canWrite} />
        ))}
      </ProfileDetailSection>

      <ProfileDetailSection title="Ladder" defaultOpen={false} testId="billing-section-ladder">
        {groups.ladder.map((row) => (
          <PriceRow key={row.key} row={row} canWrite={canWrite} />
        ))}
      </ProfileDetailSection>

      <ProfileDetailSection title="Extras" defaultOpen={false} testId="billing-section-extras">
        {groups.extras.map((row) => (
          <PriceRow key={row.key} row={row} canWrite={canWrite} />
        ))}
      </ProfileDetailSection>
    </div>
  );
}
