import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { initializeActiveScrollbars } from "./lib/active-scrollbars";
import { initializeBrowserTelemetry } from "./lib/browser-telemetry";

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

initializeActiveScrollbars();
initializeBrowserTelemetry();

createRoot(document.getElementById("root")!).render(<App />);
