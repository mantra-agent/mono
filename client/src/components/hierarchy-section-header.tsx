import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Canonical Hierarchy Tree section-label typography, shared with the Session
 * menu. Interactive section triggers compose this class with their own hover
 * and disclosure behavior; static labels use HierarchySectionHeader directly.
 */
export const HIERARCHY_SECTION_HEADER_CLASS =
  "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground";

interface HierarchySectionHeaderProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function HierarchySectionHeader({
  children,
  className,
  ...props
}: HierarchySectionHeaderProps) {
  return (
    <div className={cn(HIERARCHY_SECTION_HEADER_CLASS, className)} {...props}>
      {children}
    </div>
  );
}
