import * as React from "react"

import { isNativeAppWebView } from "@/lib/native-app"

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
function useViewportMobile() {
  const [viewportMobile, setViewportMobile] = React.useState(
    () => typeof window !== "undefined" && window.innerWidth < MOBILE_BREAKPOINT,
  )

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => setViewportMobile(window.innerWidth < MOBILE_BREAKPOINT)
    mql.addEventListener("change", onChange)
    onChange()
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return viewportMobile
}

/**
 * Returns true for the native mobile app or a genuinely mobile viewport.
 * Use this for interaction modality. It deliberately ignores narrow desktop
 * containers, which may need responsive layout without mobile presentation.
 */
export function useIsMobileViewport() {
  const nativeApp = isNativeAppWebView()
  const viewportMobile = useViewportMobile()
  return nativeApp || viewportMobile
}

export function useIsMobile() {
  const nativeApp = isNativeAppWebView()
  const containerWidth = React.useContext(ContainerWidthContext)
  const viewportMobile = useViewportMobile()

  if (nativeApp) return true

  if (containerWidth !== null) {
    return containerWidth < MOBILE_BREAKPOINT
  }

  return viewportMobile
}
