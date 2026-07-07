import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  message: string;
  action?: ReactNode;
  testId?: string;
}

export function EmptyState({ icon: Icon, title, message, action, testId }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center" data-testid={testId}>
      <Icon className="h-6 w-6 text-muted-foreground mb-4" />
      <h3 className="text-lg font-medium text-foreground mb-1">{title}</h3>
      <p className="text-sm text-muted-foreground max-w-sm">{message}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
