import { useCallback } from "react";
import { useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { useReferenceLabel } from "@/hooks/use-reference-label";
import { useOptionalTaskModal } from "@/contexts/task-modal-context";
import { useOptionalSidebar } from "@/components/ui/sidebar";
import type { LucideIcon } from "lucide-react";
import type { ClientResolvedReference } from "./reference-registry";

export function ReferenceChip({
  resolved,
  className,
  IconOverride,
  iconClassName,
  color,
  wrapLabel = false,
  iconOnly = false,
}: {
  resolved: ClientResolvedReference;
  className?: string;
  IconOverride?: LucideIcon;
  iconClassName?: string;
  color?: string | null;
  /** When true, allow multi-line labels (tree/row titles). Default keeps single-line chips. */
  wrapLabel?: boolean;
  /** Icon-only chip for dense surfaces (e.g. Schedule timer rail). Label moves to title/aria-label. */
  iconOnly?: boolean;
}) {
  const [, navigate] = useLocation();
  const taskModal = useOptionalTaskModal();
  // Chips can mount in detached React roots (TipTap reference widgets)
  // where SidebarProvider is absent — consume the context optionally.
  const sidebar = useOptionalSidebar();
  const isDegraded = resolved.status !== "resolved";
  const label = useReferenceLabel(resolved.ref.type, resolved.ref.id, resolved.label);
  const metadataDescription =
    typeof resolved.ref.metadata?.description === "string"
      ? resolved.ref.metadata.description.trim()
      : "";
  const tooltip = resolved.description || metadataDescription || (iconOnly ? label : "") || resolved.ref.canonical;

  const isExternal =
    resolved.href?.startsWith("http://") || resolved.href?.startsWith("https://");

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      sidebar?.closeSidebar();

      // Task references open in the modal instead of navigating
      if (resolved.ref.type === "task" && taskModal) {
        e.preventDefault();
        const taskId = Number(resolved.ref.id);
        if (Number.isFinite(taskId)) taskModal.openTaskModal(taskId);
        return;
      }
      if (!isExternal && resolved.href) {
        e.preventDefault();
        navigate(resolved.href);
      }
    },
    [sidebar, isExternal, resolved.href, navigate, resolved.ref.type, resolved.ref.id, taskModal],
  );

  const Icon = IconOverride ?? resolved.Icon;

  const content = (
    <span
      className={cn(
        "inline-flex max-w-full align-baseline items-center font-medium leading-[inherit] underline-offset-4 transition-colors",
        iconOnly ? "mx-0 gap-0" : "mx-1 gap-1 text-[1em]",
        wrapLabel ? "whitespace-normal break-words" : "whitespace-nowrap break-normal",
        isDegraded
          ? "text-muted-foreground"
          : color
            ? "hover:opacity-80"
            : "text-cta hover:text-active",
        className,
      )}
      style={!isDegraded && color ? { color } : undefined}
      title={tooltip}
      aria-label={iconOnly ? label : undefined}
      data-testid={`reference-${resolved.ref.type}-${resolved.ref.id}`}
    >
      <Icon className={cn("h-3.5 w-3.5 shrink-0 no-underline", iconClassName)} aria-hidden="true" strokeWidth={2} />
      {!iconOnly && (
        <span
          className={cn(
            "min-w-0 border-b border-current leading-[inherit]",
            wrapLabel ? "whitespace-normal break-words" : "truncate",
          )}
        >
          {label}
        </span>
      )}
    </span>
  );

  if (resolved.href && resolved.status === "resolved") {
    return (
      <a
        href={resolved.href}
        className={cn(
          "inline-flex max-w-full align-baseline no-underline",
          iconOnly && "h-7 w-7 items-center justify-center rounded-md hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
        onClick={handleClick}
        aria-label={iconOnly ? label : undefined}
        {...(isExternal ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      >
        {content}
      </a>
    );
  }

  return content;
}
