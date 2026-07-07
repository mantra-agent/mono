import * as React from "react"

const MOBILE_BREAKPOINT = 768

/** Context that provides the measured width of the nearest container (e.g. <main>). */
const ContainerWidthContext = React.createContext<number | null>(null)

/**
 * Wraps children and measures the container element's width via ResizeObserver.
 * Components inside this provider that call useIsMobile() will get container-aware results.
 */
export function ContainerWidthProvider({ children }: { children: React.ReactNode }) {
  const [width, setWidth] = React.useState<number | null>(null)
  const ref = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const el = ref.current
    if (!el) return

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // Use borderBoxSize when available for accuracy, fall back to contentRect
        const w = entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width
        setWidth(w)
      }
    })

    observer.observe(el)
    // Set initial width
    setWidth(el.offsetWidth)

    return () => observer.disconnect()
  }, [])

  return (
    <ContainerWidthContext.Provider value={width}>
      <div ref={ref} className="contents">
        {children}
      </div>
    </ContainerWidthContext.Provider>
  )
}

/**
 * Returns true when the effective width is below the mobile breakpoint.
 * Inside a ContainerWidthProvider (e.g. <main>), uses the container's width.
 * Outside (sidebar, top bar, bottom bar), falls back to viewport width.
 */
export function useIsMobile() {
  const containerWidth = React.useContext(ContainerWidthContext)
  const [viewportMobile, setViewportMobile] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    // Skip viewport listener when container width is available
    if (containerWidth !== null) return

    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => {
      setViewportMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    mql.addEventListener("change", onChange)
    setViewportMobile(window.innerWidth < MOBILE_BREAKPOINT)
    return () => mql.removeEventListener("change", onChange)
  }, [containerWidth])

  if (containerWidth !== null) {
    return containerWidth < MOBILE_BREAKPOINT
  }

  return !!viewportMobile
}
