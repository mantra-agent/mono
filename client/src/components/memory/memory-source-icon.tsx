import {
  Activity,
  AlertCircle,
  CircleDot,
  Database,
  FileText,
  FolderOpen,
  Globe,
  Lightbulb,
  MessageSquare,
  Mic,
  Pencil,
  Sparkles,
  Target,
  User,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";

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
    case "workspace":
    case "file":
      return FolderOpen;
    case "library":
    case "page":
      return FileText;
    case "goal":
      return Target;
    case "person":
      return User;
    case "project":
      return Database;
    case "issue":
      return AlertCircle;
    case "web":
      return Globe;
    case "belief":
      return Sparkles;
    case "tool":
      return Wrench;
    case "cause":
      return Zap;
    case "action":
      return Activity;
    case "state":
      return CircleDot;
    default:
      return FileText;
  }
}

export function MemorySourceIcon({ source, className }: { source: string; className?: string }) {
  const Icon = getMemorySourceIcon(source);
  return <Icon className={className} />;
}
