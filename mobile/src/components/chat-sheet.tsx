import React, { useMemo, useState, useCallback } from 'react';
import { StyleSheet, ActivityIndicator, View } from 'react-native';
import BottomSheet from '@gorhom/bottom-sheet';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import Config from '../config';
import { Logger } from '../lib/logger';
import { glassesTheme } from '../theme/glasses';
import { AGENT_NATIVE_MARKER_SCRIPT, AGENT_WEBVIEW_USER_AGENT_SUFFIX } from '../lib/webview-native-marker';
import { VoiceDiagnostics } from './voice-diagnostics';

export function ChatSheet({ sheetRef }: { sheetRef: React.RefObject<BottomSheet> }) {
  const snapPoints = useMemo(() => ['90%'], []);
  const [chatReady, setChatReady] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  const handleLoadEnd = useCallback(() => {
    setChatReady(true);
    Logger.debug('ChatSheet', 'WebView loaded');
  }, []);

  const handleError = useCallback(() => {
    Logger.error('ChatSheet', 'WebView load failed');
  }, []);

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      Logger.debug('ChatSheet', 'Bridge message received', { type: data.type });

      if (data.type === 'voice.diagnostics.open') {
        setShowDiagnostics(true);
      }
    } catch (e) {
      Logger.warn('ChatSheet', 'Failed to parse bridge message', {
        raw: event.nativeEvent.data?.slice(0, 100),
      });
    }
  }, []);

  return (
    <>
      <BottomSheet
        ref={sheetRef}
        index={-1}
        snapPoints={snapPoints}
        enablePanDownToClose
        enableContentPanningGesture={false}
        backgroundStyle={styles.sheetBackground}
        handleIndicatorStyle={styles.handleIndicator}
        onChange={(index) => Logger.debug('ChatSheet', 'Sheet index changed', { index })}
      >
        <View style={styles.webviewContainer}>
          {!chatReady && (
            <View style={styles.loadingOverlay}>
              <ActivityIndicator color={glassesTheme.colors.handle} size="small" />
            </View>
          )}
          <WebView
            source={{ uri: `${Config.SERVER_URL}/chat` }}
            sharedCookiesEnabled
            injectedJavaScriptBeforeContentLoaded={AGENT_NATIVE_MARKER_SCRIPT}
            applicationNameForUserAgent={AGENT_WEBVIEW_USER_AGENT_SUFFIX}
            style={styles.webview}
            onLoadEnd={handleLoadEnd}
            onError={handleError}
            onMessage={handleMessage}
            allowsBackForwardNavigationGestures={false}
            javaScriptEnabled
            domStorageEnabled
            startInLoadingState={false}
          />
        </View>
      </BottomSheet>
      <VoiceDiagnostics
        visible={showDiagnostics}
        onClose={() => setShowDiagnostics(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  sheetBackground: {
    backgroundColor: glassesTheme.colors.canvas,
  },
  handleIndicator: {
    backgroundColor: glassesTheme.colors.handle,
  },
  webviewContainer: {
    flex: 1,
  },
  webview: {
    flex: 1,
    backgroundColor: glassesTheme.colors.canvas,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: glassesTheme.colors.canvas,
    zIndex: 1,
  },
});
