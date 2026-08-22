import { useMutation, useQuery } from "@tanstack/react-query";
import { CreditCard, Loader2 } from "lucide-react";
import { IntegrationTreeSection } from "@/components/integrations/integration-tree-section";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import { usePageLoadActivity } from "@/hooks/use-page-activity";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { BillingPriceMapRow } from "@shared/billing";

const BILLING_PRICES_QUERY_KEY = ["/api/admin/billing/prices"] as const;

interface BillingPricesResponse {
  prices: BillingPriceMapRow[];
  unmapped: string[];
  complete: boolean;
}

type EditablePriceField = "stripePriceId" | "stripeProductId";

function PriceField({
  row,
  field,
  label,
  canWrite,
}: {
  row: BillingPriceMapRow;
  field: EditablePriceField;
  label: string;
  canWrite: boolean;
}) {
  const { toast } = useToast();
  const value = row[field];
  const mutation = useMutation({
    mutationFn: async (next: string) => {
      const body = {
        pricingRevisionId: row.pricingRevisionId,
        stripePriceId: field === "stripePriceId" ? next.trim() || null : row.stripePriceId,
        stripeProductId: field === "stripeProductId" ? next.trim() || null : row.stripeProductId,
      };
      return (await apiRequest("PUT", `/api/admin/billing/prices/${row.key}`, body)).json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: BILLING_PRICES_QUERY_KEY }),
    onError: (error: Error) => toast({ title: "Could not update price", description: error.message, variant: "destructive" }),
  });

  const displayValue = value == null ? "" : String(value);
  return (
    <ProfileTreeRow label={label} hasValue={displayValue !== ""} showEmpty mobileLayout="inline" testId={`billing-price-${row.key}-${field}`}>
      {canWrite ? (
        <div className="flex items-center gap-2">
          <Input
            key={`${row.key}-${field}-${displayValue}`}
            defaultValue={displayValue}
            placeholder="Not set"
            className="w-52 font-mono text-xs"
            onBlur={(event) => {
              const next = event.currentTarget.value;
              if (next !== displayValue) mutation.mutate(next);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                event.currentTarget.value = displayValue;
                event.currentTarget.blur();
              }
            }}
          />
          {mutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin text-active" /> : null}
        </div>
      ) : (
        <span className="font-mono text-xs text-foreground">{displayValue || "Not set"}</span>
      )}
    </ProfileTreeRow>
  );
}

function PriceRow({ row, canWrite }: { row: BillingPriceMapRow; canWrite: boolean }) {
  return (
    <ProfileTreeRow
      label={row.label}
      icon={<CreditCard className="h-3.5 w-3.5" />}
      hasValue={row.mapped}
      showEmpty
      mobileLayout="inline"
      defaultOpen={!row.mapped}
      testId={`billing-price-${row.key}`}
    >
      <div className="space-y-1 py-1">
        <ProfileTreeRow label="Amount" hasValue mobileLayout="inline">
          <span className="text-xs text-foreground">{new Intl.NumberFormat("en-US", { style: "currency", currency: row.currency }).format(row.amountCents / 100)} · {row.cadence}</span>
        </ProfileTreeRow>
        {row.includedUsage ? <ProfileTreeRow label="Included usage" hasValue mobileLayout="inline"><span className="text-xs text-foreground">{row.includedUsage}</span></ProfileTreeRow> : null}
        <PriceField row={row} field="stripeProductId" label="Product ID" canWrite={canWrite} />
        <PriceField row={row} field="stripePriceId" label="Price ID" canWrite={canWrite} />
      </div>
    </ProfileTreeRow>
  );
}

/** Integrations → Systems → Stripe: persisted price configuration for every paying Account. */
export function StripeDetail() {
  const { hasPermission } = useAuth();
  const canRead = hasPermission("system:read") || hasPermission("system:write");
  const canWrite = hasPermission("system:write");
  const { data, isLoading, error } = useQuery<BillingPricesResponse>({
    queryKey: BILLING_PRICES_QUERY_KEY,
    enabled: canRead,
  });
  usePageLoadActivity(isLoading);

  if (!canRead) return null;

  return (
    <div className="min-w-0" data-testid="stripe-detail">
      <IntegrationTreeSection label="Prices" initialOpen testIdPrefix="stripe-prices" icon={<CreditCard className="h-3.5 w-3.5" />}>
        <div className="space-y-1 px-2 py-1.5">
          {isLoading ? (
            <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : error ? (
            <p className="px-2 py-1.5 text-sm text-destructive">{(error as Error).message || "Failed to load prices"}</p>
          ) : data?.prices.length ? (
            data.prices.map((row) => <PriceRow key={row.key} row={row} canWrite={canWrite} />)
          ) : (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">No prices configured.</div>
          )}
        </div>
      </IntegrationTreeSection>
    </div>
  );
}

export default StripeDetail;
