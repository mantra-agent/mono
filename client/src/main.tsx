import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { initializeActiveScrollbars } from "./lib/active-scrollbars";

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

initializeActiveScrollbars();

createRoot(document.getElementById("root")!).render(<App />);
