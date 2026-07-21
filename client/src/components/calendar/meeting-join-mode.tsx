import { Bot, Ear, Loader2, Mic2, UserRoundX } from "lucide-react";
import type { MeetingJoinMode } from "@shared/schema";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export const MEETING_JOIN_MODE_OPTIONS: Array<{
  value: MeetingJoinMode;
  label: string;
  shortLabel: string;
  icon: typeof Bot;
}> = [
  { value: "dont_join", label: "Don't Join", shortLabel: "Don't Join", icon: UserRoundX },
  { value: "note_taking", label: "Note Taking Mode (Listen Only by Default)", shortLabel: "Note Taking", icon: Ear },
  { value: "join_and_talk", label: "Join and Talk", shortLabel: "Join and Talk", icon: Mic2 },
];

export function meetingJoinModeLabel(mode: MeetingJoinMode): string {
  return MEETING_JOIN_MODE_OPTIONS.find(option => option.value === mode)?.label ?? "Don't Join";
}

export function MeetingJoinModeMenu({
  value,
  onChange,
  disabled = false,
  compact = false,
  testId = "meeting-join-mode",
}: {
  value: MeetingJoinMode;
  onChange: (value: MeetingJoinMode) => void;
  disabled?: boolean;
  compact?: boolean;
  testId?: string;
}) {
  const selected = MEETING_JOIN_MODE_OPTIONS.find(option => option.value === value) ?? MEETING_JOIN_MODE_OPTIONS[0];
  const SelectedIcon = selected.icon;

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          className={cn(
            "justify-start text-muted-foreground hover:text-foreground",
            compact ? "h-7 w-7 p-0" : "h-8 min-w-0 px-2",
          )}
          aria-label={`Meeting agent: ${selected.label}`}
          data-testid={`${testId}-trigger`}
        >
          {disabled ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <SelectedIcon className="h-3.5 w-3.5" />}
          {!compact && <span className="truncate">{selected.shortLabel}</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[190px]" onCloseAutoFocus={event => event.preventDefault()}>
        {MEETING_JOIN_MODE_OPTIONS.map(option => {
          const Icon = option.icon;
          return (
            <DropdownMenuItem
              key={option.value}
              onSelect={() => onChange(option.value)}
              className={cn(option.value === value && "bg-accent")}
              data-testid={`${testId}-${option.value}`}
            >
              <Icon className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
              {option.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
