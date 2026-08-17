"use client"

import * as React from "react"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"

import { GLASS_SURFACE_CLASS } from "@/components/ui/glass-surface"
import { cn } from "@/lib/utils"

/**
 * App-level / subtree delay owner. Prefer one high in the tree for shared
 * skip-delay behavior. `Tooltip` also mounts a same-module provider so a Root
 * can never render without provider context (chunk split, unmount race, or a
 * surface outside AppShell).
 */
const TooltipProvider = TooltipPrimitive.Provider

type TooltipProps = React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Root> & {
  /** Provider delay when this Root carries its own provider (default 200ms). */
  delayDuration?: number
}

/**
 * Glass tooltip root. Always wraps Radix Root in the same-module Provider so
 * "`Tooltip` must be used within `TooltipProvider`" is unrepresentable for
 * callers that only mount `<Tooltip>`. Nested providers are valid in Radix;
 * the nearest provider wins for delay / skip-delay.
 */
function Tooltip({ delayDuration = 200, ...props }: TooltipProps) {
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration} skipDelayDuration={0}>
      <TooltipPrimitive.Root {...props} />
    </TooltipPrimitive.Provider>
  )
}

const TooltipTrigger = TooltipPrimitive.Trigger

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 8, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        GLASS_SURFACE_CLASS,
        "z-50 max-w-xs rounded-xl px-3 py-1.5 text-xs leading-snug text-white animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-[--radix-tooltip-content-transform-origin]",
        className
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
