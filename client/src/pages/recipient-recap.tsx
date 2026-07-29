import { useEffect } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type { RecipientRecapProjectionResponse } from "@shared/meeting-recipient-recap";
import { getQueryFn } from "@/lib/queryClient";

interface RecipientRecapPageProps {
  token: string;
}

/**
 * Authenticated recap-link claim step. A matching account holder who clicks a
 * recap link lands here; the server materializes their recipient-owned Meeting
 * and returns its session id, and we deep-link into the in-app Meetings surface
 * with that meeting expanded. Non-account and provisional recipients never reach
 * this route — the /r/:token entry switch routes them to the landing/visualizer
 * fork before any authenticated claim.
 */
export default function RecipientRecapPage({ token }: RecipientRecapPageProps) {
  const [, setLocation] = useLocation();
  const endpoint = `/api/meeting-recaps/onboarding/${encodeURIComponent(token)}`;
  const query = useQuery<RecipientRecapProjectionResponse>({
    queryKey: [endpoint],
    queryFn: getQueryFn({ on401: "throw" }),
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const meetingSessionId = query.data?.meetingSessionId;
  useEffect(() => {
    if (!meetingSessionId) return;
    setLocation(`/meetings?meeting=${encodeURIComponent(meetingSessionId)}`, { replace: true });
  }, [meetingSessionId, setLocation]);

  if (query.isError) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-6">
        <p className="text-sm text-muted-foreground">This recap is unavailable.</p>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
      <Loader2 className="h-5 w-5 animate-spin" aria-label="Opening recap" />
    </main>
  );
}
