import { useState, type ReactNode } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface ProfileDetailSectionProps {
  title: ReactNode;
  count?: number;
  defaultOpen?: boolean;
  children: ReactNode;
  collapsedContent?: ReactNode;
  testId?: string;
  headerAction?: ReactNode;
}

export function ProfileDetailSection({
  title,
  count,
  defaultOpen = false,
  children,
  collapsedContent,
  testId,
  headerAction,
}: ProfileDetailSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Collapsible open={open} onOpenChange={setOpen} data-testid={testId}>
      <div className="group flex w-full items-center gap-1.5 px-2 py-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground hover-elevate">
        <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
          <span className="min-w-0 flex-1 text-left">{title}</span>
          {count !== undefined && <span className="ml-auto text-[10px] font-normal text-muted-foreground/70">{count}</span>}
        </CollapsibleTrigger>
        {headerAction}
      </div>
      {!open && collapsedContent && <div className="px-2 pb-1">{collapsedContent}</div>}
      <CollapsibleContent>
        <div className="space-y-1 pt-1">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
