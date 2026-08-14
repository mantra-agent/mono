import { createRoot } from "react-dom/client";
import "./index.css";
import { installFirstPartyVoiceWorklets } from "./lib/first-party-voice-worklets";
import { getProvisionalOnboardingToken } from "./lib/immersive-entrance";
import { installSpaVersionSkewGuard } from "./lib/spa-version-skew";

// Own AudioWorklet module URLs before any voice session can start — including
// the provisional immersive-orb entrance, which mounts VoiceSessionProvider
// outside the full App tree. Must stay synchronous at module evaluation.
installFirstPartyVoiceWorklets();

const root = createRoot(document.getElementById("root")!);
// The standalone lightweight root serves the Recall meeting-bot visualizer
// (`/visualizer?token=`) and the design preview (`/visualizer?state=`). The
// provisional immersive-orb voice entrance (`/visualizer?i=`) is excluded here
// so it falls through to the full App and renders in the app shell's
// immersive-orb presentation mode.
const isStandaloneVisualizer =
  window.location.pathname === "/visualizer" && getProvisionalOnboardingToken() === null;

async function renderRoot(): Promise<void> {
  if (isStandaloneVisualizer) {
    const { default: VisualizerPage } = await import("./pages/visualizer");
    root.render(<VisualizerPage />);
    return;
  }

  installSpaVersionSkewGuard();

  const [
    { default: App },
    { initializeActiveScrollbars },
    { initializeBrowserTelemetry },
    { initWebSentry },
  ] = await Promise.all([
    import("./App"),
    import("./lib/active-scrollbars"),
    import("./lib/browser-telemetry"),
    import("./lib/sentry"),
  ]);

  // Fail-open crash capture — never blocks first paint.
  void initWebSentry();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
  initializeActiveScrollbars();
  initializeBrowserTelemetry();
  root.render(<App />);
}

void renderRoot();
