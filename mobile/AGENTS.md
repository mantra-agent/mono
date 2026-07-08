# Authority

Root `AGENTS.md` is mandatory and authoritative for engineering workflow, Coding Task Gate, Engineering Principles, git policy, and verification. This file adds local constraints only. Load this file before touching files under `mobile/`. For UI/product-facing work, also load root `DESIGN.md`. If instructions conflict, follow root `AGENTS.md` unless Ray explicitly overrides.

# Mobile App — Agent Primary Interface

## Overview

Expo React Native app providing three layers of interaction with Agent:

1. **Simple Interface (WebView)** — Default screen. Loads the shared web Simple page at `/simple`, matching the web model-selector Simple experience.
2. **Pro Interface (WebView)** — Full web client in a WebView. Every page, every tool, full navigation.
3. **Chat/Voice Surfaces** — Voice interaction remains supported at `/voice`; chat can still be exposed through web surfaces.

Voice interaction via Meta Ray-Ban glasses remains supported at the `/voice` route.

## Architecture

- **Framework:** Expo ~52 with Expo Router (file-based routing)
- **Surface rendering:** Native React Native components consuming `SurfaceDescriptor` from `@shared/models/glasses`
- **Shared types:** Metro resolves the repo-level `shared/` directory through `mobile/metro.config.js`; do not copy shared types into mobile
- **Pro/Chat:** WebView (`react-native-webview`) with `sharedCookiesEnabled` for cookie-based auth
- **Chat overlay:** `@gorhom/bottom-sheet` with 90% snap point
- **Auth:** Cookie-based session auth via the web login page in the WebView. Session cookies shared between WebView and native via iOS shared cookie jar (`sharedCookiesEnabled`).
- **Voice:** ElevenLabs React Native SDK (`@elevenlabs/react-native`) aligned to the LiveKit/WebRTC line ElevenLabs officially supports
- **Server:** Zero server changes required. Consumes existing Cortex API.

## Data Flow

```
App opens
  → loads WebView at SERVER_URL + '/simple'
  → shared web Simple feed owns data loading and rendering
  → mobile and web use the same Simple experience
```

## Directory Structure

```
mobile/
├── app/                              # Expo Router screens
│   ├── _layout.tsx                   # Root: GestureHandler, AuthProvider, VoiceProvider
│   ├── index.tsx                     # PrimaryScreen (default — shared web Simple page)
│   ├── pro.tsx                       # ProScreen (full WebView)
│   ├── voice.tsx                     # VoiceScreen (demoted from default)
│   └── settings.tsx                  # Dev config (server URL, agent ID)
├── src/
│   ├── config.ts                     # AsyncStorage-backed config singleton
│   ├── contexts/
│   │   ├── auth.tsx                  # AuthContext (session check, login/logout, foreground re-verify)
│   │   └── voice-session.tsx         # ElevenLabs voice session
│   ├── hooks/
│   │   ├── use-audio-routing.ts      # BT HFP monitoring
│   │   └── use-surface.ts            # Cortex fetch + polling + caching
│   ├── lib/
│   │   ├── api.ts                    # Fetch wrapper (credentials, 401 handling)
│   │   └── logger.ts                 # Structured logging
│   ├── theme/
│   │   └── glasses.ts                # Mobile theme shim derived from DESIGN.md/glasses CSS tokens
│   └── components/
│       ├── chat-sheet.tsx            # Bottom sheet with pre-warmed WebView
│       ├── surface-renderer.tsx      # Maps ComponentDescriptor[] to native cards
│       ├── status-indicator.tsx      # Voice status pulsing dot
│       ├── session-button.tsx        # Voice start/stop button
│       └── cards/                    # Native card components (6 types)
│           ├── index.ts
│           ├── text-card.tsx
│           ├── list-card.tsx
│           ├── timer-card.tsx
│           ├── alert-card.tsx
│           ├── action-card.tsx
│           └── transition-card.tsx
├── app.json                          # Expo config
├── babel.config.js                   # Reanimated plugin
├── eas.json                          # EAS Build profiles
├── metro.config.js                   # Resolves repo-level shared/ imports
├── package.json                      # Dependencies
└── tsconfig.json                     # TypeScript config and @shared path alias
```

## Key Integration Points

- **Cortex API:** `GET /api/glasses/surface` (fetch), `GET /api/glasses/events` (SSE, v2)
- **Auth:** `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/logout`
- **WebView auth:** Session cookie shared via iOS `WKHTTPCookieStore` + `sharedCookiesEnabled`
- **Surface types:** Imported directly from `@shared/models/glasses`; `shared/models/glasses.ts` is the single source of truth
- **Design tokens:** Mobile theme values live in `src/theme/glasses.ts` and are derived from DESIGN.md + `client/src/pages/zero/glasses.css`. Do not scatter raw card colors/spacing across components.

## Card Types

| Type | Native Component | Description |
|------|-----------------|-------------|
| TextCard | `cards/text-card.tsx` | Title, subtitle, urgency color coding |
| ListCard | `cards/list-card.tsx` | Title, items with label/meta, maxVisible |
| TimerCard | `cards/timer-card.tsx` | Label, static time display (v1) |
| AlertCard | `cards/alert-card.tsx` | Message, severity via left border color |
| ActionCard | `cards/action-card.tsx` | Label, primary/secondary variant |
| TransitionCard | `cards/transition-card.tsx` | Centered message, larger text |

## Dependencies on Mantra Server

- `server/glasses/cortex.ts` — Cortex evaluation engine (consumed, not modified)
- `server/glasses/routes.ts` — Surface API endpoints (consumed, not modified)
- `server/auth.ts` — Session cookie auth (consumed, not modified)
- Web client at `SERVER_URL` — Loaded in WebViews for Pro and Chat

## Build Commands

```bash
cd mobile
npx expo start --dev-client     # Development
eas build --profile preview --platform ios       # Standalone internal device build
eas build --profile development --platform ios   # Dev-client build, requires Metro
eas build --profile production --platform ios    # Production build
eas submit -p ios               # Submit to TestFlight
```

## Validation Commands

```bash
npm run build                    # Root production build from repo root
cd mobile && npm run lint        # Mobile lint (warnings acceptable only for pre-existing audio routing TODOs)

# Do not run standalone TypeScript checks (`npm run check`, `tsc --noEmit`, or equivalent)
# during the normal coding verification loop unless Ray explicitly asks for them.
```

## iOS Entitlements

- `UIBackgroundModes: ["audio"]` — Voice session survives phone lock
- `NSMicrophoneUsageDescription` — Required for voice input
