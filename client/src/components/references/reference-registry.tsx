import {
  CalendarDays,
  ListTodo,
  Diamond,
  FileText,
  Flag,
  FolderKanban,
  GitPullRequest,
  Globe,
  Heart,
  Link2,
  MessageSquare,
  MessagesSquare,
  PenLine,
  Radio,
  Rss,
  Paperclip,
  Scale,
  Target,
  User,
  type LucideIcon,
} from "lucide-react";
import type { ReferenceRef, ResolvedReference } from "@shared/references";

export type ClientResolvedReference = Omit<ResolvedReference, "icon"> & {
  Icon: LucideIcon;
};

type RegistryEntry = {
  Icon: LucideIcon;
  fallbackLabel: (ref: ReferenceRef) => string;
  href?: (ref: ReferenceRef) => string | undefined;
};

function metadataString(ref: ReferenceRef, key: string): string | undefined {
  const value = ref.metadata?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function priorityHref(ref: ReferenceRef): string {
  const period = ref.id.split(":", 1)[0];
  if (period === "weekly" || period === "next_week") return "/goals?tab=week";
  if (period === "monthly" || period === "next_month") return "/goals?tab=month";
  return "/goals?tab=today";
}

const registry: Record<string, RegistryEntry> = {
  page: {
    Icon: FileText,
    fallbackLabel: ref => metadataString(ref, "label") || ref.id,
    href: ref => metadataString(ref, "href") || `/info#library?page=${encodeURIComponent(ref.id)}`,
  },
  person: {
    Icon: User,
    fallbackLabel: ref => metadataString(ref, "label") || ref.id,
    href: ref => metadataString(ref, "href") || `/people?person=${encodeURIComponent(ref.id)}`,
  },
  goal: {
    Icon: Target,
    fallbackLabel: ref => metadataString(ref, "label") || ref.id,
    href: ref => metadataString(ref, "href") || `/goals?goal=${encodeURIComponent(ref.id)}`,
  },
  task: {
    Icon: ListTodo,
    fallbackLabel: ref => metadataString(ref, "label") || `Task ${ref.id}`,
    href: ref => metadataString(ref, "href") || `/projects?task=${encodeURIComponent(ref.id)}`,
  },
  project: {
    Icon: FolderKanban,
    fallbackLabel: ref => metadataString(ref, "label") || `Project ${ref.id}`,
    href: ref => metadataString(ref, "href") || `/projects/${encodeURIComponent(ref.id)}`,
  },
  milestone: {
    Icon: Diamond,
    fallbackLabel: ref => metadataString(ref, "label") || `Milestone ${ref.id}`,
    href: ref => metadataString(ref, "href") || `/projects`,
  },

  decision: {
    Icon: Scale,
    fallbackLabel: ref => metadataString(ref, "label") || ref.id,
    href: ref => metadataString(ref, "href") || `/decisions?decision=${encodeURIComponent(ref.id)}`,
  },
  wellness_activity: {
    Icon: Heart,
    fallbackLabel: ref => metadataString(ref, "label") || ref.id,
    href: ref => metadataString(ref, "href") || `/wellness?tab=calendar&activity=${encodeURIComponent(ref.id)}`,
  },
  health_activity: {
    Icon: Heart,
    fallbackLabel: ref => metadataString(ref, "label") || ref.id,
    href: ref => metadataString(ref, "href") || `/wellness?tab=calendar&activity=${encodeURIComponent(ref.id)}`,
  },
  meeting: {
    Icon: CalendarDays,
    fallbackLabel: ref => metadataString(ref, "label") || `Event ${ref.id}`,
    href: ref => {
      const explicit = metadataString(ref, "href");
      if (explicit) return explicit;
      const [accountId, calendarId, eventId] = ref.id.split("~").map(decodeURIComponent);
      if (accountId && calendarId && eventId) return `/schedule/${encodeURIComponent(eventId)}?calendarId=${encodeURIComponent(calendarId)}&accountId=${encodeURIComponent(accountId)}`;
      return `/schedule/${encodeURIComponent(ref.id)}`;
    },
  },
  priority: {
    Icon: Flag,
    fallbackLabel: ref => metadataString(ref, "label") || ref.id,
    href: ref => metadataString(ref, "href") || priorityHref(ref),
  },
  session: {
    Icon: MessagesSquare,
    fallbackLabel: ref => metadataString(ref, "label") || `Session ${ref.id}`,
    href: ref => metadataString(ref, "href") || `/session?c=${encodeURIComponent(ref.id)}`,
  },

  file: {
    Icon: Paperclip,
    fallbackLabel: ref => metadataString(ref, "label") || ref.id.split("/").pop() || ref.id,
    href: ref => metadataString(ref, "href") || (ref.id.startsWith("/objects/") ? ref.id : undefined),
  },

  email_draft: {
    Icon: PenLine,
    fallbackLabel: ref => metadataString(ref, "label") || `Draft ${ref.id}`,
    href: ref => metadataString(ref, "href") || `/email`,
  },

  news: {
    Icon: Globe,
    fallbackLabel: ref => metadataString(ref, "label") || "News",
    href: ref => metadataString(ref, "href") || ref.id,
  },
  web_article: {
    Icon: Globe,
    fallbackLabel: ref => metadataString(ref, "label") || "Web",
    href: ref => metadataString(ref, "href") || ref.id,
  },
  x_item: {
    Icon: Radio,
    fallbackLabel: ref => metadataString(ref, "label") || "X",
    href: ref => metadataString(ref, "href") || ref.id,
  },
  reddit_post: {
    Icon: MessageSquare,
    fallbackLabel: ref => metadataString(ref, "label") || "Reddit",
    href: ref => metadataString(ref, "href") || ref.id,
  },
  rss_item: {
    Icon: Rss,
    fallbackLabel: ref => metadataString(ref, "label") || "RSS",
    href: ref => metadataString(ref, "href") || ref.id,
  },
  pr: {
    Icon: GitPullRequest,
    fallbackLabel: ref => {
      const parts = ref.id.split("/");
      if (parts.length === 3) return `${parts[0]}/${parts[1]}#${parts[2]}`;
      if (parts.length === 2) return `${parts[0]}#${parts[1]}`;
      return `PR ${ref.id}`;
    },
    href: ref => {
      const parts = ref.id.split("/");
      if (parts.length === 3) return `https://github.com/${parts[0]}/${parts[1]}/pull/${parts[2]}`;
      return undefined;
    },
  },
};

export function resolveReference(ref: ReferenceRef): ClientResolvedReference {
  const entry = registry[ref.type];
  if (!entry) {
    return {
      ref,
      status: "missing",
      label: ref.canonical,
      Icon: Link2,
      description: `Unknown reference type: ${ref.type}`,
    };
  }

  return {
    ref,
    status: "resolved",
    label: entry.fallbackLabel(ref),
    href: entry.href?.(ref),
    Icon: entry.Icon,
  };
}
