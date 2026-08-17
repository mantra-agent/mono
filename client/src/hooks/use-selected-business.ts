import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

// Shared selection state for the whole /business surface: pick a Business, then
// read its Definition / Plan / Metrics. Definition owns the create/edit surface;
// later steps (metrics dashboard) reuse this same hook so there is one selection
// pattern, not a fork per page.

export interface NarrativePageRef {
  id: string;
  title: string;
  slug: string;
}

export interface BusinessDefinition {
  id: string;
  publicName: string;
  entityName: string | null;
  valuesPageId: string | null;
  visionPageId: string | null;
  missionPageId: string | null;
  phasesPageId: string | null;
  pitchPageId: string | null;
  gtmPageId: string | null;
  productPageId: string | null;
  brandPageId: string | null;
  differentiatorsPageId: string | null;
  marketPageId: string | null;
  icpPageId: string | null;
  activationPageId: string | null;
  moatPageId: string | null;
  dataRoomUrl: string | null;
  status: string;
  isPlatformInstrument: boolean;
  vaultIds: string[];
  valuesPage: NarrativePageRef | null;
  visionPage: NarrativePageRef | null;
  missionPage: NarrativePageRef | null;
  phasesPage: NarrativePageRef | null;
  pitchPage: NarrativePageRef | null;
  gtmPage: NarrativePageRef | null;
  productPage: NarrativePageRef | null;
  brandPage: NarrativePageRef | null;
  differentiatorsPage: NarrativePageRef | null;
  marketPage: NarrativePageRef | null;
  icpPage: NarrativePageRef | null;
  activationPage: NarrativePageRef | null;
  moatPage: NarrativePageRef | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface BusinessesResponse {
  businesses: BusinessDefinition[];
}

export const BUSINESS_QUERY_KEY = ["/api/business/definition"] as const;
const SELECTED_BUSINESS_KEY = "business:selected-id";

export interface UseSelectedBusiness {
  businesses: BusinessDefinition[];
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  selected: BusinessDefinition | null;
  isLoading: boolean;
}

export function useSelectedBusiness(): UseSelectedBusiness {
  const { data, isLoading } = useQuery<BusinessesResponse>({ queryKey: BUSINESS_QUERY_KEY });
  const businesses = useMemo(() => data?.businesses ?? [], [data]);

  const [selectedId, setSelectedIdState] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(SELECTED_BUSINESS_KEY);
  });

  const setSelectedId = useCallback((id: string | null) => {
    setSelectedIdState(id);
    if (typeof window === "undefined") return;
    if (id) window.localStorage.setItem(SELECTED_BUSINESS_KEY, id);
    else window.localStorage.removeItem(SELECTED_BUSINESS_KEY);
  }, []);

  // Reconcile the persisted selection against the loaded set: default to the
  // first Business when nothing is selected or the stored id no longer resolves.
  useEffect(() => {
    if (businesses.length === 0) return;
    if (!selectedId || !businesses.some((b) => b.id === selectedId)) {
      setSelectedId(businesses[0].id);
    }
  }, [businesses, selectedId, setSelectedId]);

  const selected = useMemo(
    () => businesses.find((b) => b.id === selectedId) ?? null,
    [businesses, selectedId],
  );

  return { businesses, selectedId, setSelectedId, selected, isLoading };
}
