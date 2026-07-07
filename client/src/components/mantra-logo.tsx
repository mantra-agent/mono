import { cn } from "@/lib/utils";

const MANTRA_LOGO_SRC = "/brand/mantra-logo.png";

export function MantraLogo({ className }: { className?: string }) {
  return (
    <img
      src={MANTRA_LOGO_SRC}
      alt=""
      aria-hidden="true"
      className={cn("shrink-0 object-contain", className)}
      draggable={false}
    />
  );
}
