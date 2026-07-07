import React, { useState, useCallback } from 'react';
import { View, Pressable, Text, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useKeepAwake } from 'expo-keep-awake';
import { StatusIndicator } from '../src/components/status-indicator';
import { SessionButton } from '../src/components/session-button';
import { useAudioRouting } from '../src/hooks/use-audio-routing';
import { useVoiceSession } from '../src/contexts/voice-session';
import { useGlassesAgentSession } from '../src/contexts/glasses-agent-session';
import { VoiceDiagnostics } from '../src/components/voice-diagnostics';

/**
 * Voice screen — demoted from default to /voice route.
 * Still fully functional for voice-first interaction.
 */
export default function VoiceScreen() {
  const { status, isSpeaking, toggle, error } = useVoiceSession();
  const glassesSession = useGlassesAgentSession();
  const router = useRouter();
  const [showDiag, setShowDiag] = useState(false);
  const openDiag = useCallback(() => setShowDiag(true), []);
  const closeDiag = useCallback(() => setShowDiag(false), []);

  useKeepAwake();
  const audioRouting = useAudioRouting();

  return (
    <View style={styles.container}>
      <Pressable
        style={styles.settingsButton}
        onPress={() => router.push('/settings')}
        accessibilityLabel="Settings"
      >
        <Text style={styles.settingsIcon}>⚙</Text>
      </Pressable>

      <View style={styles.routeCard}>
        <Text style={styles.routeEyebrow}>Audio route</Text>
        <Text style={styles.routeStatus}>{formatRouteStatus(audioRouting.status)}</Text>
        <Text style={styles.routeLine}>Input: {audioRouting.route.input}</Text>
        <Text style={styles.routeLine}>Output: {audioRouting.route.output}</Text>
        <View style={styles.routeFacts}>
          <Text style={[styles.routeFact, audioRouting.isGlassesInput ? styles.routeFactGood : styles.routeFactWarn]}>
            Glasses mic: {audioRouting.isGlassesInput ? 'yes' : 'no'}
          </Text>
          <Text style={[styles.routeFact, audioRouting.isGlassesOutput ? styles.routeFactGood : styles.routeFactWarn]}>
            Glasses audio: {audioRouting.isGlassesOutput ? 'yes' : 'no'}
          </Text>
        </View>
        {audioRouting.error ? <Text style={styles.routeError}>{audioRouting.error}</Text> : null}
        <Pressable style={styles.refreshButton} onPress={audioRouting.refreshRoute}>
          <Text style={styles.refreshButtonText}>Refresh route</Text>
        </Pressable>
      </View>

      <View style={styles.magicStrip}>
        <Text style={styles.magicStripLabel}>Glasses session</Text>
        <Text style={styles.magicStripText}>{glassesSession.phase.replace(/_/g, ' ')}</Text>
        <View style={styles.magicStripActions}>
          <Pressable style={styles.magicStripButton} onPress={glassesSession.rehearseVoiceOnly} disabled={glassesSession.isBusy}>
            <Text style={styles.magicStripButtonText}>Rehearse voice</Text>
          </Pressable>
          <Pressable style={styles.magicStripButton} onPress={glassesSession.runQuickVision} disabled={glassesSession.isBusy}>
            <Text style={styles.magicStripButtonText}>Quick vision</Text>
          </Pressable>
        </View>
      </View>

      {error ? <Text style={styles.voiceError}>Voice unavailable: {error}</Text> : null}
      <StatusIndicator status={status} isSpeaking={isSpeaking} />
      <SessionButton status={status} onPress={toggle} onLongPress={openDiag} />
      <VoiceDiagnostics visible={showDiag} onClose={closeDiag} />
    </View>
  );
}

function formatRouteStatus(status: ReturnType<typeof useAudioRouting>['status']) {
  if (status === 'loading') return 'Checking native route…';
  if (status === 'error') return 'Route unavailable';
  return 'Native route ready';
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  settingsButton: {
    position: 'absolute',
    top: 60,
    right: 24,
    padding: 8,
  },
  routeCard: {
    position: 'absolute',
    top: 116,
    left: 20,
    right: 20,
    backgroundColor: '#0d0d0d',
    borderWidth: 1,
    borderColor: '#2a2a2a',
    borderRadius: 16,
    padding: 14,
    gap: 6,
  },
  routeEyebrow: {
    color: '#777',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  routeStatus: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  routeLine: {
    color: '#bbb',
    fontSize: 12,
    lineHeight: 17,
  },
  routeFacts: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
    marginTop: 2,
  },
  routeFact: {
    borderRadius: 999,
    paddingVertical: 4,
    paddingHorizontal: 8,
    fontSize: 11,
    fontWeight: '700',
    overflow: 'hidden',
  },
  routeFactGood: {
    color: '#86efac',
    backgroundColor: 'rgba(34, 197, 94, 0.14)',
  },
  routeFactWarn: {
    color: '#fbbf24',
    backgroundColor: 'rgba(245, 158, 11, 0.14)',
  },
  routeError: {
    color: '#f87171',
    fontSize: 12,
  },
  refreshButton: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#333',
    paddingVertical: 6,
    paddingHorizontal: 10,
    marginTop: 2,
  },
  refreshButtonText: {
    color: '#ddd',
    fontSize: 12,
    fontWeight: '600',
  },

  magicStrip: {
    position: 'absolute',
    bottom: 44,
    left: 20,
    right: 20,
    backgroundColor: '#0d0d0d',
    borderWidth: 1,
    borderColor: '#2a2a2a',
    borderRadius: 16,
    padding: 12,
    gap: 6,
  },
  magicStripLabel: {
    color: '#777',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  magicStripText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  magicStripActions: {
    flexDirection: 'row',
    gap: 8,
  },
  magicStripButton: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#333',
    paddingVertical: 7,
    paddingHorizontal: 10,
  },
  magicStripButtonText: {
    color: '#ddd',
    fontSize: 12,
    fontWeight: '600',
  },
  voiceError: {
    color: '#f87171',
    fontSize: 12,
    textAlign: 'center',
    paddingHorizontal: 24,
    marginBottom: 16,
  },
  settingsIcon: {
    fontSize: 24,
    color: '#666',
  },
});
