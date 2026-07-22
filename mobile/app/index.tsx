import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, StyleSheet, View } from 'react-native';
import * as Contacts from 'expo-contacts';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import WebView, { type WebViewMessageEvent } from 'react-native-webview';
import Config from '../src/config';
import { DebugOverlay } from '../src/components/debug-overlay';
import { VoiceDiagnostics } from '../src/components/voice-diagnostics';
import { Logger } from '../src/lib/logger';
import { glassesTheme } from '../src/theme/glasses';
import { AGENT_NATIVE_MARKER_SCRIPT, AGENT_WEBVIEW_USER_AGENT_SUFFIX } from '../src/lib/webview-native-marker';
import { SECURE_WEBVIEW_PROPS } from '../src/lib/webview-security';
import {
  isWebToNativeVoiceMessage,
  type NativeToWebVoiceMessage,
  type WebToNativeVoiceMessage,
} from '../src/lib/voice-bridge';
import { useVoiceSession } from '../src/contexts/voice-session';
import { startThinkingAudioLoop, stopThinkingAudioLoop, unloadThinkingAudioLoop } from '../src/lib/thinking-audio';

const LOG_TAG = 'PrimaryScreen';

type IosContactImportPayload = {
  sourceId: string;
  displayName?: string;
  givenName?: string;
  middleName?: string;
  familyName?: string;
  nickname?: string;
  maidenName?: string;
  phoneticGivenName?: string;
  phoneticMiddleName?: string;
  phoneticFamilyName?: string;
  emails?: string[];
  phones?: string[];
  company?: string;
  jobTitle?: string;
  department?: string;
  addresses?: Array<Record<string, unknown>>;
  urls?: Array<Record<string, unknown>>;
  dates?: Array<Record<string, unknown>>;
  birthday?: Record<string, unknown>;
  rawContactHash?: string;
};

function stableContactHash(value: unknown): string {
  const raw = JSON.stringify(value);
  let hash = 0;
  for (let index = 0; index < raw.length; index += 1) {
    hash = ((hash << 5) - hash + raw.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function extractContactPayload(contact: Contacts.Contact): IosContactImportPayload | null {
  const emails = (contact.emails || [])
    .map((entry) => entry.email?.trim().toLowerCase())
    .filter((email): email is string => Boolean(email));
  const phones = (contact.phoneNumbers || [])
    .map((entry) => entry.number?.trim())
    .filter((phone): phone is string => Boolean(phone));

  if (emails.length === 0 && phones.length === 0) return null;

  const source = {
    id: contact.id,
    name: contact.name,
    firstName: contact.firstName,
    middleName: contact.middleName,
    lastName: contact.lastName,
    nickname: contact.nickname,
    maidenName: contact.maidenName,
    phoneticFirstName: contact.phoneticFirstName,
    phoneticMiddleName: contact.phoneticMiddleName,
    phoneticLastName: contact.phoneticLastName,
    emails,
    phones,
    company: contact.company,
    jobTitle: contact.jobTitle,
    department: contact.department,
    addresses: contact.addresses,
    urlAddresses: contact.urlAddresses,
    dates: contact.dates,
    birthday: contact.birthday,
  };

  return {
    sourceId: contact.id,
    displayName: contact.name || [contact.firstName, contact.lastName].filter(Boolean).join(' ') || emails[0] || phones[0],
    givenName: contact.firstName || undefined,
    middleName: contact.middleName || undefined,
    familyName: contact.lastName || undefined,
    nickname: contact.nickname || undefined,
    maidenName: contact.maidenName || undefined,
    phoneticGivenName: contact.phoneticFirstName || undefined,
    phoneticMiddleName: contact.phoneticMiddleName || undefined,
    phoneticFamilyName: contact.phoneticLastName || undefined,
    emails,
    phones,
    company: contact.company || undefined,
    jobTitle: contact.jobTitle || undefined,
    department: contact.department || undefined,
    addresses: contact.addresses as Array<Record<string, unknown>> | undefined,
    urls: contact.urlAddresses as Array<Record<string, unknown>> | undefined,
    dates: contact.dates as Array<Record<string, unknown>> | undefined,
    birthday: contact.birthday as Record<string, unknown> | undefined,
    rawContactHash: stableContactHash(source),
  };
}


export default function PrimaryScreen() {
  const insets = useSafeAreaInsets();
  const webViewRef = useRef<WebView>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [debugVisible, setDebugVisible] = useState(false);
  const [diagVisible, setDiagVisible] = useState(false);
  const hasRequestedVoicePreloadRef = useRef(false);
  const contactImportResolversRef = useRef(new Map<string, {
    resolve: (summary: { imported?: number; skipped?: number }) => void;
    reject: (error: Error) => void;
  }>());
  const voiceSession = useVoiceSession();

  /** Send a typed voice message from native into the WebView. */
  const sendToWebView = useCallback((msg: NativeToWebVoiceMessage) => {
    const js = `window.dispatchEvent(new MessageEvent('native-voice',{data:${JSON.stringify(JSON.stringify(msg))}}));true;`;
    webViewRef.current?.injectJavaScript(js);
  }, []);

  const sendContactsToServer = useCallback((contacts: IosContactImportPayload[]) => new Promise<{ imported?: number; skipped?: number }>((resolve, reject) => {
    const requestId = `contacts-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    contactImportResolversRef.current.set(requestId, { resolve, reject });

    const script = `
      (async function() {
        try {
          const response = await fetch('/api/import-queue/ios-contacts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: ${JSON.stringify(JSON.stringify({ contacts }))}
          });
          const body = await response.json().catch(() => ({}));
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'contacts.import.result',
            requestId: ${JSON.stringify(requestId)},
            ok: response.ok,
            status: response.status,
            body
          }));
        } catch (error) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'contacts.import.result',
            requestId: ${JSON.stringify(requestId)},
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          }));
        }
      })(); true;
    `;

    webViewRef.current?.injectJavaScript(script);

    setTimeout(() => {
      const pending = contactImportResolversRef.current.get(requestId);
      if (!pending) return;
      contactImportResolversRef.current.delete(requestId);
      pending.reject(new Error('Timed out staging iOS contacts.'));
    }, 30000);
  }), []);

  const handleContactsImportRequest = useCallback(async () => {
    try {
      Logger.info(LOG_TAG, 'iOS contacts import requested');
      const permission = await Contacts.requestPermissionsAsync();
      if (permission.status !== Contacts.PermissionStatus.GRANTED) {
        Alert.alert('Contacts access needed', 'Allow contacts access to import iOS contacts into the People import queue.');
        return;
      }

      const result = await Contacts.getContactsAsync({
        fields: [
          Contacts.Fields.Name,
          Contacts.Fields.FirstName,
          Contacts.Fields.MiddleName,
          Contacts.Fields.LastName,
          Contacts.Fields.Nickname,
          Contacts.Fields.MaidenName,
          Contacts.Fields.PhoneticFirstName,
          Contacts.Fields.PhoneticMiddleName,
          Contacts.Fields.PhoneticLastName,
          Contacts.Fields.Emails,
          Contacts.Fields.PhoneNumbers,
          Contacts.Fields.Company,
          Contacts.Fields.JobTitle,
          Contacts.Fields.Department,
          Contacts.Fields.Addresses,
          Contacts.Fields.UrlAddresses,
          Contacts.Fields.Dates,
          Contacts.Fields.Birthday,
        ],
        pageSize: 5000,
        pageOffset: 0,
        sort: Contacts.SortTypes.FirstName,
      });

      const contacts = result.data.map(extractContactPayload).filter((contact): contact is IosContactImportPayload => Boolean(contact));
      const skipped = result.data.length - contacts.length;

      Alert.alert(
        'Import iOS Contacts?',
        `Found ${result.data.length.toLocaleString()} contacts. ${contacts.length.toLocaleString()} have email or phone. ${skipped.toLocaleString()} will be skipped.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Import',
            onPress: () => {
              sendContactsToServer(contacts)
                .then((summary) => {
                  Logger.info(LOG_TAG, 'iOS contacts staged', summary);
                  Alert.alert('Contacts staged', `${summary.imported || contacts.length} contacts are now in People import review.`);
                  const js = "window.dispatchEvent(new MessageEvent('native-contacts',{data:" + JSON.stringify(JSON.stringify({ type: 'contacts.import.completed' })) + "}));true;";
                  webViewRef.current?.injectJavaScript(js);
                })
                .catch((error) => {
                  Logger.error(LOG_TAG, 'iOS contacts staging failed', { error: error instanceof Error ? error.message : String(error) });
                  Alert.alert('Import failed', error instanceof Error ? error.message : String(error));
                });
            },
          },
        ],
      );
    } catch (error) {
      Logger.error(LOG_TAG, 'iOS contacts import failed', { error: error instanceof Error ? error.message : String(error) });
      Alert.alert('Import failed', error instanceof Error ? error.message : String(error));
    }
  }, [sendContactsToServer]);

  // ---------------------------------------------------------------------------
  // Bridge listener: forward all voice session events to the WebView
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const unsubscribe = voiceSession.addBridgeListener((event) => {
      Logger.debug(LOG_TAG, 'Forwarding voice event to WebView', { type: event.type });
      if (event.type === 'voice.modeChange' && event.mode === 'speaking') {
        void stopThinkingAudioLoop();
      }
      if (event.type === 'voice.disconnected' || event.type === 'voice.error') {
        void stopThinkingAudioLoop();
      }
      sendToWebView(event);
    });
    return unsubscribe;
  }, [voiceSession, sendToWebView]);

  // ---------------------------------------------------------------------------
  // AppState: log background/foreground transitions for voice sessions.
  // iOS UIBackgroundModes: ["audio"] keeps the native ElevenLabs session alive
  // in the background. No special teardown or reconnection needed.
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      sendToWebView({ type: 'voice.hostState', active: nextState === 'active' });
      if (nextState === 'active') {
        Logger.debug(LOG_TAG, 'App foregrounded');
      } else if (nextState === 'background') {
        Logger.debug(LOG_TAG, 'App backgrounded, native audio session persists');
      }
    });
    return () => subscription.remove();
  }, [sendToWebView]);

  useEffect(() => {
    return () => {
      void unloadThinkingAudioLoop();
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Voice message routing: web client → native voice session
  // ---------------------------------------------------------------------------

  /** Route an incoming voice message from the web client. */
  const handleVoiceMessage = useCallback((msg: WebToNativeVoiceMessage) => {
    switch (msg.type) {
      case 'voice.start': {
        Logger.info(LOG_TAG, 'Voice start requested', {
          sessionId: msg.sessionId,
          hasSignedUrl: Boolean(msg.signedUrl),
          hasAgentId: Boolean(msg.agentId),
        });
        // Prefer signedUrl — it carries the server's pre-configured conversation
        // with full context, system prompt, and tool setup. Fall back to agentId
        // only for the legacy voice.tsx direct path.
        voiceSession.startSessionWithConfig({
          agentId: msg.agentId || Config.ELEVENLABS_AGENT_ID,
          signedUrl: msg.signedUrl,
          voiceId: msg.voiceId,
          sessionId: msg.sessionId,
          chatSessionId: msg.chatSessionId,
          chatSessionKey: msg.chatSessionKey,
        });
        break;
      }

      case 'voice.end':
        Logger.info(LOG_TAG, 'Voice end requested');
        voiceSession.endSession();
        break;

      case 'voice.mute':
        Logger.debug(LOG_TAG, 'Voice mute', { muted: msg.muted });
        voiceSession.setMuted(msg.muted);
        break;

      case 'voice.userActivity':
        voiceSession.sendUserActivity();
        break;

      case 'voice.thinkingAudio':
        if (msg.active) {
          void startThinkingAudioLoop();
        } else {
          void stopThinkingAudioLoop();
        }
        break;
    }
  }, [voiceSession]);

  // ---------------------------------------------------------------------------
  // WebView message handler
  // ---------------------------------------------------------------------------

  const handleWebViewMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const message = JSON.parse(event.nativeEvent.data) as { type?: string };

      // App-level messages (checked before voice bridge, which matches all voice.* prefixes)
      if (message.type === 'agent.debug.toggle') {
        Logger.debug(LOG_TAG, 'Debug overlay toggled from WebView');
        setDebugVisible((visible) => !visible);
        return;
      }

      if (message.type === 'voice.diagnostics.open') {
        Logger.debug(LOG_TAG, 'Voice diagnostics opened from WebView');
        setDiagVisible(true);
        return;
      }

      if (message.type === 'contacts.import.request') {
        void handleContactsImportRequest();
        return;
      }

      if (message.type === 'contacts.import.result') {
        const result = message as { requestId?: string; ok?: boolean; status?: number; body?: { error?: string; imported?: number; skipped?: number }; error?: string };
        const pending = result.requestId ? contactImportResolversRef.current.get(result.requestId) : null;
        if (!pending || !result.requestId) return;
        contactImportResolversRef.current.delete(result.requestId);
        if (result.ok) {
          pending.resolve(result.body || {});
        } else {
          pending.reject(new Error(result.error || result.body?.error || `Import failed: ${result.status || 'unknown'}`));
        }
        return;
      }

      // Voice bridge messages (voice.start, voice.end, voice.mute, voice.userActivity)
      if (isWebToNativeVoiceMessage(message)) {
        handleVoiceMessage(message);
        return;
      }
    } catch (error) {
      Logger.warn(LOG_TAG, 'Ignored malformed WebView message', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [handleContactsImportRequest, handleVoiceMessage]);

  const handleLoadEnd = useCallback(() => {
    setIsLoading(false);
    sendToWebView({ type: 'voice.hostState', active: AppState.currentState === 'active' });
    Logger.debug(LOG_TAG, 'WebView loaded');
  }, [sendToWebView]);

  // Preload the native voice module after the WebView is stable. Do not import
  // @elevenlabs/react-native at app/module startup: LiveKit/WebRTC globals must
  // still initialize inside the guarded lazy-load boundary in VoiceSession.
  useEffect(() => {
    if (isLoading || hasRequestedVoicePreloadRef.current) {
      return;
    }

    hasRequestedVoicePreloadRef.current = true;
    const timer = setTimeout(() => {
      if (AppState.currentState !== 'active') {
        Logger.debug(LOG_TAG, 'Skipping voice preload while app is not active', { state: AppState.currentState });
        hasRequestedVoicePreloadRef.current = false;
        return;
      }

      Logger.debug(LOG_TAG, 'Requesting voice module preload after WebView load');
      voiceSession.preload();
    }, 750);

    return () => clearTimeout(timer);
  }, [isLoading, voiceSession]);

  const handleError = useCallback(() => {
    setIsLoading(false);
    Logger.error(LOG_TAG, 'WebView load failed');
  }, []);

  return (
    <View style={styles.container}>
      <View
        style={[
          styles.safeViewport,
          {
            paddingTop: insets.top,
            paddingBottom: insets.bottom,
          },
        ]}
      >
        <WebView
          {...SECURE_WEBVIEW_PROPS}
          ref={webViewRef}
          source={{ uri: `${Config.SERVER_URL}/home` }}
          sharedCookiesEnabled
          injectedJavaScriptBeforeContentLoaded={AGENT_NATIVE_MARKER_SCRIPT}
          applicationNameForUserAgent={AGENT_WEBVIEW_USER_AGENT_SUFFIX}
          style={styles.webview}
          onLoadEnd={handleLoadEnd}
          onError={handleError}
          onMessage={handleWebViewMessage}
          allowsBackForwardNavigationGestures
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          javaScriptEnabled
          domStorageEnabled
          startInLoadingState={false}
        />
        {isLoading ? (
          <View style={styles.loadingOverlay}>
            <ActivityIndicator color={glassesTheme.colors.handle} size="small" />
          </View>
        ) : null}
      </View>
      <DebugOverlay visible={debugVisible} onClose={() => setDebugVisible(false)} />
      <VoiceDiagnostics visible={diagVisible} onClose={() => setDiagVisible(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: glassesTheme.colors.canvas,
  },
  safeViewport: {
    flex: 1,
    backgroundColor: glassesTheme.colors.canvas,
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
