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
import { productTheme } from '../src/theme/glasses';

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
        accessibilityRole="button"
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
        <Pressable
          style={styles.refreshButton}
          onPress={audioRouting.refreshRoute}
          accessibilityRole="button"
          accessibilityLabel="Refresh audio route"
        >
          <Text style={styles.refreshButtonText}>Refresh route</Text>
        </Pressable>
      </View>

      <View style={styles.magicStrip}>
        <Text style={styles.magicStripLabel}>Glasses session</Text>
        <Text style={styles.magicStripText}>{glassesSession.phase.replace(/_/g, ' ')}</Text>
        <View style={styles.magicStripActions}>
          <Pressable
            style={styles.magicStripButton}
            onPress={glassesSession.rehearseVoiceOnly}
            disabled={glassesSession.isBusy}
            accessibilityRole="button"
            accessibilityLabel="Rehearse voice"
          >
            <Text style={styles.magicStripButtonText}>Rehearse voice</Text>
          </Pressable>
          <Pressable
            style={styles.magicStripButton}
            onPress={glassesSession.runQuickVision}
            disabled={glassesSession.isBusy}
            accessibilityRole="button"
            accessibilityLabel="Quick vision"
          >
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
    backgroundColor: productTheme.colors.canvas,
    alignItems: 'center',
    justifyContent: 'center',
  },
  settingsButton: {
    position: 'absolute',
    top: 60,
    right: 24,
    minWidth: 44,
    minHeight: 44,
    padding: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  routeCard: {
    position: 'absolute',
    top: 116,
    left: 20,
    right: 20,
    backgroundColor: productTheme.colors.surface,
    borderWidth: 1,
    borderColor: productTheme.colors.borderStrong,
    borderRadius: productTheme.radius.card,
    padding: 14,
    gap: 6,
  },
  routeEyebrow: {
    color: productTheme.colors.textQuiet,
    fontSize: productTheme.typography.eyebrow.fontSize,
    fontWeight: productTheme.typography.eyebrow.fontWeight,
    letterSpacing: productTheme.typography.eyebrow.letterSpacing,
    textTransform: 'uppercase',
  },
  routeStatus: {
    color: productTheme.colors.textPrimary,
    fontSize: 15,
    fontWeight: '700',
  },
  routeLine: {
    color: productTheme.colors.textSoft,
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
    borderRadius: productTheme.radius.pill,
    paddingVertical: 4,
    paddingHorizontal: 8,
    fontSize: 11,
    fontWeight: '700',
    overflow: 'hidden',
  },
  routeFactGood: {
    color: productTheme.colors.status.successText,
    backgroundColor: productTheme.colors.status.successFill,
  },
  routeFactWarn: {
    color: productTheme.colors.status.warningText,
    backgroundColor: productTheme.colors.status.warningFill,
  },
  routeError: {
    color: productTheme.colors.status.errorText,
    fontSize: 12,
  },
  refreshButton: {
    alignSelf: 'flex-start',
    borderRadius: productTheme.radius.pill,
    borderWidth: 1,
    borderColor: productTheme.colors.borderMuted,
    paddingVertical: 6,
    paddingHorizontal: 10,
    marginTop: 2,
    minHeight: 44,
    justifyContent: 'center',
  },
  refreshButtonText: {
    color: productTheme.colors.textSubtle,
    fontSize: 12,
    fontWeight: '600',
  },
  magicStrip: {
    position: 'absolute',
    bottom: 44,
    left: 20,
    right: 20,
    backgroundColor: productTheme.colors.surface,
    borderWidth: 1,
    borderColor: productTheme.colors.borderStrong,
    borderRadius: productTheme.radius.card,
    padding: 12,
    gap: 6,
  },
  magicStripLabel: {
    color: productTheme.colors.textQuiet,
    fontSize: productTheme.typography.eyebrow.fontSize,
    fontWeight: productTheme.typography.eyebrow.fontWeight,
    letterSpacing: productTheme.typography.eyebrow.letterSpacing,
    textTransform: 'uppercase',
  },
  magicStripText: {
    color: productTheme.colors.textPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  magicStripActions: {
    flexDirection: 'row',
    gap: 8,
  },
  magicStripButton: {
    borderRadius: productTheme.radius.pill,
    borderWidth: 1,
    borderColor: productTheme.colors.borderMuted,
    paddingVertical: 7,
    paddingHorizontal: 10,
    minHeight: 44,
    justifyContent: 'center',
  },
  magicStripButtonText: {
    color: productTheme.colors.textSubtle,
    fontSize: 12,
    fontWeight: '600',
  },
  voiceError: {
    color: productTheme.colors.status.errorText,
    fontSize: 12,
    textAlign: 'center',
    paddingHorizontal: 24,
    marginBottom: 16,
  },
  settingsIcon: {
    fontSize: 24,
    color: productTheme.colors.textFaint,
  },
});
