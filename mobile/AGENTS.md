# Authority

Root `AGENTS.md` and `CODING.md` own engineering principles and procedure. Load this file before inspecting or changing `mobile/`; load root `DESIGN.md` for user-facing work. Server and shared subtrees retain their nearest instruction boundaries.

# Mobile Architecture

`mobile/app/_layout.tsx` is the Expo composition root. It loads the selected backend once, initializes logging/telemetry, and mounts the gesture/safe-area/bottom-sheet shell plus the native voice, glasses-session, and interface-mode providers. Expo Router files own navigation; providers own transport/session state and screens project it.

The default `/` route is the authenticated web Home surface inside a hardened same-origin WebView. `/pro` exposes the full web client and `/voice` is the native diagnostic/rehearsal surface. Browser session cookies in the shared iOS cookie jar are the sole authentication state; do not add a parallel native user/session store or persist credentials/tokens in AsyncStorage. Native-to-web messages are capability-shaped and the WebView accepts only the configured backend origin.

# Boundaries

- `src/config.ts` is the only backend-selection authority. Production/development URLs come from Expo public build configuration; a custom URL is normalized to HTTPS (localhost HTTP only in development). Modules resolve `Config.SERVER_URL` at request time rather than capturing it at import.
- `src/lib/network.ts` is the canonical authenticated native HTTP transport. It composes caller cancellation with a real deadline and never retries ambiguous mutations. JSON adapters (`api.ts`, `glasses-session-api.ts`) and native capture uploads build on it.
- `src/contexts/voice-session.tsx` owns the ElevenLabs React Native lifecycle. Keep the SDK lazy-loaded behind its guarded polyfill boundary; screens and the WebView bridge consume provider state rather than opening another voice transport.
- `src/contexts/glasses-agent-session.tsx` owns the persisted server glasses-session workflow. `src/services/dat-bridge-service.ts` owns the registered Meta DAT native bridge, remote debug command polling, and capture upload. Remote debug routes require authenticated `build:write`; installation never grants that authority.
- `modules/agent-native` is an Expo autolinked module (`expo-module.config.json` + podspec). `app.config.js` registers `withMetaDAT` and `withAgentAppIntents`; retain native/JS methods only after checking autolinking, plugin build phases, deep links, event listeners, and server callbacks.
- Repo-level shared contracts are consumed through `@shared/*`, resolved only by `metro.config.js`. Never copy shared voice, glasses, reference, telemetry, permission, or Mod contracts into mobile.
- `src/lib/startup-telemetry.ts` owns bounded, best-effort, replayable startup evidence. `src/lib/logger.ts` owns bounded native logs. Neither is correctness state, and neither may retain secrets, cookies, contact bodies, frame bytes, or unbounded errors.
- `src/theme/glasses.ts` is the semantic React Native token shim derived from `DESIGN.md`. Product components use role-named colors, spacing, radius, and typography from it; no raw palette values in touched surfaces. Interactive controls need a 44pt target, accessibility role/label, and non-color state text.

# Reliability

A reconnecting screen recovers from server/session authority. AsyncStorage may hold bounded non-secret configuration, interface preference, cached surface projection, and telemetry envelopes only. Network work has a named deadline, polling is single-owner and non-overlapping, startup work is bounded and non-fatal where optional, and interrupted external mutations are reconciled rather than blindly replayed.

# Verification

Use the repository root production gate only:

```bash
npm run build
```

Do not add or run tests, mobile lint, Expo builds, or standalone type checks unless Ray explicitly requests them.
