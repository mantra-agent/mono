import { useState, type ReactNode } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { HIERARCHY_SECTION_HEADER_CLASS } from "@/components/hierarchy-section-header";

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
      <div className={cn("group", HIERARCHY_SECTION_HEADER_CLASS, "hover-elevate")}>
        <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
          <span className="min-w-0 flex-1 text-left uppercase">{title}</span>
          {count !== undefined && <span className="ml-auto text-[10px] font-normal normal-case text-muted-foreground/70">{count}</span>}
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
