import { AlertTriangle, AlertCircle } from "lucide-react";
import type { SystemNotice } from "@shared/models/chat";
import { formatDistanceToNow } from "date-fns";

interface SystemNoticeMessageProps {
  notice: SystemNotice;
  timestamp?: string;
}

const ERROR_TYPE_LABELS: Record<string, string> = {
  processing_stopped: "Processing stopped",
  response_interrupted: "Response interrupted",
  user_stopped: "Stopped",
  something_went_wrong: "Something went wrong",
  temporarily_busy: "Temporarily busy",
};

export function SystemNoticeMessage({ notice, timestamp }: SystemNoticeMessageProps) {
  const isError = notice.severity === "error";
  const Icon = isError ? AlertTriangle : AlertCircle;
  const label = ERROR_TYPE_LABELS[notice.errorType] || "Notice";

  // Warning-severity notices (user-stopped, yield) get a minimal treatment
  if (!isError) {
    return (
      <div className="w-full py-2 text-center" data-testid="system-notice-message">
        <p className="text-xs text-muted-foreground/60">
          {notice.description}{" "}
          <span className="text-muted-foreground/40">{notice.actionHint}</span>
        </p>
      </div>
    );
  }

  return (
    <div
      className="w-full rounded-md border-l-2 border-destructive bg-destructive/5 p-3"
      data-testid="system-notice-message"
    >
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
        <div className="flex flex-1 flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-destructive">
              {label}
            </span>
            {timestamp && (
              <span className="text-2xs text-muted-foreground/50">
                {formatDistanceToNow(new Date(timestamp), { addSuffix: true })}
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground">{notice.description}</p>
          <p className="text-xs text-muted-foreground/70">{notice.actionHint}</p>
        </div>
      </div>
    </div>
  );
}

/** Safely parse a system_notice message content string into a SystemNotice object */
export function parseSystemNotice(content: string): SystemNotice | null {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed.severity === "string" && typeof parsed.description === "string") {
      return parsed as SystemNotice;
    }
    return null;
  } catch {
    return null;
  }
}
