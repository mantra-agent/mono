import { useQuery } from "@tanstack/react-query";
import { useTimezone } from "@/hooks/use-timezone";

interface ActivityStatusLite {
  id: number;
  name: string;
  doneForCurrentPeriod: boolean;
  inWindow: boolean;
}

interface GratitudeEntryLite {
  id: number;
  date: string;
  content: string;
}

interface LearningEntryLite {
  id: number;
  date: string;
  content: string;
}

function formatLocalDate(d: Date, timezone?: string): string {
  if (timezone) return d.toLocaleDateString("en-CA", { timeZone: timezone });
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function useWellnessAlerts() {
  const { timezone } = useTimezone();
  const today = formatLocalDate(new Date(), timezone);

  // Fetch activity status (includes inWindow computed by server)
  const { data: activities } = useQuery<ActivityStatusLite[]>({
    queryKey: ["/api/wellness/status"],
    refetchOnWindowFocus: true,
    refetchInterval: 60_000, // re-evaluate every 60s since window status changes with time
  });

  const { data: gratitude } = useQuery<GratitudeEntryLite[]>({
    queryKey: ["/api/wellness/gratitude"],
    queryFn: async () => {
      const res = await fetch("/api/wellness/gratitude?limit=30", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load gratitude");
      return res.json();
    },
    staleTime: 30_000,
  });

  const { data: learning } = useQuery<LearningEntryLite[]>({
    queryKey: ["/api/wellness/learning"],
    queryFn: async () => {
      const res = await fetch("/api/wellness/learning?limit=30", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load learning");
      return res.json();
    },
    staleTime: 30_000,
  });

  // An activity needs logging only if it's due AND currently in its window
  const needsLog = (activities ?? []).some(
    (a) => !a.doneForCurrentPeriod && a.inWindow,
  );

  // Gratitude/Learning: check both entry existence AND activity window
  const gratitudeToday = (gratitude ?? []).some((g) => g.date === today);
  const gratitudeActivity = (activities ?? []).find(
    (a) => a.name.toLowerCase() === "gratitude",
  );
  const needsGratitude =
    !gratitudeToday &&
    (gratitudeActivity ? gratitudeActivity.inWindow : true);

  const learningToday = (learning ?? []).some((l) => l.date === today);
  const learningActivity = (activities ?? []).find(
    (a) => a.name.toLowerCase() === "learning",
  );
  const needsLearning =
    !learningToday &&
    (learningActivity ? learningActivity.inWindow : true);

  return {
    needsLog,
    needsGratitude,
    needsLearning,
    needsAttention: needsLog || needsGratitude || needsLearning,
  };
}
