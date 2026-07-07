import { lazy } from "react";
import { createLogger } from "@/lib/logger";

const log = createLogger("lazyWithRetry");

const LAST_RELOAD_KEY = "lazyLastReloadTs";
const RETRY_COUNT_KEY = "lazyRetryCount";
const RELOAD_COOLDOWN_MS = 10000;
const MAX_RELOADS = 2;

export function lazyWithRetry<T extends React.ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
) {
  return lazy(() =>
    factory()
      .then((mod) => {
        sessionStorage.removeItem(RETRY_COUNT_KEY);
        return mod;
      })
      .catch((err) => {
        log.warn("chunk load failed, attempting retry:", err);
        return new Promise<{ default: T }>((resolve, reject) => {
          setTimeout(() => {
            factory()
              .then((mod) => {
                sessionStorage.removeItem(RETRY_COUNT_KEY);
                resolve(mod);
              })
              .catch((retryErr) => {
                log.error("chunk load retry failed:", retryErr);
                const lastReload = Number(
                  sessionStorage.getItem(LAST_RELOAD_KEY) || "0",
                );
                const now = Date.now();
                if (now - lastReload < RELOAD_COOLDOWN_MS) {
                  log.error("reload cooldown active, not reloading again");
                  sessionStorage.removeItem(RETRY_COUNT_KEY);
                  reject(
                    new Error("Failed to load page. Please hard-refresh."),
                  );
                  return;
                }
                const count = Number(
                  sessionStorage.getItem(RETRY_COUNT_KEY) || "0",
                );
                if (count < MAX_RELOADS) {
                  log.warn(
                    `reloading page (attempt ${count + 1}/${MAX_RELOADS})`,
                  );
                  sessionStorage.setItem(RETRY_COUNT_KEY, String(count + 1));
                  sessionStorage.setItem(LAST_RELOAD_KEY, String(now));
                  window.location.reload();
                  resolve(new Promise(() => {}) as never);
                } else {
                  sessionStorage.removeItem(RETRY_COUNT_KEY);
                  reject(
                    new Error(
                      "Failed to load page after retries. Please hard-refresh.",
                    ),
                  );
                }
              });
          }, 1000);
        });
      }),
  );
}
