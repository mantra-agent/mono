import { createRoot } from "react-dom/client";
import "./index.css";

const root = createRoot(document.getElementById("root")!);
const isStandaloneVisualizer = window.location.pathname === "/visualizer";

async function renderRoot(): Promise<void> {
  if (isStandaloneVisualizer) {
    const { default: VisualizerPage } = await import("./pages/visualizer");
    root.render(<VisualizerPage />);
    return;
  }

  const [
    { default: App },
    { initializeActiveScrollbars },
    { initializeBrowserTelemetry },
  ] = await Promise.all([
    import("./App"),
    import("./lib/active-scrollbars"),
    import("./lib/browser-telemetry"),
  ]);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
  initializeActiveScrollbars();
  initializeBrowserTelemetry();
  root.render(<App />);
}

void renderRoot();
