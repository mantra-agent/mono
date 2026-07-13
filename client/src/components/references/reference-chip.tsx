import { useCallback } from "react";
import { useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { useReferenceLabel } from "@/hooks/use-reference-label";
import { useTaskModal } from "@/contexts/task-modal-context";
import { useSidebar } from "@/components/ui/sidebar";
import type { ClientResolvedReference } from "./reference-registry";

export function ReferenceChip({ resolved, className }: { resolved: ClientResolvedReference; className?: string }) {
  const [, navigate] = useLocation();
  const { openTaskModal } = useTaskModal();
  const { closeSidebar } = useSidebar();
  const isDegraded = resolved.status !== "resolved";
  const label = useReferenceLabel(resolved.ref.type, resolved.ref.id, resolved.label);

  const isExternal =
    resolved.href?.startsWith("http://") || resolved.href?.startsWith("https://");

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      closeSidebar();

      // Task references open in the modal instead of navigating
      if (resolved.ref.type === "task") {
        e.preventDefault();
        const taskId = Number(resolved.ref.id);
        if (Number.isFinite(taskId)) openTaskModal(taskId);
        return;
      }
      if (!isExternal && resolved.href) {
        e.preventDefault();
        navigate(resolved.href);
      }
    },
    [closeSidebar, isExternal, resolved.href, navigate, resolved.ref.type, resolved.ref.id, openTaskModal],
  );

  const Icon = resolved.Icon;

  const content = (
    <span
      className={cn(
        "mx-1 inline-flex max-w-full align-baseline items-center gap-1 whitespace-nowrap break-normal text-[1em] font-medium leading-[inherit] underline-offset-4 transition-colors",
        isDegraded
          ? "text-muted-foreground"
          : "text-cta hover:text-active",
        className,
      )}
      title={resolved.description || resolved.ref.canonical}
      data-testid={`reference-${resolved.ref.type}-${resolved.ref.id}`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 no-underline" aria-hidden="true" strokeWidth={2} />
      <span className="min-w-0 truncate border-b border-current leading-[inherit]">{label}</span>
    </span>
  );

  if (resolved.href && resolved.status === "resolved") {
    return (
      <a
        href={resolved.href}
        className="inline-flex max-w-full align-baseline no-underline"
        onClick={handleClick}
        {...(isExternal ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      >
        {content}
      </a>
    );
  }

  return content;
}
