/**
 * Semantic React Native token shim derived from DESIGN.md.
 * Product components use role-named colors/spacing/radius/typography from here.
 * Raw palette values belong only in this file.
 */
export const glassesTheme = {
  colors: {
    canvas: '#000000',
    viewport: '#09090b',
    surface: '#0d0d0d',
    surfaceElevated: '#111111',
    surfaceMuted: '#1a1a1a',
    surfaceStrong: '#222222',
    textPrimary: '#ffffff',
    /** Compatibility alias used by debug overlay and older surfaces. */
    text: '#ffffff',
    textSecondary: 'rgba(255, 255, 255, 0.75)',
    textTertiary: 'rgba(255, 255, 255, 0.6)',
    textQuiet: '#777777',
    textFaint: '#666666',
    textSoft: '#bbbbbb',
    textDim: '#999999',
    textSubtle: '#dddddd',
    borderSubtle: 'rgba(255, 255, 255, 0.06)',
    borderChrome: 'rgba(255, 255, 255, 0.08)',
    borderStrong: '#2a2a2a',
    borderMuted: '#333333',
    borderSoft: '#444444',
    cardBackground: 'rgba(255, 255, 255, 0.04)',
    actionPrimary: 'rgba(255, 255, 255, 0.15)',
    actionSecondary: 'rgba(255, 255, 255, 0.06)',
    handle: 'rgba(255, 255, 255, 0.3)',
    cta: '#1A9BDB',
    ctaMuted: '#101827',
    destructive: '#dc2626',
    urgency: {
      critical: '#ef4444',
      high: '#fbbf24',
      medium: '#ffffff',
      low: '#d4d4d8',
    },
    severity: {
      info: '#3b82f6',
      warning: '#fbbf24',
      critical: '#ef4444',
    },
    connection: {
      connected: '#22c55e',
      connecting: '#f59e0b',
      disconnected: '#333333',
      speaking: '#3b82f6',
      error: '#ef4444',
    },
    status: {
      successText: '#86efac',
      successFill: 'rgba(34, 197, 94, 0.14)',
      warningText: '#fbbf24',
      warningFill: 'rgba(245, 158, 11, 0.14)',
      errorText: '#f87171',
    },
    chatFab: '#a855f7',
  },
  spacing: {
    screenX: 24,
    surfaceX: 24,
    surfaceGap: 20,
    cardY: 20,
    cardX: 24,
    tight: 8,
    default: 16,
  },
  radius: {
    card: 16,
    button: 12,
    fab: 28,
    pill: 999,
    dot: 3,
  },
  typography: {
    title: { fontSize: 18, lineHeight: 23, fontWeight: '600' as const },
    subtitle: { fontSize: 16, lineHeight: 22, fontWeight: '400' as const },
    label: { fontSize: 16, fontWeight: '500' as const },
    action: { fontSize: 15, fontWeight: '500' as const },
    timer: { fontSize: 32, fontWeight: '300' as const },
    transition: { fontSize: 20, fontWeight: '500' as const },
    meta: { fontSize: 12, fontWeight: '600' as const },
    eyebrow: { fontSize: 11, fontWeight: '700' as const, letterSpacing: 1.2 },
  },
};

/** Product-screen alias so non-glasses surfaces share one semantic token owner. */
export const productTheme = glassesTheme;
