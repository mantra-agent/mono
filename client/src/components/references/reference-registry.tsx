import {
  Briefcase,
  Brain,
  Bug,
  Building2,
  CalendarDays,
  Compass,
  ListTodo,
  Diamond,
  FileText,
  Flag,
  FolderKanban,
  GitPullRequest,
  Globe,
  Gauge,
  Hammer,
  Heart,
  Link2,
  Mail,
  MailOpen,
  MessageSquare,
  MessagesSquare,
  MessageCircle,
  FileJson2,
  PenLine,
  Radio,
  Sparkles,
  Server,
  Layers3,
  Rss,
  Paperclip,
  Route,
  Scale,
  Workflow,
  Target,
  Tags,
  Timer,
  User,
  Users,
  Bot,
  type LucideIcon,
} from "lucide-react";
import { REFERENCE_REGISTRY, isKnownReferenceType, type ReferenceRef, type ResolvedReference } from "@shared/references";

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

function humanizeSlug(value: string): string {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
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
  company: {
    Icon: Building2,
    fallbackLabel: ref => metadataString(ref, "label") || ref.id,
    href: ref => metadataString(ref, "href") || `/companies/${encodeURIComponent(ref.id)}`,
  },
  person: {
    Icon: User,
    fallbackLabel: ref => metadataString(ref, "label") || ref.id,
    href: ref => metadataString(ref, "href") || `/people/${encodeURIComponent(ref.id)}`,
  },
  tag: {
    Icon: Tags,
    fallbackLabel: ref => metadataString(ref, "label") || humanizeSlug(ref.id),
    href: ref => metadataString(ref, "href") || `/tags/${encodeURIComponent(ref.id)}`,
  },
  interaction: {
    Icon: MessageCircle,
    fallbackLabel: ref => metadataString(ref, "label") || `Interaction ${ref.id.split("~").pop() || ref.id}`,
    href: ref => {
      const explicit = metadataString(ref, "href");
      if (explicit) return explicit;
      const [personId, interactionId] = ref.id.split("~").map(decodeURIComponent);
      return personId && interactionId
        ? `/people/${encodeURIComponent(personId)}?interaction=${encodeURIComponent(interactionId)}`
        : undefined;
    },
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
    href: ref => metadataString(ref, "href") || `/projects?project=${encodeURIComponent(ref.id)}`,
  },
  milestone: {
    Icon: Diamond,
    fallbackLabel: ref => metadataString(ref, "label") || `Milestone ${ref.id}`,
    href: ref => metadataString(ref, "href") || `/projects`,
  },
  role: {
    Icon: Briefcase,
    fallbackLabel: ref => metadataString(ref, "label") || `Role ${ref.id}`,
    href: ref => metadataString(ref, "href") || `/business/roles?role=${encodeURIComponent(ref.id)}`,
  },

  decision: {
    Icon: Scale,
    fallbackLabel: ref => metadataString(ref, "label") || ref.id,
    href: ref => metadataString(ref, "href") || `/decisions?decision=${encodeURIComponent(ref.id)}`,
  },
  timer: {
    Icon: Timer,
    fallbackLabel: ref => metadataString(ref, "label") || `Timer ${ref.id}`,
    href: ref => metadataString(ref, "href") || `/timers?timer=${encodeURIComponent(ref.id)}`,
  },
  business_plan: {
    Icon: FileJson2,
    // Resolver owns "Business Plan {vaultName}"; static fallback must not paint the hex.
    fallbackLabel: ref => metadataString(ref, "label") || "Business Plan",
    href: ref => metadataString(ref, "href") || REFERENCE_REGISTRY.business_plan.route?.(ref.id),
  },
  kpi: {
    Icon: Gauge,
    fallbackLabel: ref => metadataString(ref, "label") || `KPI ${ref.id}`,
    href: ref => metadataString(ref, "href") || `/tools/kpis?kpi=${encodeURIComponent(ref.id)}`,
  },
  metric: {
    Icon: Gauge,
    fallbackLabel: ref => metadataString(ref, "label") || `Metric ${ref.id}`,
    href: ref => metadataString(ref, "href") || `/tools/metrics?metric=${encodeURIComponent(ref.id)}`,
  },
  wellness_activity: {
    Icon: Heart,
    fallbackLabel: ref => metadataString(ref, "label") || ref.id,
    href: ref => metadataString(ref, "href") || `/habits?activity=${encodeURIComponent(ref.id)}`,
  },
  health_activity: {
    Icon: Heart,
    fallbackLabel: ref => metadataString(ref, "label") || ref.id,
    href: ref => metadataString(ref, "href") || `/habits?activity=${encodeURIComponent(ref.id)}`,
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
  inference_context: {
    Icon: FileJson2,
    fallbackLabel: ref => metadataString(ref, "label") || `Context ${ref.id}`,
    href: ref => metadataString(ref, "href") || `/brain?tab=context&capture=${encodeURIComponent(ref.id)}`,
  },
  plan: {
    Icon: Route,
    fallbackLabel: ref => metadataString(ref, "label") || `Plan ${ref.id}`,
    href: ref => metadataString(ref, "href") || `/plans/${encodeURIComponent(ref.id)}`,
  },
  workflow: {
    Icon: Workflow,
    fallbackLabel: ref => metadataString(ref, "label") || `Workflow ${ref.id}`,
  },
  principle: {
    Icon: Compass,
    fallbackLabel: ref => metadataString(ref, "label") || `Principle ${ref.id}`,
    href: ref => metadataString(ref, "href") || "/orientation",
  },
  strategy: {
    Icon: Route,
    fallbackLabel: ref => metadataString(ref, "label") || `Strategy ${ref.id}`,
    href: ref => metadataString(ref, "href") || `/strategy/${encodeURIComponent(ref.id)}`,
  },
  opportunity: {
    Icon: Sparkles,
    fallbackLabel: ref => metadataString(ref, "label") || `Opportunity ${ref.id}`,
    href: ref => metadataString(ref, "href") || `/exec?opportunity=${encodeURIComponent(ref.id)}`,
  },
  platform: {
    Icon: Server,
    fallbackLabel: ref => metadataString(ref, "label") || `Platform ${ref.id}`,
    href: ref => metadataString(ref, "href") || `/platforms/${encodeURIComponent(ref.id)}`,
  },
  feature: {
    Icon: Hammer,
    fallbackLabel: ref => metadataString(ref, "label") || `Feature ${ref.id}`,
    href: ref => metadataString(ref, "href") || `/build/features/${encodeURIComponent(ref.id)}`,
  },
  product: {
    Icon: Layers3,
    fallbackLabel: ref => metadataString(ref, "label") || `Product ${ref.id}`,
    href: ref => metadataString(ref, "href") || `/platform-products/${encodeURIComponent(ref.id)}`,
  },
  environment: {
    Icon: Globe,
    fallbackLabel: ref => metadataString(ref, "label") || `Environment ${ref.id}`,
    href: ref => metadataString(ref, "href") || `/platform-environments/${encodeURIComponent(ref.id)}`,
  },
  build: {
    Icon: Hammer,
    fallbackLabel: ref => metadataString(ref, "label") || `Build ${ref.id}`,
    href: ref => metadataString(ref, "href") || "/build",
  },
  skill: {
    Icon: Sparkles,
    fallbackLabel: ref => metadataString(ref, "label") || `Skill ${ref.id}`,
    href: ref => metadataString(ref, "href") || `/skills/${encodeURIComponent(ref.id)}`,
  },
  claim: {
    Icon: Brain,
    fallbackLabel: ref => metadataString(ref, "label") || `Claim ${ref.id}`,
    href: ref => metadataString(ref, "href") || `/memory?claim=${encodeURIComponent(ref.id)}`,
  },

  file: {
    Icon: Paperclip,
    fallbackLabel: ref => metadataString(ref, "label") || ref.id.split("/").pop() || ref.id,
    // Shared REFERENCE_REGISTRY owns the route; never drop Drive ids.
    href: ref => metadataString(ref, "href") || REFERENCE_REGISTRY.file.route?.(ref.id),
  },

  email_thread: {
    Icon: Mail,
    fallbackLabel: ref => metadataString(ref, "label") || `Email thread ${ref.id.split(":").pop() || ref.id}`,
    href: ref => metadataString(ref, "href") || "/comms",
  },
  email_message: {
    Icon: MailOpen,
    fallbackLabel: ref => metadataString(ref, "label") || `Email message ${ref.id}`,
    href: ref => metadataString(ref, "href") || "/comms",
  },

  email_draft: {
    Icon: PenLine,
    fallbackLabel: ref => metadataString(ref, "label") || `Draft ${ref.id}`,
    href: ref => metadataString(ref, "href") || `/email`,
  },
  meeting_draft: {
    Icon: CalendarDays,
    fallbackLabel: ref => metadataString(ref, "label") || `Meeting draft ${ref.id}`,
    href: ref => metadataString(ref, "href") || `/`,
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
  issue: {
    Icon: Bug,
    fallbackLabel: ref => metadataString(ref, "label") || `Issue ${ref.id}`,
    href: ref => metadataString(ref, "href") || `/issues/${encodeURIComponent(ref.id)}`,
  },
  account: {
    Icon: Building2,
    fallbackLabel: ref => metadataString(ref, "label") || `Account ${ref.id.slice(0, 8)}`,
    href: ref => metadataString(ref, "href") || `/system?tab=accounts&account=${encodeURIComponent(ref.id)}`,
  },
  user: {
    Icon: Users,
    fallbackLabel: ref => metadataString(ref, "label") || `User ${ref.id.slice(0, 8)}`,
    href: ref => metadataString(ref, "href") || `/system?tab=users&user=${encodeURIComponent(ref.id)}`,
  },
  agent_instance: {
    Icon: Bot,
    fallbackLabel: ref => metadataString(ref, "label") || `Agent ${ref.id.slice(0, 8)}`,
    href: ref => metadataString(ref, "href") || `/system?tab=agents&agent=${encodeURIComponent(ref.id)}`,
  },
  router: {
    Icon: Route,
    fallbackLabel: ref => metadataString(ref, "label") || `Router ${ref.id.slice(0, 8)}`,
    href: ref => metadataString(ref, "href") || `/system?tab=routers&router=${encodeURIComponent(ref.id)}`,
  },
};

export function resolveReference(ref: ReferenceRef): ClientResolvedReference {
  const entry = registry[ref.type];
  if (entry) {
    return {
      ref,
      status: "resolved",
      label: entry.fallbackLabel(ref),
      href: entry.href?.(ref),
      Icon: entry.Icon,
    };
  }

  if (isKnownReferenceType(ref.type)) {
    const sharedDefinition = REFERENCE_REGISTRY[ref.type];
    return {
      ref,
      status: "resolved",
      label: metadataString(ref, "label") || humanizeSlug(ref.type),
      href: metadataString(ref, "href") || sharedDefinition.route?.(ref.id),
      Icon: Link2,
    };
  }

  return {
    ref,
    status: "missing",
    label: ref.canonical,
    Icon: Link2,
    description: `Unknown reference type: ${ref.type}`,
  };
}
