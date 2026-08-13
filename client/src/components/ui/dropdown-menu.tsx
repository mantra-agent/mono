import * as React from "react"
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu"
import { Check, ChevronLeft, ChevronRight, Circle } from "lucide-react"
import { createPortal } from "react-dom"

import { cn } from "@/lib/utils"
import { useIsMobileViewport } from "@/hooks/use-mobile"

/**
 * Modality-aware DropdownMenu.
 *
 * Desktop renders the raw Radix dropdown exactly as before. On mobile the same
 * declared child tree is presented as an inset picker-style panel with drill-in
 * navigation. This preserves one action hierarchy without forcing desktop
 * flyout geometry or action-sheet chrome onto a touch viewport.
 */

const MOBILE_ROW_CLASS =
  "relative flex h-9 w-full items-center gap-2 rounded-sm px-2.5 text-left text-sm font-medium outline-none transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring [&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0"

// ---------------------------------------------------------------------------
// Child-tree helpers (mobile)
// ---------------------------------------------------------------------------

function flattenChildren(children: React.ReactNode): React.ReactElement[] {
  const out: React.ReactElement[] = []
  React.Children.forEach(children, (child) => {
    if (child === null || child === undefined || typeof child === "boolean") return
    if (Array.isArray(child)) {
      out.push(...flattenChildren(child))
      return
    }
    if (React.isValidElement(child)) {
      if (child.type === React.Fragment) {
        out.push(...flattenChildren((child.props as { children?: React.ReactNode }).children))
        return
      }
      if (child.type === DropdownMenuGroup) {
        out.push(...flattenChildren((child.props as { children?: React.ReactNode }).children))
        return
      }
      out.push(child)
    }
  })
  return out
}

function isType(el: React.ReactElement, type: unknown): boolean {
  return el.type === type
}

function findChild(
  children: React.ReactNode,
  type: unknown,
): React.ReactElement | undefined {
  return flattenChildren(children).find((c) => isType(c, type))
}

/**
 * Locate a declared DropdownMenuTrigger even when call sites wrap it in
 * presentation chrome such as Tooltip. MobileDropdownRoot only mounts the
 * trigger it finds; a nested Trigger must still resolve or the control vanishes.
 */
function findDescendant(
  children: React.ReactNode,
  type: unknown,
): React.ReactElement | undefined {
  for (const child of flattenChildren(children)) {
    if (isType(child, type)) return child
    const nested = (child.props as { children?: React.ReactNode } | undefined)?.children
    if (nested == null) continue
    const found = findDescendant(nested, type)
    if (found) return found
  }
  return undefined
}

interface MobileLevel {
  title: React.ReactNode
  nodes: React.ReactElement[]
}

/** Walk the declared content tree to the level named by `path` (sub indices). */
function resolveMobileLevel(
  contentChildren: React.ReactNode,
  path: number[],
): MobileLevel {
  let nodes = flattenChildren(contentChildren)
  let title: React.ReactNode = null
  for (const idx of path) {
    const subs = nodes.filter((c) => isType(c, DropdownMenuSub))
    const sub = subs[idx]
    if (!sub) break
    const trigger = findChild(
      (sub.props as { children?: React.ReactNode }).children,
      DropdownMenuSubTrigger,
    )
    title = trigger ? (trigger.props as { children?: React.ReactNode }).children : title
    const subContent = findChild(
      (sub.props as { children?: React.ReactNode }).children,
      DropdownMenuSubContent,
    )
    nodes = subContent
      ? flattenChildren((subContent.props as { children?: React.ReactNode }).children)
      : []
  }
  return { title, nodes }
}

interface MobileRowContext {
  close: () => void
  drill: (subIndex: number) => void
}

function MobileMenuLevel({
  contentChildren,
  path,
  ctx,
  back,
  titleId,
}: {
  contentChildren: React.ReactNode
  path: number[]
  ctx: MobileRowContext
  back: () => void
  titleId: string
}) {
  const { title, nodes } = resolveMobileLevel(contentChildren, path)
  const rows: React.ReactNode[] = []
  let subCounter = 0
  let key = 0

  for (const node of nodes) {
    const k = `row-${key++}`
    if (isType(node, DropdownMenuSeparator)) {
      rows.push(<div key={k} className="-mx-1 my-1 h-px bg-muted" />)
      continue
    }
    if (isType(node, DropdownMenuLabel)) {
      rows.push(
        <div key={k} className="px-3 py-1.5 text-xs font-semibold text-muted-foreground">
          {(node.props as { children?: React.ReactNode }).children}
        </div>,
      )
      continue
    }
    if (isType(node, DropdownMenuSub)) {
      const subIndex = subCounter++
      const trigger = findChild(
        (node.props as { children?: React.ReactNode }).children,
        DropdownMenuSubTrigger,
      )
      const disabled = Boolean((trigger?.props as { disabled?: boolean } | undefined)?.disabled)
      rows.push(
        <button
          key={k}
          type="button"
          disabled={disabled}
          className={cn(MOBILE_ROW_CLASS, disabled && "pointer-events-none opacity-50")}
          onClick={() => ctx.drill(subIndex)}
        >
          {trigger ? (trigger.props as { children?: React.ReactNode }).children : null}
          <ChevronRight className="ml-auto" />
        </button>,
      )
      continue
    }
    if (isType(node, DropdownMenuRadioGroup)) {
      const groupProps = node.props as {
        value?: string
        onValueChange?: (value: string) => void
        children?: React.ReactNode
      }
      const items = flattenChildren(groupProps.children).filter((c) =>
        isType(c, DropdownMenuRadioItem),
      )
      for (const item of items) {
        const ip = item.props as {
          value: string
          disabled?: boolean
          children?: React.ReactNode
        }
        const selected = ip.value === groupProps.value
        rows.push(
          <button
            key={`${k}-${ip.value}`}
            type="button"
            disabled={ip.disabled}
            className={cn(MOBILE_ROW_CLASS, "pl-9", ip.disabled && "pointer-events-none opacity-50")}
            onClick={() => {
              groupProps.onValueChange?.(ip.value)
              ctx.close()
            }}
          >
            {selected && <Circle className="absolute left-3 h-2 w-2 fill-current" />}
            {ip.children}
          </button>,
        )
      }
      continue
    }
    if (isType(node, DropdownMenuCheckboxItem)) {
      const cp = node.props as {
        checked?: boolean
        disabled?: boolean
        onCheckedChange?: (checked: boolean) => void
        children?: React.ReactNode
        className?: string
      }
      rows.push(
        <button
          key={k}
          type="button"
          disabled={cp.disabled}
          className={cn(MOBILE_ROW_CLASS, "pl-9", cp.className, cp.disabled && "pointer-events-none opacity-50")}
          onClick={() => {
            cp.onCheckedChange?.(!cp.checked)
            ctx.close()
          }}
        >
          {cp.checked && <Check className="absolute left-3 h-4 w-4" />}
          {cp.children}
        </button>,
      )
      continue
    }
    if (isType(node, DropdownMenuItem)) {
      const ip = node.props as {
        disabled?: boolean
        onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void
        onSelect?: (e: Event) => void
        children?: React.ReactNode
        className?: string
      }
      rows.push(
        <button
          key={k}
          type="button"
          disabled={ip.disabled}
          className={cn(MOBILE_ROW_CLASS, ip.className, ip.disabled && "pointer-events-none opacity-50")}
          onClick={(e) => {
            ip.onClick?.(e)
            ip.onSelect?.(e.nativeEvent)
            ctx.close()
          }}
        >
          {ip.children}
        </button>,
      )
      continue
    }
    // Unknown node kind: render inert so nothing is silently dropped.
    rows.push(
      <div key={k} className="px-3 py-1.5 text-sm text-muted-foreground">
        {(node.props as { children?: React.ReactNode }).children ?? null}
      </div>,
    )
  }

  const showBack = path.length > 0
  return (
    <>
      <h2 id={titleId} className="sr-only">{title ?? "Menu"}</h2>
      {showBack ? (
        <div className="border-b border-border/40 p-1">
          <button
            type="button"
            className="flex h-9 w-full min-w-0 items-center gap-2 rounded-sm px-2.5 text-sm font-medium outline-none transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            onClick={back}
          >
            <ChevronLeft className="h-3.5 w-3.5 shrink-0" />
            <span className="flex min-w-0 flex-1 flex-nowrap items-center gap-2 overflow-hidden whitespace-nowrap [&_svg]:size-3.5 [&_svg]:shrink-0">
              {React.Children.map(title, (child) =>
                React.isValidElement(child)
                  ? child
                  : <span className="min-w-0 truncate">{child}</span>,
              )}
            </span>
          </button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1">
        {rows}
      </div>
    </>
  )
}

function MobileDropdownRoot({
  children,
  open: controlledOpen,
  onOpenChange,
}: DropdownMenuPrimitive.DropdownMenuProps) {
  const [internalOpen, setInternalOpen] = React.useState(false)
  const [path, setPath] = React.useState<number[]>([])
  const [position, setPosition] = React.useState<React.CSSProperties | null>(null)
  const triggerRef = React.useRef<HTMLElement | null>(null)
  const panelRef = React.useRef<HTMLDivElement | null>(null)
  const titleId = React.useId()
  const open = controlledOpen ?? internalOpen

  const setOpen = React.useCallback(
    (next: boolean) => {
      if (!next) setPath([])
      if (controlledOpen === undefined) setInternalOpen(next)
      onOpenChange?.(next)
    },
    [controlledOpen, onOpenChange],
  )

  // Direct child first (common path); descend for Tooltip-wrapped triggers.
  const trigger =
    findChild(children, DropdownMenuTrigger) ??
    findDescendant(children, DropdownMenuTrigger)
  const content = findChild(children, DropdownMenuContent)

  const ctx = React.useMemo<MobileRowContext>(
    () => ({
      close: () => setOpen(false),
      drill: (subIndex: number) => setPath((cur) => [...cur, subIndex]),
    }),
    [setOpen],
  )

  const triggerProps = (trigger?.props ?? {}) as {
    asChild?: boolean
    children?: React.ReactNode
    className?: string
    onClick?: (event: React.MouseEvent<HTMLElement>) => void
  }
  const contentChildren = (content?.props as { children?: React.ReactNode } | undefined)?.children
  const asChildTrigger = Boolean(triggerProps.asChild)
  const childTrigger = asChildTrigger && React.isValidElement(triggerProps.children)
    ? (triggerProps.children as React.ReactElement<{
        className?: string
        onClick?: (event: React.MouseEvent<HTMLElement>) => void
      }>)
    : null

  const placePanel = React.useCallback(() => {
    const element = triggerRef.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const viewport = window.visualViewport
    const viewportTop = viewport?.offsetTop ?? 0
    const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight)
    const inset = 16
    const gap = 8
    const above = rect.top - viewportTop - inset
    const below = viewportBottom - rect.bottom - inset
    const opensAbove = above >= below
    const availableHeight = Math.max(144, (opensAbove ? above : below) - gap)

    setPosition({
      left: inset,
      right: inset,
      maxHeight: availableHeight,
      ...(opensAbove
        ? { bottom: window.innerHeight - rect.top + gap }
        : { top: rect.bottom + gap }),
    })
  }, [])

  React.useLayoutEffect(() => {
    if (!open) return
    placePanel()
    const viewport = window.visualViewport
    viewport?.addEventListener("resize", placePanel)
    viewport?.addEventListener("scroll", placePanel)
    window.addEventListener("resize", placePanel)
    window.addEventListener("scroll", placePanel, true)
    return () => {
      viewport?.removeEventListener("resize", placePanel)
      viewport?.removeEventListener("scroll", placePanel)
      window.removeEventListener("resize", placePanel)
      window.removeEventListener("scroll", placePanel, true)
    }
  }, [open, placePanel])

  React.useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("pointerdown", dismiss)
    document.addEventListener("keydown", escape)
    return () => {
      document.removeEventListener("pointerdown", dismiss)
      document.removeEventListener("keydown", escape)
    }
  }, [open, setOpen])

  const bindTrigger = <P extends {
    className?: string
    onClick?: (event: React.MouseEvent<HTMLElement>) => void
  }>(
    element: React.ReactElement<P>,
    originalOnClick?: (event: React.MouseEvent<HTMLElement>) => void,
  ) =>
    React.cloneElement(element, {
      ref: (node: HTMLElement | null) => {
        triggerRef.current = node
      },
      "aria-expanded": open,
      "aria-haspopup": "menu",
      onClick: (event: React.MouseEvent<HTMLElement>) => {
        originalOnClick?.(event)
        if (!event.defaultPrevented) setOpen(!open)
      },
    } as Partial<P> & React.HTMLAttributes<HTMLElement>)

  // Prefer the asChild control element; otherwise render a button using Trigger props.
  const triggerElement = childTrigger
    ? bindTrigger(childTrigger, childTrigger.props.onClick)
    : trigger
      ? bindTrigger(
          <button
            type="button"
            className={triggerProps.className}
          />,
          triggerProps.onClick,
        )
      : null

  return (
    <>
      {triggerElement}
      {open && position ? createPortal(
        <div
          ref={panelRef}
          role="menu"
          aria-labelledby={titleId}
          style={position}
          className="fixed z-50 flex flex-col overflow-hidden rounded-md border border-border bg-background text-foreground shadow-none"
        >
          <MobileMenuLevel
            contentChildren={contentChildren}
            path={path}
            ctx={ctx}
            back={() => setPath((cur) => cur.slice(0, -1))}
            titleId={titleId}
          />
        </div>,
        document.body,
      ) : null}
    </>
  )
}

function DropdownMenu(props: DropdownMenuPrimitive.DropdownMenuProps) {
  const isMobileViewport = useIsMobileViewport()
  if (isMobileViewport) return <MobileDropdownRoot {...props} />
  return <DropdownMenuPrimitive.Root {...props} />
}
DropdownMenu.displayName = "DropdownMenu"

const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger

const DropdownMenuGroup = DropdownMenuPrimitive.Group

const DropdownMenuPortal = DropdownMenuPrimitive.Portal

const DropdownMenuSub = DropdownMenuPrimitive.Sub

const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup

const DropdownMenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger> & {
    inset?: boolean
  }
>(({ className, inset, children, ...props }, ref) => (
  <DropdownMenuPrimitive.SubTrigger
    ref={ref}
    className={cn(
      "flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm max-md:min-h-11 outline-none focus:bg-accent data-[state=open]:bg-accent [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
      inset && "pl-8",
      className
    )}
    {...props}
  >
    {children}
    <ChevronRight className="ml-auto" />
  </DropdownMenuPrimitive.SubTrigger>
))
DropdownMenuSubTrigger.displayName =
  DropdownMenuPrimitive.SubTrigger.displayName

const DropdownMenuSubContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.SubContent
    ref={ref}
    className={cn(
      "z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-[--radix-dropdown-menu-content-transform-origin]",
      className
    )}
    {...props}
  />
))
DropdownMenuSubContent.displayName =
  DropdownMenuPrimitive.SubContent.displayName

const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-[8rem] max-w-[calc(100vw-1rem)] overflow-y-auto overflow-x-hidden rounded-md border border-border/60 bg-popover p-1 text-popover-foreground shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-[--radix-dropdown-menu-content-transform-origin]",
        className
      )}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
))
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName

const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & {
    inset?: boolean
  }
>(({ className, inset, ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm max-md:min-h-11 outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
      inset && "pl-8",
      className
    )}
    {...props}
  />
))
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName

const DropdownMenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>
>(({ className, children, checked, ...props }, ref) => (
  <DropdownMenuPrimitive.CheckboxItem
    ref={ref}
    className={cn(
      "relative flex cursor-default select-none items-center rounded-md py-1.5 pl-8 pr-2 text-sm max-md:min-h-11 outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className
    )}
    checked={checked}
    {...props}
  >
    <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
      <DropdownMenuPrimitive.ItemIndicator>
        <Check className="h-4 w-4" />
      </DropdownMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </DropdownMenuPrimitive.CheckboxItem>
))
DropdownMenuCheckboxItem.displayName =
  DropdownMenuPrimitive.CheckboxItem.displayName

const DropdownMenuRadioItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem>
>(({ className, children, ...props }, ref) => (
  <DropdownMenuPrimitive.RadioItem
    ref={ref}
    className={cn(
      "relative flex cursor-default select-none items-center rounded-md py-1.5 pl-8 pr-2 text-sm max-md:min-h-11 outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className
    )}
    {...props}
  >
    <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
      <DropdownMenuPrimitive.ItemIndicator>
        <Circle className="h-2 w-2 fill-current" />
      </DropdownMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </DropdownMenuPrimitive.RadioItem>
))
DropdownMenuRadioItem.displayName = DropdownMenuPrimitive.RadioItem.displayName

const DropdownMenuLabel = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label> & {
    inset?: boolean
  }
>(({ className, inset, ...props }, ref) => (
  <DropdownMenuPrimitive.Label
    ref={ref}
    className={cn(
      "px-2 py-1.5 text-sm font-semibold",
      inset && "pl-8",
      className
    )}
    {...props}
  />
))
DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName

const DropdownMenuSeparator = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Separator
    ref={ref}
    className={cn("-mx-1 my-1 h-px bg-muted", className)}
    {...props}
  />
))
DropdownMenuSeparator.displayName = DropdownMenuPrimitive.Separator.displayName

const DropdownMenuShortcut = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) => {
  return (
    <span
      className={cn("ml-auto text-xs tracking-widest opacity-60", className)}
      {...props}
    />
  )
}
DropdownMenuShortcut.displayName = "DropdownMenuShortcut"

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuGroup,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuRadioGroup,
}
