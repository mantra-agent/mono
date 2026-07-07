import { useCallback } from "react";
import { useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { useReferenceLabel } from "@/hooks/use-reference-label";
import type { ClientResolvedReference } from "./reference-registry";

export function ReferenceChip({ resolved, className }: { resolved: ClientResolvedReference; className?: string }) {
  const [, navigate] = useLocation();
  const isDegraded = resolved.status !== "resolved";
  const label = useReferenceLabel(resolved.ref.type, resolved.ref.id, resolved.label);

  const isExternal =
    resolved.href?.startsWith("http://") || resolved.href?.startsWith("https://");

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (!isExternal && resolved.href) {
        e.preventDefault();
        navigate(resolved.href);
      }
    },
    [isExternal, resolved.href, navigate],
  );

  const Icon = resolved.Icon;

  const content = (
    <span
      className={cn(
        "mx-1 inline-flex max-w-full translate-y-[-1px] align-baseline items-center gap-1 whitespace-nowrap break-normal text-xs font-medium underline-offset-4 transition-colors",
        isDegraded
          ? "text-muted-foreground"
          : "text-cta hover:text-active",
        className,
      )}
      title={resolved.description || resolved.ref.canonical}
      data-testid={`reference-${resolved.ref.type}-${resolved.ref.id}`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 no-underline" aria-hidden="true" strokeWidth={2} />
      <span className="min-w-0 truncate border-b border-current leading-tight">{label}</span>
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
