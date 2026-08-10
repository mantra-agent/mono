interface NativeAppWindow extends Window {
  ReactNativeWebView?: { postMessage?: unknown };
  __AGENT_NATIVE_APP__?: { platform?: unknown };
}

export function isNativeAppWebView(): boolean {
  if (typeof window === "undefined") return false;
  const nativeWindow = window as NativeAppWindow;
  return nativeWindow.__AGENT_NATIVE_APP__?.platform === "ios"
    || typeof nativeWindow.ReactNativeWebView?.postMessage === "function";
}
