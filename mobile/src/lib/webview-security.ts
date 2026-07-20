import type { WebViewNavigation } from 'react-native-webview';
import Config from '../config';
import { Logger } from './logger';

export function allowTrustedWebViewNavigation(request: WebViewNavigation): boolean {
  try {
    const allowed = new URL(request.url).origin === Config.TRUSTED_ORIGIN;
    if (!allowed) Logger.warn('WebView', 'Blocked cross-origin navigation', { targetOrigin: new URL(request.url).origin });
    return allowed;
  } catch {
    Logger.warn('WebView', 'Blocked malformed navigation');
    return false;
  }
}

export const SECURE_WEBVIEW_PROPS = {
  originWhitelist: [Config.TRUSTED_ORIGIN],
  thirdPartyCookiesEnabled: false,
  allowFileAccess: false,
  allowFileAccessFromFileURLs: false,
  allowUniversalAccessFromFileURLs: false,
  mixedContentMode: 'never' as const,
  setSupportMultipleWindows: false,
  onShouldStartLoadWithRequest: allowTrustedWebViewNavigation,
};
