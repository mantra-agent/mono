import { useQuery } from "@tanstack/react-query";

// Single source of truth for calendar event metadata queries.
// Every consumer of ["/api/calendar/metadata", ...] must use this hook so the
// cached shape is identical everywhere. Divergent queryFns under the same key
// previously caused a render crash when the day view cached a raw response and
// the detail view read it as a transformed object.

export interface EventMetadataRecord {
  id: number;
  googleEventId: string;
  accountId: string;
  calendarId: string;
  eventType: string | null;
  capacityType: string | null;
  notes: string | null;
  agenda: string | null;
}

export interface LinkedPersonRef {
  id: string;
  name: string;
  profileSummary: string | null;
  lastInteractionContext: string | null;
}

export interface LinkedArtifactRef {
  id: number;
  metadataId: number;
  libraryPageId: string;
  title: string;
  artifactKind: string;
  slug: string;
  source: string | null;
  summary: string | null;
  oneLiner: string | null;
}

export interface EventMetadataQueryData {
  metadata: EventMetadataRecord | null;
  people: LinkedPersonRef[];
  artifacts: LinkedArtifactRef[];
}

const EMPTY_EVENT_METADATA: EventMetadataQueryData = {
  metadata: null,
  people: [],
  artifacts: [],
};

export function eventMetadataQueryKey(
  eventId: string,
  accountId: string | undefined,
  calendarId: string | undefined,
) {
  return ["/api/calendar/metadata", eventId, accountId, calendarId] as const;
}

export function useEventMetadata(
  eventId: string,
  accountId: string | undefined,
  calendarId: string | undefined,
  enabled = true,
) {
  return useQuery<EventMetadataQueryData>({
    queryKey: eventMetadataQueryKey(eventId, accountId, calendarId),
    queryFn: async () => {
      const res = await fetch(
        `/api/calendar/metadata/${encodeURIComponent(eventId)}?accountId=${encodeURIComponent(accountId || "")}&calendarId=${encodeURIComponent(calendarId || "")}`,
        { credentials: "include" },
      );
      if (res.status === 404) return EMPTY_EVENT_METADATA;
      if (!res.ok) throw new Error("Failed to fetch event metadata");
      const data = await res.json();
      return {
        metadata: data.metadata ?? null,
        people: data.people ?? [],
        artifacts: data.artifacts ?? [],
      };
    },
    enabled,
    retry: false,
  });
}
