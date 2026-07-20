import React from 'react';
import { StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';
import Config from '../src/config';
import { Logger } from '../src/lib/logger';
import { glassesTheme } from '../src/theme/glasses';
import { AGENT_NATIVE_MARKER_SCRIPT, AGENT_WEBVIEW_USER_AGENT_SUFFIX } from '../src/lib/webview-native-marker';
import { SECURE_WEBVIEW_PROPS } from '../src/lib/webview-security';

export default function ProScreen() {
  return (
    <WebView
      {...SECURE_WEBVIEW_PROPS}
      source={{ uri: Config.SERVER_URL }}
      sharedCookiesEnabled
      injectedJavaScriptBeforeContentLoaded={AGENT_NATIVE_MARKER_SCRIPT}
      applicationNameForUserAgent={AGENT_WEBVIEW_USER_AGENT_SUFFIX}
      style={styles.webview}
      allowsBackForwardNavigationGestures
      javaScriptEnabled
      domStorageEnabled
      onError={() => Logger.error('Pro', 'WebView load failed')}
    />
  );
}

const styles = StyleSheet.create({
  webview: {
    flex: 1,
    backgroundColor: glassesTheme.colors.canvas,
  },
});
