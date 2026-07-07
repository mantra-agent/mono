import { AppToastDisplay } from "@/components/toast-display";

/**
 * Bottom-bar mount point for the shared app toast renderer.
 * Visual styling and motion live in AppToastDisplay so glasses and app toasts
 * stay identical.
 */
export function ToastLine() {
  return <AppToastDisplay className="py-2" />;
}
