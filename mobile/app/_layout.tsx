import { useEffect, useRef, useState } from 'react';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { markAppMounted } from '../src/lib/startup-telemetry';
import { initRemoteLogging } from '../src/lib/logger';
import { initSentry } from '../src/lib/sentry';

import { View, StyleSheet, ActivityIndicator } from 'react-native';
import * as Linking from 'expo-linking';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { VoiceSessionProvider, useVoiceSession } from '../src/contexts/voice-session';
import { GlassesAgentSessionProvider, useGlassesAgentSession } from '../src/contexts/glasses-agent-session';
import { InterfaceModeProvider } from '../src/contexts/interface-mode';
import { AuthProvider } from '../src/contexts/auth';
import Config from '../src/config';
import { handleAgentInvocation, parseAgentInvocation } from '../src/lib/agent-invocation';
import { handleDatUrl } from '../modules/agent-native/src';
import { glassesTheme } from '../src/theme/glasses';
import { useDATBridgeService } from '../src/services/dat-bridge-service';
// Initialize Sentry as early as possible to capture startup crashes
initSentry();


function DeepLinkHandler() {
  const { startSession, endSession, status } = useVoiceSession();
  const { rehearseVoiceOnly, runQuickVision } = useGlassesAgentSession();
  const router = useRouter();
  const handledUrls = useRef<Set<string>>(new Set());

  // Always-on DAT bridge polling and auto-setup
  useDATBridgeService();

  useEffect(() => {
    async function handleUrl(event: { url: string }) {
      if (handledUrls.current.has(event.url)) return;
      handledUrls.current.add(event.url);

      const invocation = parseAgentInvocation(event.url);
      if (invocation.action !== 'unknown') {
        handleAgentInvocation(invocation, {
          router,
          status,
          startSession,
          endSession,
          rehearseVoiceOnly,
          runQuickVision,
        });
        return;
      }

      await handleDatUrl(event.url).catch(() => ({ handled: false }));
    }

    Linking.getInitialURL().then((url) => {
      if (url) handleUrl({ url });
    });

    const subscription = Linking.addEventListener('url', handleUrl);
    return () => subscription.remove();
  }, [startSession, endSession, status, router, rehearseVoiceOnly, runQuickVision]);

  return null;
}

/** Auth is handled by the web app inside the WebView — no native gate needed. */
function AuthGate({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

export default function RootLayout() {
  const [configLoaded, setConfigLoaded] = useState(false);

  useEffect(() => {
    Config.load().finally(() => setConfigLoaded(true));
  }, []);

  useEffect(() => {
    if (configLoaded) {
      initRemoteLogging(Config.SERVER_URL);
      markAppMounted();
    }
  }, [configLoaded]);

  if (!configLoaded) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator color={glassesTheme.colors.handle} size="small" />
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={styles.container}>
      <SafeAreaProvider>
        <BottomSheetModalProvider>
          <AuthProvider>
            <VoiceSessionProvider>
              <GlassesAgentSessionProvider>
                <InterfaceModeProvider>
                  <View style={styles.container}>
                    <StatusBar hidden={false} style="light" />
                    <DeepLinkHandler />
                    <AuthGate>
                      <Stack
                        screenOptions={{
                          headerShown: false,
                          contentStyle: { backgroundColor: glassesTheme.colors.canvas },
                          animation: 'fade',
                        }}
                      />
                    </AuthGate>
                  </View>
                </InterfaceModeProvider>
              </GlassesAgentSessionProvider>
            </VoiceSessionProvider>
          </AuthProvider>
        </BottomSheetModalProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: glassesTheme.colors.canvas,
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: glassesTheme.colors.canvas,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
