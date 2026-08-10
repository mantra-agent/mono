import { useMemo } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePageHeader } from "@/hooks/use-page-header";
import type { BusinessDefinition } from "@/hooks/use-selected-business";

/** Shared TopBar projection for every page whose data belongs to one Business. */
export function BusinessPageHeader({
  page,
  businesses,
  selectedId,
  onSelect,
}: {
  page: string;
  businesses: BusinessDefinition[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const selected = businesses.find((business) => business.id === selectedId) ?? null;
  const title = selected ? `${selected.publicName} ${page}` : page;
  const selector = useMemo(
    () => (
      <Select value={selectedId ?? undefined} onValueChange={onSelect}>
        <SelectTrigger
          className="h-7 w-auto max-w-64 border-0 bg-transparent px-0 text-sm font-medium shadow-none focus:ring-0"
          data-testid="business-page-selector"
          aria-label="Select Business"
        >
          <SelectValue placeholder={`Select Business · ${page}`} />
        </SelectTrigger>
        <SelectContent>
          {businesses.map((business) => (
            <SelectItem key={business.id} value={business.id}>
              {business.publicName} {page}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ),
    [businesses, onSelect, page, selectedId],
  );

  usePageHeader({ title, customContent: selector });
  return null;
}
