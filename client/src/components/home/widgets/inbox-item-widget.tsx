import {
  AlertCircle,
  AlertTriangle,
  Inbox,
  MailOpen,
  MessageCircleQuestion,
} from "lucide-react";
import type { SimpleFeedItem } from "@shared/models/simple";
import { cn } from "@/lib/utils";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import { simpleItemReferenceRefs } from "@shared/simple-references";

function stringPayload(item: SimpleFeedItem, key: string): string | null {
  const value = item.payload?.[key];
  return typeof value === "string" ? value : null;
}

function sessionReviewTone(reviewKind: string | null): {
  Icon: typeof AlertTriangle;
  className: string;
} {
  switch (reviewKind) {
    // Error = red circle; Warning = amber triangle.
    case "error":
      return { Icon: AlertCircle, className: "text-destructive" };
    case "warning":
      return { Icon: AlertTriangle, className: "text-warning" };
    case "question":
      return { Icon: MessageCircleQuestion, className: "text-active" };
    case "approval":
      return { Icon: MailOpen, className: "text-foreground" };
    default:
      return { Icon: Inbox, className: "text-muted-foreground" };
  }
}

/** "{User} reported {Issue}" */
function ReportedIssueInline({ item }: { item: SimpleFeedItem }) {
  const refs = simpleItemReferenceRefs(item);
  const userRef = refs.find((ref) => ref.type === "user") ?? null;
  const issueRef = refs.find((ref) => ref.type === "issue") ?? null;
  const completed = item.status === "completed";

  return (
    <div
      className={cn(
        "mx-1 flex min-w-0 items-center gap-1.5",
        completed && "opacity-70",
      )}
      data-testid={`reported-issue-inbox-${item.id}`}
    >
      {userRef ? (
        <ReferenceRenderer
          refValue={userRef}
          surface="simple-row"
          className={cn("mx-0 max-w-[min(100%,10rem)]", completed && "text-neutral hover:text-neutral")}
        />
      ) : (
        <span className="truncate text-xs font-medium">{stringPayload(item, "reporterLabel") ?? "User"}</span>
      )}
      <span className="shrink-0 text-xs text-muted-foreground">reported</span>
      {issueRef ? (
        <ReferenceRenderer
          refValue={issueRef}
          surface="simple-row"
          className={cn("mx-0 max-w-[min(100%,14rem)]", completed && "text-neutral hover:text-neutral")}
        />
      ) : (
        <span className="truncate text-xs font-medium">{stringPayload(item, "issueTitle") ?? item.title}</span>
      )}
    </div>
  );
}

/** "{Session} had an Error" / "has a Question" / "needs an Approval" */
function SessionReviewInline({ item }: { item: SimpleFeedItem }) {
  const reviewKind = stringPayload(item, "reviewKind");
  const phrase = stringPayload(item, "phrase") ?? "needs";
  const label = stringPayload(item, "reviewLabel") ?? "Review";
  const sessionRef =
    simpleItemReferenceRefs(item).find((ref) => ref.type === "session") ??
    simpleItemReferenceRefs(item)[0] ??
    null;
  const { Icon, className } = sessionReviewTone(reviewKind);
  const completed = item.status === "completed";
  const sessionTitle = (stringPayload(item, "sessionTitle") ?? item.title)
    .replace(/\s+/g, " ")
    .trim();

  return (
    <div
      className={cn(
        "mx-1 flex min-w-0 items-center gap-1",
        completed && "opacity-70",
      )}
      data-testid={`session-review-inbox-${item.id}`}
    >
      <span className="min-w-0 max-w-[9rem] shrink">
        {sessionRef ? (
          <ReferenceRenderer
            refValue={sessionRef}
            surface="simple-row"
            className={cn(
              "mx-0 max-w-full",
              completed && "text-neutral hover:text-neutral",
            )}
          />
        ) : (
          <span className="block truncate text-xs font-medium">{sessionTitle}</span>
        )}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">{phrase}</span>
      <span className={cn("inline-flex shrink-0 items-center gap-1 text-xs font-medium", className)}>
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        {label}
      </span>
    </div>
  );
}

/** Inline mode: renders content for use inside SimpleTreeRow */
function InboxItemInline({ item }: { item: SimpleFeedItem }) {
  const kind = stringPayload(item, "kind");
  if (kind === "session_review") {
    return <SessionReviewInline item={item} />;
  }
  if (kind === "reported_issue") {
    return <ReportedIssueInline item={item} />;
  }

  const href = item.actions?.find(a => a.type === "navigate")?.href;
  const completed = item.status === "completed";
  const showKind = kind && kind !== "email_review";

  const inner = completed ? (
    <div className="mx-1 flex min-w-0 items-center gap-1">
      <Inbox className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate border-b border-current text-xs font-medium text-neutral transition-all duration-200">
        {item.title}
      </span>
    </div>
  ) : (
    <div className="flex items-center gap-2">
      <Inbox className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate text-sm font-medium">{item.title}</span>
      {showKind && <span className="shrink-0 text-xs text-muted-foreground capitalize">{kind.replace(/_/g, " ")}</span>}
    </div>
  );

  if (href) return <a href={href} className="min-w-0 flex-1">{inner}</a>;
  return inner;
}

export function InboxItemWidget({ item, inline }: { item: SimpleFeedItem; inline?: boolean }) {
  if (inline) return <InboxItemInline item={item} />;

  const kind = stringPayload(item, "kind");
  if (kind === "session_review") {
    return (
      <div className="flex min-h-10 items-center rounded-lg px-3 py-2.5 transition-colors hover:bg-accent/50">
        <SessionReviewInline item={item} />
      </div>
    );
  }
  if (kind === "reported_issue") {
    return (
      <div className="flex min-h-10 items-center rounded-lg px-3 py-2.5 transition-colors hover:bg-accent/50">
        <ReportedIssueInline item={item} />
      </div>
    );
  }

  const href = item.actions?.find(a => a.type === "navigate")?.href;

  const content = (
    <div className="flex min-h-10 items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-accent/50">
      <Inbox className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <span className="truncate text-sm font-medium">{item.title}</span>
        {kind && <div className="mt-0.5 text-xs text-muted-foreground capitalize">{kind.replace(/_/g, " ")}</div>}
      </div>
    </div>
  );

  if (href) return <a href={href} className={cn("group")}>{content}</a>;
  return content;
}
