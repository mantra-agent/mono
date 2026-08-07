import {
  Activity,
  AlertCircle,
  Building2,
  CircleDot,
  Database,
  FileText,
  FolderOpen,
  Globe,
  Lightbulb,
  MessageSquare,
  Mic,
  Pencil,
  Tag,
  Video,
  Target,
  User,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";

export interface MemoryGraphNodeTypeConfig {
  id: string;
  label: string;
  iconSource: string;
}

const MEMORY_GRAPH_NODE_TYPE_ORDER = [
  "people",
  "companies",
  "claims",
  "pages",
  "files",
  "sessions",
  "meetings",
  "goals",
  "projects",
  "tags",
];

/** Node types intentionally excluded from Layers + the Memory Graph surface. */
const EXCLUDED_MEMORY_GRAPH_NODE_TYPES = new Set([
  "workflows",
  "workflow",
  "workflow_gate",
  "workflow_gates",
  "tasks",
  "task",
  "prs",
  "pr",
  "plan_attempts",
  "plan_attempt",
  "plans",
  "plan",
  "interactions",
  "interaction",
]);

const MEMORY_GRAPH_NODE_TYPE_BY_SOURCE: Record<string, MemoryGraphNodeTypeConfig> = {
  person: { id: "people", label: "People", iconSource: "person" },
  company: { id: "companies", label: "Companies", iconSource: "company" },
  claim: { id: "claims", label: "Claims", iconSource: "claim" },
  state: { id: "claims", label: "Claims", iconSource: "claim" },
  cause: { id: "claims", label: "Claims", iconSource: "claim" },
  action: { id: "claims", label: "Claims", iconSource: "claim" },
  page: { id: "pages", label: "Pages", iconSource: "page" },
  library: { id: "pages", label: "Pages", iconSource: "page" },
  library_page: { id: "pages", label: "Pages", iconSource: "page" },
  file: { id: "files", label: "Files", iconSource: "file" },
  drive_file: { id: "files", label: "Files", iconSource: "file" },
  session: { id: "sessions", label: "Sessions", iconSource: "session" },
  meeting: { id: "meetings", label: "Meetings", iconSource: "meeting" },
  goal: { id: "goals", label: "Goals", iconSource: "goal" },
  project: { id: "projects", label: "Projects", iconSource: "project" },
  tag: { id: "tags", label: "Tags", iconSource: "tag" },
};

function humanizeNodeType(source: string): string {
  const singular = source
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
  if (!singular) return "Other";
  if (/[^aeiou]y$/i.test(singular)) return `${singular.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(singular)) return `${singular}es`;
  return `${singular}s`;
}

export function getMemoryGraphNodeTypeConfig(source: string): MemoryGraphNodeTypeConfig {
  const normalizedSource = source.trim().toLowerCase() || "other";
  return MEMORY_GRAPH_NODE_TYPE_BY_SOURCE[normalizedSource] ?? {
    id: normalizedSource,
    label: humanizeNodeType(normalizedSource),
    iconSource: normalizedSource,
  };
}

export function isExcludedMemoryGraphNodeType(sourceOrTypeId: string): boolean {
  const normalized = sourceOrTypeId.trim().toLowerCase();
  if (!normalized) return false;
  if (EXCLUDED_MEMORY_GRAPH_NODE_TYPES.has(normalized)) return true;
  const config = MEMORY_GRAPH_NODE_TYPE_BY_SOURCE[normalized];
  return Boolean(config && EXCLUDED_MEMORY_GRAPH_NODE_TYPES.has(config.id));
}

export function getAvailableMemoryGraphNodeTypes(sources: string[]): MemoryGraphNodeTypeConfig[] {
  const typeById = new Map<string, MemoryGraphNodeTypeConfig>();
  sources.forEach((source) => {
    if (isExcludedMemoryGraphNodeType(source)) return;
    const config = getMemoryGraphNodeTypeConfig(source);
    if (isExcludedMemoryGraphNodeType(config.id)) return;
    typeById.set(config.id, config);
  });
  return [...typeById.values()].sort((left, right) => {
    const leftOrder = MEMORY_GRAPH_NODE_TYPE_ORDER.indexOf(left.id);
    const rightOrder = MEMORY_GRAPH_NODE_TYPE_ORDER.indexOf(right.id);
    if (leftOrder !== -1 || rightOrder !== -1) {
      if (leftOrder === -1) return 1;
      if (rightOrder === -1) return -1;
      return leftOrder - rightOrder;
    }
    return left.label.localeCompare(right.label);
  });
}

export function getMemorySourceIcon(source: string): LucideIcon {
  switch (source) {
    case "chat":
    case "chat_journal":
    case "conversation":
    case "session":
      return MessageSquare;
    case "manual":
      return Pencil;
    case "voice":
      return Mic;
    case "insight":
    case "claim":
      return Lightbulb;
    case "library_page":
      return FileText;
    case "workspace":
    case "file":
      return FolderOpen;
    case "library":
    case "page":
      return FileText;
    case "meeting":
      return Video;
    case "goal":
      return Target;
    case "person":
      return User;
    case "company":
      return Building2;
    case "project":
      return Database;
    case "issue":
      return AlertCircle;
    case "web":
      return Globe;
    case "tool":
      return Wrench;
    case "cause":
      return Zap;
    case "action":
      return Activity;
    case "state":
      return CircleDot;
    case "tag":
      return Tag;
    default:
      return FileText;
  }
}

export function MemorySourceIcon({ source, className }: { source: string; className?: string }) {
  const Icon = getMemorySourceIcon(source);
  return <Icon className={className} />;
}
