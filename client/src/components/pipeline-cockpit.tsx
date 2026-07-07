import { useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  ChevronDown,
  Circle,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export type PipelineStatus =
  | "idle"
  | "ready"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "blocked";
export type PipelineStepStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped";

export interface PipelineAction {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  pending?: boolean;
  variant?: "default" | "outline" | "destructive" | "secondary" | "ghost";
  icon?: ReactNode;
  asChild?: boolean;
  href?: string | null;
  testId?: string;
  tooltip?: string;
}

export interface PipelineSummaryItem {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  testId?: string;
}

export interface PipelineStep {
  id: string;
  label: string;
  description?: ReactNode;
  status: PipelineStepStatus;
  meta?: ReactNode;
  icon?: LucideIcon;
  detail?: ReactNode;
  testId?: string;
}

export interface PipelineEvidenceItem {
  label: string;
  value: ReactNode;
  href?: string | null;
  testId?: string;
  tooltip?: string;
}

export interface PipelineEmptyState {
  icon?: LucideIcon;
  title: string;
  description: ReactNode;
  action?: ReactNode;
}

export interface PipelineCockpitProps {
  title: string;
  subtitle?: ReactNode;
  status: PipelineStatus;
  statusLabel?: string;
  statusDetail?: ReactNode;
  primaryAction?: PipelineAction;
  secondaryActions?: ReactNode;
  primaryActionPosition?: "left" | "right";
  summary?: PipelineSummaryItem[];
  steps?: PipelineStep[];
  evidence?: PipelineEvidenceItem[];
  details?: ReactNode;
  logs?: ReactNode;
  result?: ReactNode;
  emptyState?: PipelineEmptyState | null;
  className?: string;
  testId?: string;
}

const statusCopy: Record<PipelineStatus, string> = {
  idle: "Idle",
  ready: "Ready",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  blocked: "Blocked",
};

const statusClasses: Record<
  PipelineStatus,
  { icon: string; dot: string }
> = {
  idle: {
    icon: "text-muted-foreground",
    dot: "bg-muted-foreground",
  },
  ready: {
    icon: "text-info",
    dot: "bg-info",
  },
  running: {
    icon: "text-active",
    dot: "bg-active animate-pulse",
  },
  succeeded: {
    icon: "text-success",
    dot: "bg-success",
  },
  failed: {
    icon: "text-error",
    dot: "bg-error",
  },
  cancelled: {
    icon: "text-muted-foreground",
    dot: "bg-muted-foreground",
  },
  blocked: {
    icon: "text-error",
    dot: "bg-error",
  },
};

function StatusIcon({ status }: { status: PipelineStatus }) {
  if (status === "running")
    return (
      <Loader2
        className={cn("h-5 w-5 animate-spin", statusClasses[status].icon)}
      />
    );
  if (status === "failed" || status === "blocked")
    return (
      <AlertTriangle className={cn("h-5 w-5", statusClasses[status].icon)} />
    );
  if (status === "succeeded")
    return (
      <CheckCircle2 className={cn("h-5 w-5", statusClasses[status].icon)} />
    );
  if (status === "cancelled")
    return <Ban className={cn("h-5 w-5", statusClasses[status].icon)} />;
  return <Circle className={cn("h-5 w-5", statusClasses[status].icon)} />;
}

function StepIcon({ step }: { step: PipelineStep }) {
  const Icon = step.icon;
  if (step.status === "running")
    return <Loader2 className="h-5 w-5 animate-spin text-active" />;
  if (step.status === "succeeded")
    return <CheckCircle2 className="h-5 w-5 text-success" />;
  if (step.status === "failed")
    return <AlertTriangle className="h-5 w-5 text-error" />;
  if (step.status === "skipped")
    return <Ban className="h-5 w-5 text-muted-foreground" />;
  return Icon ? (
    <Icon className="h-5 w-5 text-muted-foreground" />
  ) : (
    <Circle className="h-5 w-5 text-muted-foreground/60" />
  );
}

function stepCardClasses(status: PipelineStepStatus) {
  switch (status) {
    case "running":
      return "border-active/40 bg-active/5";
    case "succeeded":
      return "border-success/30 bg-success/5";
    case "failed":
      return "border-error/40 bg-error/10";
    case "skipped":
      return "border-border bg-muted/20";
    default:
      return "border-border bg-card/70";
  }
}

function PipelineStepCard({ step }: { step: PipelineStep }) {
  const hasExpandedContent = Boolean(step.description || step.detail);
  const [open, setOpen] = useState(
    step.status === "running" || step.status === "failed",
  );

  return (
    <div
      className={cn(
        "min-w-0 overflow-hidden rounded-xl border transition-colors",
        stepCardClasses(step.status),
      )}
    >
      <button
        type="button"
        className="flex w-full items-center gap-3 p-3 text-left @md:p-4"
        onClick={() => hasExpandedContent && setOpen((current) => !current)}
        aria-expanded={hasExpandedContent ? open : undefined}
        disabled={!hasExpandedContent}
      >
        <span className="shrink-0">
          <StepIcon step={step} />
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block truncate text-sm font-medium",
              step.status === "pending" && "text-muted-foreground",
              step.status === "failed" && "text-error",
            )}
          >
            {step.label}
          </span>
          {step.meta ? (
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {step.meta}
            </span>
          ) : null}
        </span>
        {hasExpandedContent ? (
          <ChevronDown
            className={cn(
              "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
          />
        ) : null}
      </button>

      {hasExpandedContent && open ? (
        <div className="space-y-3 border-t border-border/50 p-3 pt-3 @md:p-4 @md:pt-3">
          {step.description ? (
            <div
              className={cn(
                "text-sm leading-relaxed",
                step.status === "failed" ? "text-error" : "text-muted-foreground",
              )}
            >
              {step.description}
            </div>
          ) : null}
          {step.detail ? <div className="min-w-0">{step.detail}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function PipelineActionButton({ action }: { action: PipelineAction }) {
  const icon = action.pending ? (
    <Loader2 className="h-3.5 w-3.5 animate-spin" />
  ) : (
    action.icon
  );

  if (action.href) {
    return (
      <Button
        asChild
        size="icon"
        variant={action.variant ?? "outline"}
        disabled={action.disabled}
        data-testid={action.testId}
        className="h-7 w-7"
        title={action.tooltip ?? action.label}
        aria-label={action.label}
      >
        <a href={action.href} target="_blank" rel="noopener noreferrer">
          {icon}
          <span className="sr-only">{action.label}</span>
        </a>
      </Button>
    );
  }

  return (
    <Button
      size="icon"
      variant={action.variant ?? "default"}
      onClick={action.onClick}
      disabled={action.disabled || action.pending}
      data-testid={action.testId}
      className="h-7 w-7"
      title={action.tooltip ?? action.label}
      aria-label={action.label}
    >
      {icon}
      <span className="sr-only">{action.label}</span>
    </Button>
  );
}

function PipelineEmpty({ emptyState }: { emptyState: PipelineEmptyState }) {
  const Icon = emptyState.icon ?? CheckCircle2;
  return (
    <div
      className="flex flex-col items-center justify-center rounded-xl border border-dashed bg-background/50 px-6 py-12 text-center"
      data-testid="pipeline-empty-state"
    >
      <Icon className="h-7 w-7 text-muted-foreground" />
      <h3 className="mt-4 text-base font-semibold">{emptyState.title}</h3>
      <div className="mt-2 max-w-md text-sm text-muted-foreground">
        {emptyState.description}
      </div>
      {emptyState.action ? (
        <div className="mt-4">{emptyState.action}</div>
      ) : null}
    </div>
  );
}

export function PipelineCockpit({
  title,
  subtitle,
  status,
  statusDetail,
  primaryAction,
  secondaryActions,
  primaryActionPosition = "left",
  summary = [],
  steps = [],
  emptyState,
  className,
  testId = "pipeline-cockpit",
}: PipelineCockpitProps) {
  const [open, setOpen] = useState(false);
  const hasExpandableContent = Boolean(emptyState || steps.length > 0 || summary.length > 0);

  return (
    <Card
      className={cn("overflow-hidden bg-muted/30", className)}
      data-testid={testId}
    >
      <CardHeader className="border-b bg-card/80 p-0">
        <div className="flex min-h-[60px] items-center justify-between gap-2 p-3 @md:p-4">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default"
            onClick={() => hasExpandableContent && setOpen((current) => !current)}
            aria-expanded={hasExpandableContent ? open : undefined}
            disabled={!hasExpandableContent}
          >
            <StatusIcon status={status} />
            <span className="min-w-0">
              <span className="block min-w-0">
                <CardTitle className="truncate text-sm font-semibold @md:text-base">
                  {title}
                </CardTitle>
                {subtitle ? (
                  <span className="mt-1 block text-sm text-muted-foreground">
                    {subtitle}
                  </span>
                ) : null}
              </span>
              {statusDetail ? (
                <span className="block text-xs text-muted-foreground">
                  {statusDetail}
                </span>
              ) : null}
            </span>
            {hasExpandableContent ? (
              <ChevronDown
                className={cn(
                  "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                  open && "rotate-180",
                )}
              />
            ) : null}
          </button>

          <div className="flex shrink-0 items-center gap-2">
            {primaryActionPosition === "left" && primaryAction ? (
              <PipelineActionButton action={primaryAction} />
            ) : null}
            {secondaryActions}
            {primaryActionPosition === "right" && primaryAction ? (
              <PipelineActionButton action={primaryAction} />
            ) : null}
          </div>
        </div>
      </CardHeader>

      {open ? (
        <CardContent className="flex flex-col gap-4 p-3 @md:p-4">
          {summary.length > 0 ? (
            <div
              className="grid gap-3 @md:grid-cols-3 @xl:grid-cols-4"
              data-testid="pipeline-summary-grid"
            >
              {summary.map((item) => (
                <div
                  key={item.label}
                  className="rounded-xl border bg-background/50 p-3"
                  data-testid={item.testId}
                >
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {item.label}
                  </div>
                  <div className="mt-1 min-w-0 text-sm font-medium text-foreground">
                    {item.value}
                  </div>
                  {item.detail ? (
                    <div className="mt-1 min-w-0 text-xs text-muted-foreground">
                      {item.detail}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          {emptyState ? <PipelineEmpty emptyState={emptyState} /> : null}

          {steps.length > 0 ? (
            <section data-testid="pipeline-steps">
              <ol className="grid gap-3 @lg:grid-cols-3">
                {steps.map((step) => (
                  <li
                    key={step.id}
                    data-testid={step.testId ?? `pipeline-step-${step.id}`}
                    data-status={step.status}
                  >
                    <PipelineStepCard step={step} />
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  );
}
