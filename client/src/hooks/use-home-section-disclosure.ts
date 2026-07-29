import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/hooks/use-auth";

const HOME_SECTION_DISCLOSURE_KEY = "mantra.home.section-disclosure.v1";
const MAX_PRINCIPALS = 12;
const MAX_SECTIONS_PER_PRINCIPAL = 64;

type SectionPreferences = Record<string, boolean>;
type PrincipalPreferenceMap = Record<string, SectionPreferences>;

function readPreferenceMap(): PrincipalPreferenceMap {
  try {
    const raw = window.localStorage.getItem(HOME_SECTION_DISCLOSURE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    const principals: PrincipalPreferenceMap = {};
    for (const [principalKey, value] of Object.entries(parsed).slice(-MAX_PRINCIPALS)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const sections: SectionPreferences = {};
      for (const [sectionKey, open] of Object.entries(value).slice(-MAX_SECTIONS_PER_PRINCIPAL)) {
        if (typeof open === "boolean") sections[sectionKey] = open;
      }
      principals[principalKey] = sections;
    }
    return principals;
  } catch {
    return {};
  }
}

function readSectionPreference(principalKey: string | null, sectionKey: string): boolean {
  if (!principalKey) return true;
  return readPreferenceMap()[principalKey]?.[sectionKey] ?? true;
}

function persistSectionPreference(principalKey: string, sectionKey: string, open: boolean): void {
  try {
    const current = readPreferenceMap();
    const sections = {
      ...(current[principalKey] ?? {}),
      [sectionKey]: open,
    };
    const boundedSections = Object.fromEntries(
      Object.entries(sections).slice(-MAX_SECTIONS_PER_PRINCIPAL),
    );
    delete current[principalKey];
    current[principalKey] = boundedSections;
    const boundedPrincipals = Object.fromEntries(
      Object.entries(current).slice(-MAX_PRINCIPALS),
    );
    window.localStorage.setItem(HOME_SECTION_DISCLOSURE_KEY, JSON.stringify(boundedPrincipals));
  } catch {
    // Browser storage is an optional preference layer. Home remains usable with
    // the truthful open-by-default state when storage is unavailable.
  }
}

/**
 * Browser-local Home disclosure preference, partitioned by authenticated
 * account and user. A missing preference means open: new sections should reveal
 * themselves instead of inheriting a hard-coded closed list.
 */
export function useHomeSectionDisclosure(sectionKey: string) {
  const { user, principal } = useAuth();
  const principalKey = useMemo(() => {
    if (!user?.id || !principal?.accountId) return null;
    return `${principal.accountId}:${user.id}`;
  }, [principal?.accountId, user?.id]);
  const [open, setOpenState] = useState(() => readSectionPreference(principalKey, sectionKey));

  useEffect(() => {
    setOpenState(readSectionPreference(principalKey, sectionKey));
  }, [principalKey, sectionKey]);

  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    if (principalKey) persistSectionPreference(principalKey, sectionKey, next);
  }, [principalKey, sectionKey]);

  return { open, setOpen };
}
