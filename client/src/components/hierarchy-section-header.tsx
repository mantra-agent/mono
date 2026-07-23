import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Canonical Hierarchy Tree section-label typography, shared with the Session
 * menu. Interactive section triggers compose this class with their own hover
 * and disclosure behavior; static labels use HierarchySectionHeader directly.
 */
export const HIERARCHY_SECTION_HEADER_CLASS =
  "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground";

/**
 * Canonical Session-menu row base typography (the clickable session-title
 * rows). Shared so any surface that wants the same row style — like the Context
 * prompt viewer — matches by construction. State-specific classes (active
 * background, status color, hover) are composed on top by the consumer.
 */
export const HIERARCHY_SESSION_ROW_CLASS =
  "group relative flex items-center gap-2 rounded-md px-2 py-1.5 text-sm w-full text-left cursor-pointer select-none transition-colors overflow-hidden";

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
