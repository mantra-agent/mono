import type { ReactNode } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Calendar,
  Gift,
  HandHeart,
  Mail,
  MessageSquare,
  Phone,
  UserPlus,
  Users,
  Video,
  type LucideIcon,
} from "lucide-react";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { cn } from "@/lib/utils";

export interface PersonInteraction {
  id: string;
  date: string;
  type: string;
  summary: string;
  context?: string;
  direction?: "inbound" | "outbound" | "mutual";
  meaningfulness?: "low" | "medium" | "high";
  responseOwed?: boolean;
  responseDueBy?: string;
  capitalImpact?: "deposit" | "withdrawal" | "neutral";
  tags?: string[];
}

interface ExpandableInteractionRowProps {
  interaction: PersonInteraction;
  personName?: string;
  menuContent?: ReactNode;
  className?: string;
  testId?: string;
}

const icons: Record<string, LucideIcon> = {
  call: Phone,
  meeting: Users,
  in_person: Users,
  video: Video,
  email: Mail,
  text: MessageSquare,
  message: MessageSquare,
  note: MessageSquare,
  social: MessageSquare,
  gift: Gift,
  introduction: UserPlus,
  favor: HandHeart,
  support: HandHeart,
};

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-US", { month: "numeric", day: "2-digit" });
}

function formatShortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function ExpandableInteractionRow({ interaction, personName, menuContent, className, testId }: ExpandableInteractionRowProps) {
  const Icon = icons[interaction.type] || Calendar;
  const DirectionIcon = interaction.direction === "inbound"
    ? ArrowDownLeft
    : interaction.direction === "outbound"
      ? ArrowUpRight
      : null;
  const hasMetadata = (interaction.capitalImpact && interaction.capitalImpact !== "neutral")
    || interaction.responseOwed
    || interaction.responseDueBy
    || interaction.tags?.length;

  return (
    <ProfileTreeRow
      label={<span>{formatDate(interaction.date)}</span>}
      icon={<Icon className="h-3.5 w-3.5 text-muted-foreground" />}
      hasValue
      showEmpty
      className={className}
      expandedContent={(
        <div className="max-h-80 max-w-none overflow-auto rounded-xl rounded-bl-sm border border-primary/20 bg-card/70 px-3 py-2 text-sm leading-tight text-white scrollbar-thin">
          {personName && <p className="mb-2 text-xs text-muted-foreground">{personName}</p>}
          <p className="whitespace-pre-wrap text-sm leading-tight text-white" data-testid={testId ? `${testId}-summary` : undefined}>{interaction.summary}</p>
          {interaction.context && <p className="mt-2 whitespace-pre-wrap text-sm leading-tight text-white">{interaction.context}</p>}
          {hasMetadata ? (
            <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
              {interaction.capitalImpact && interaction.capitalImpact !== "neutral" && <span>{interaction.capitalImpact}</span>}
              {interaction.responseOwed && <span className="text-foreground">follow-up</span>}
              {interaction.responseDueBy && <span>due {formatShortDate(interaction.responseDueBy)}</span>}
              {interaction.tags?.map(tag => <span key={tag}>{tag}</span>)}
            </div>
          ) : null}
        </div>
      )}
      expandedContentClassName="px-2 pb-2 pl-2"
      menuContent={menuContent}
      testId={testId || `interaction-${interaction.id}`}
    >
      <div className="flex min-w-0 items-center justify-end gap-1.5">
        <span className={cn("truncate text-xs", interaction.responseOwed ? "text-foreground" : "text-muted-foreground")}>{interaction.summary}</span>
        {DirectionIcon && <DirectionIcon className="h-3 w-3 shrink-0 text-muted-foreground" aria-label={interaction.direction} />}
      </div>
    </ProfileTreeRow>
  );
}
