import { useQuery } from "@tanstack/react-query";

interface TimezoneData {
  timezone: string;
  localTime: string;
}

export function useTimezone() {
  const { data } = useQuery<TimezoneData>({
    queryKey: ["/api/settings/timezone"],
    staleTime: 60000,
    refetchInterval: 300000,
  });

  const timezone = data?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

  return { timezone, localTime: data?.localTime || "", isLoaded: !!data };
}

export function formatTime(date: Date | string | number, timezone: string, options?: Intl.DateTimeFormatOptions): string {
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: timezone,
    ...options,
  });
}

export function formatDate(date: Date | string | number, timezone: string, options?: Intl.DateTimeFormatOptions): string {
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: timezone,
    ...options,
  });
}

export function formatDateTime(date: Date | string | number, timezone: string, options?: Intl.DateTimeFormatOptions): string {
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: timezone,
    ...options,
  });
}

export function formatDateOnly(dateStr: string | null | undefined, timezone: string, options?: Intl.DateTimeFormatOptions): string {
  if (!dateStr) return "";
  const normalized = dateStr.length === 10 ? `${dateStr}T12:00:00` : dateStr;
  const d = new Date(normalized);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: timezone,
    ...options,
  });
}

export function formatTimeAgo(iso: string, timezone: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
