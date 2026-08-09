import React, { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useKeepAwake } from 'expo-keep-awake';
import { SessionButton } from '../src/components/session-button';
import { StatusIndicator } from '../src/components/status-indicator';
import { VoiceDiagnostics } from '../src/components/voice-diagnostics';
import { useGlassesAgentSession } from '../src/contexts/glasses-agent-session';
import { useVoiceSession } from '../src/contexts/voice-session';
import { useAudioRouting } from '../src/hooks/use-audio-routing';
import { glassesTheme } from '../src/theme/glasses';

export default function VoiceScreen() {
  const { status, isSpeaking, toggle, error } = useVoiceSession();
  const glassesSession = useGlassesAgentSession();
  const router = useRouter();
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const openDiagnostics = useCallback(() => setShowDiagnostics(true), []);
  const closeDiagnostics = useCallback(() => setShowDiagnostics(false), []);

  useKeepAwake();
  const audioRouting = useAudioRouting();

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Pressable
        style={styles.settingsButton}
        onPress={() => router.push('/settings')}
        accessibilityLabel="Open settings"
        accessibilityRole="button"
      >
        <Text style={styles.settingsIcon}>⚙</Text>
      </Pressable>

      <View style={styles.statusArea}>
        {error ? <Text style={styles.voiceError}>Voice unavailable: {error}</Text> : null}
        <StatusIndicator status={status} isSpeaking={isSpeaking} />
        <SessionButton status={status} onPress={toggle} onLongPress={openDiagnostics} />
      </View>

      <View style={styles.detailStack}>
        <View style={styles.surface}>
          <Text style={styles.sectionLabel}>Audio route</Text>
          <Text style={styles.surfaceTitle}>{formatRouteStatus(audioRouting.status)}</Text>
          <Text style={styles.secondaryText}>Input: {audioRouting.route.input}</Text>
          <Text style={styles.secondaryText}>Output: {audioRouting.route.output}</Text>
          <View style={styles.factRow}>
            <Text style={[styles.fact, audioRouting.isGlassesInput ? styles.factSuccess : styles.factWarning]}>
              Glasses mic: {audioRouting.isGlassesInput ? 'yes' : 'no'}
            </Text>
            <Text style={[styles.fact, audioRouting.isGlassesOutput ? styles.factSuccess : styles.factWarning]}>
              Glasses audio: {audioRouting.isGlassesOutput ? 'yes' : 'no'}
            </Text>
          </View>
          {audioRouting.error ? <Text style={styles.errorText}>{audioRouting.error}</Text> : null}
          <SecondaryAction label="Refresh route" onPress={audioRouting.refreshRoute} />
        </View>

        <View style={styles.surface}>
          <Text style={styles.sectionLabel}>Glasses session</Text>
          <Text style={styles.surfaceTitle}>{glassesSession.phase.replace(/_/g, ' ')}</Text>
          <View style={styles.actionRow}>
            <SecondaryAction label="Rehearse voice" onPress={glassesSession.rehearseVoiceOnly} disabled={glassesSession.isBusy} />
            <SecondaryAction label="Quick vision" onPress={glassesSession.runQuickVision} disabled={glassesSession.isBusy} />
          </View>
        </View>
      </View>

      <VoiceDiagnostics visible={showDiagnostics} onClose={closeDiagnostics} />
    </ScrollView>
  );
}

interface SecondaryActionProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}

function SecondaryAction({ label, onPress, disabled = false }: SecondaryActionProps) {
  return (
    <Pressable
      style={({ pressed }) => [styles.secondaryAction, pressed && styles.pressed, disabled && styles.disabled]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
    >
      <Text style={styles.secondaryActionText}>{label}</Text>
    </Pressable>
  );
}

function formatRouteStatus(status: ReturnType<typeof useAudioRouting>['status']) {
  if (status === 'loading') return 'Checking native route…';
  if (status === 'error') return 'Route unavailable';
  return 'Native route ready';
}

const styles = StyleSheet.create({
  container: {
    minHeight: '100%',
    backgroundColor: glassesTheme.colors.canvas,
    paddingTop: 64,
    paddingBottom: 32,
    paddingHorizontal: 20,
    gap: 28,
  },
  settingsButton: {
    position: 'absolute',
    top: 52,
    right: 16,
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
  settingsIcon: {
    color: glassesTheme.colors.textSecondary,
    fontSize: 22,
  },
  statusArea: {
    alignItems: 'center',
    gap: 20,
    paddingTop: 32,
  },
  voiceError: {
    color: glassesTheme.colors.status.error,
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
  },
  detailStack: {
    gap: 16,
  },
  surface: {
    minWidth: 0,
    overflow: 'hidden',
    backgroundColor: glassesTheme.colors.surface,
    borderWidth: 1,
    borderColor: glassesTheme.colors.borderChrome,
    borderRadius: glassesTheme.radius.card,
    padding: 16,
    gap: 8,
  },
  sectionLabel: {
    color: glassesTheme.colors.textTertiary,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  surfaceTitle: {
    color: glassesTheme.colors.textPrimary,
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryText: {
    color: glassesTheme.colors.textSecondary,
    fontSize: 14,
    lineHeight: 21,
  },
  factRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  fact: {
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 10,
    fontSize: 12,
    fontWeight: '600',
    overflow: 'hidden',
  },
  factSuccess: {
    color: glassesTheme.colors.status.success,
    backgroundColor: glassesTheme.colors.statusTint.success,
  },
  factWarning: {
    color: glassesTheme.colors.status.warning,
    backgroundColor: glassesTheme.colors.statusTint.warning,
  },
  errorText: {
    color: glassesTheme.colors.status.error,
    fontSize: 14,
    lineHeight: 21,
  },
  actionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  secondaryAction: {
    minHeight: 44,
    justifyContent: 'center',
    borderRadius: glassesTheme.radius.button,
    borderWidth: 1,
    borderColor: glassesTheme.colors.borderChrome,
    backgroundColor: glassesTheme.colors.actionSecondary,
    paddingHorizontal: 14,
  },
  secondaryActionText: {
    color: glassesTheme.colors.textPrimary,
    fontSize: 14,
    fontWeight: '600',
  },
  pressed: {
    opacity: 0.75,
  },
  disabled: {
    opacity: 0.45,
  },
});
