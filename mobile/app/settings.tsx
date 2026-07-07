import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { router } from 'expo-router';
import Config, { BACKEND_TARGETS, type BackendTarget } from '../src/config';
import { Logger } from '../src/lib/logger';
import {
  copyRouteEvidence,
  getNativeEnvironment,
  playTestTone,
  selectHfpInput,
  startAudioRouteObservers,
  type AudioPlaybackResult,
  type AudioRouteDiagnostics,
  type AudioSampleResult,
  type HfpSelectionResult,
  type NativeEnvironment,
} from '../src/native/glasses-capabilities';
import { useAudioRouting } from '../src/hooks/use-audio-routing';

export default function SettingsScreen() {
  const [agentId, setAgentId] = useState('');
  const [backendTarget, setBackendTarget] = useState<BackendTarget>('production');
  const [customServerUrl, setCustomServerUrl] = useState('');
  const [nativeEnvironment, setNativeEnvironment] = useState<NativeEnvironment | null>(null);
  const [audioDiagnostics, setAudioDiagnostics] = useState<AudioRouteDiagnostics | null>(null);
  const [hfpSelection, setHfpSelection] = useState<HfpSelectionResult | null>(null);
  const [sampleResult, setSampleResult] = useState<AudioSampleResult | null>(null);
  const [playbackResult, setPlaybackResult] = useState<AudioPlaybackResult | null>(null);
  const [nativeError, setNativeError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const audioRouting = useAudioRouting();

  useEffect(() => {
    Config.load().then(() => {
      setAgentId(Config.ELEVENLABS_AGENT_ID);
      setBackendTarget(Config.BACKEND_TARGET);
      setCustomServerUrl(Config.CUSTOM_SERVER_URL);
    });
  }, []);

  const save = async () => {
    await Config.set('ELEVENLABS_AGENT_ID', agentId.trim());
    await Config.set('BACKEND_TARGET', backendTarget);
    await Config.set('CUSTOM_SERVER_URL', customServerUrl.trim());
    Alert.alert('Saved', 'Configuration updated.', [
      { text: 'OK', onPress: () => router.back() },
    ]);
  };

  const reset = async () => {
    await Config.reset();
    await Config.load();
    setAgentId(Config.ELEVENLABS_AGENT_ID);
    setBackendTarget(Config.BACKEND_TARGET);
    setCustomServerUrl(Config.CUSTOM_SERVER_URL);
    Alert.alert('Reset', 'Configuration reset to defaults.');
  };

  const runNativeAction = async <T,>(actionName: string, action: () => Promise<T>) => {
    setBusyAction(actionName);
    setNativeError(null);

    try {
      return await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : `Unknown ${actionName} error`;
      setNativeError(message);
      Logger.error('NativeDiagnostics', `${actionName} failed`, { message });
      return null;
    } finally {
      setBusyAction(null);
    }
  };

  const checkNativeEnvironment = async () => {
    const environment = await runNativeAction('native environment check', getNativeEnvironment);
    if (!environment) return;

    setNativeEnvironment(environment);
    Logger.log('NativeDiagnostics', 'Glasses native capabilities loaded', environment);
  };

  const refreshAudioDiagnostics = async () => {
    const diagnostics = await runNativeAction('audio route diagnostics', audioRouting.refreshRoute);
    if (!diagnostics) return;

    setAudioDiagnostics(diagnostics);
    Logger.log('NativeDiagnostics', 'Audio route diagnostics captured', diagnostics);
  };

  const startObservers = async () => {
    const diagnostics = await runNativeAction('audio route observers', startAudioRouteObservers);
    if (!diagnostics) return;

    setAudioDiagnostics(diagnostics);
    Logger.log('NativeDiagnostics', 'Audio route observers active', diagnostics);
  };

  const selectHfp = async () => {
    const result = await runNativeAction('HFP input selection', selectHfpInput);
    if (!result) return;

    setHfpSelection(result);
    setAudioDiagnostics(result.diagnostics);
    Logger.log('NativeDiagnostics', 'HFP input selection completed', result);
  };

  const recordSample = async () => {
    const result = await runNativeAction('10-second audio sample', audioRouting.recordDiagnosticSample);
    if (!result) return;

    setSampleResult(result);
    setAudioDiagnostics(result.diagnostics);
    Logger.log('NativeDiagnostics', '10-second audio sample recorded', result);
  };

  const playSample = async () => {
    const result = await runNativeAction('sample playback', audioRouting.playDiagnosticSample);
    if (!result) return;

    setPlaybackResult(result);
    Logger.log('NativeDiagnostics', 'Sample playback started', result);
  };

  const playTone = async () => {
    const result = await runNativeAction('test tone playback', playTestTone);
    if (!result) return;

    setPlaybackResult(result);
    Logger.log('NativeDiagnostics', 'Test tone playback started', result);
  };

  const copyEvidence = async () => {
    const evidence = buildRouteEvidence({
      nativeEnvironment,
      audioDiagnostics,
      hfpSelection,
      sampleResult,
      playbackResult,
    });

    const result = await runNativeAction('route evidence copy', () => copyRouteEvidence(evidence));
    if (!result?.copied) return;

    Logger.log('NativeDiagnostics', 'Route evidence copied', { bytes: evidence.length });
    Alert.alert('Copied', 'Route evidence copied to clipboard.');
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Pressable onPress={() => router.back()}>
            <Text style={styles.backButton}>← Back</Text>
          </Pressable>
          <Text style={styles.title}>Settings</Text>
        </View>

        <View style={styles.form}>
          <Text style={styles.label}>ElevenLabs Agent ID</Text>
          <TextInput
            style={styles.input}
            value={agentId}
            onChangeText={setAgentId}
            placeholder="Agent ID"
            placeholderTextColor="#666"
            autoCapitalize="none"
            autoCorrect={false}
          />

          <Text style={styles.label}>Backend Target</Text>
          <View style={styles.targetGrid}>
            <TargetButton
              label="Production"
              description={BACKEND_TARGETS.production}
              selected={backendTarget === 'production'}
              onPress={() => setBackendTarget('production')}
            />
            <TargetButton
              label="Development"
              description={BACKEND_TARGETS.development}
              selected={backendTarget === 'development'}
              onPress={() => setBackendTarget('development')}
            />
            <TargetButton
              label="Custom"
              description={customServerUrl || 'Set a custom HTTPS backend'}
              selected={backendTarget === 'custom'}
              onPress={() => setBackendTarget('custom')}
            />
          </View>

          {backendTarget === 'custom' ? (
            <>
              <Text style={styles.label}>Custom Server URL</Text>
              <TextInput
                style={styles.input}
                value={customServerUrl}
                onChangeText={setCustomServerUrl}
                placeholder="https://example.up.railway.app"
                placeholderTextColor="#666"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />
            </>
          ) : null}

          <Text style={styles.activeUrl}>Active backend: {resolveBackendUrl(backendTarget, customServerUrl)}</Text>

          <Pressable style={styles.saveButton} onPress={save}>
            <Text style={styles.saveText}>Save</Text>
          </Pressable>

          <Pressable style={styles.resetButton} onPress={reset}>
            <Text style={styles.resetText}>Reset to Defaults</Text>
          </Pressable>

          {__DEV__ ? (
            <View style={styles.diagnosticCard}>
              <Text style={styles.diagnosticTitle}>Glasses diagnostics</Text>
              <Text style={styles.diagnosticDescription}>
                Proves Swift loading and Bluetooth HFP audio routing in the development build. Phone mic fallback is explicit when no HFP input is available.
              </Text>

              <View style={styles.routeOverview}>
                <Text style={styles.sectionTitle}>Live route facts</Text>
                <DiagnosticLine label="Status" value={audioRouting.status} />
                <DiagnosticLine label="Input" value={audioRouting.route.input} />
                <DiagnosticLine label="Output" value={audioRouting.route.output} />
                <DiagnosticLine label="Glasses mic" value={audioRouting.isGlassesInput ? 'yes' : 'no'} />
                <DiagnosticLine label="Glasses audio" value={audioRouting.isGlassesOutput ? 'yes' : 'no'} />
                {audioRouting.error ? <Text style={styles.diagnosticError}>{audioRouting.error}</Text> : null}
              </View>

              <View style={styles.buttonGrid}>
                <DiagnosticButton label="Check native" actionKey="native environment check" busyAction={busyAction} onPress={checkNativeEnvironment} />
                <DiagnosticButton label="Start observers" actionKey="audio route observers" busyAction={busyAction} onPress={startObservers} />
                <DiagnosticButton label="Refresh route" actionKey="audio route diagnostics" busyAction={busyAction} onPress={refreshAudioDiagnostics} />
                <DiagnosticButton label="Select HFP" actionKey="HFP input selection" busyAction={busyAction} onPress={selectHfp} />
                <DiagnosticButton label="Record 10s" actionKey="10-second audio sample" busyAction={busyAction} onPress={recordSample} />
                <DiagnosticButton label="Play sample" actionKey="sample playback" busyAction={busyAction} onPress={playSample} />
                <DiagnosticButton label="Play tone" actionKey="test tone playback" busyAction={busyAction} onPress={playTone} />
                <DiagnosticButton label="Copy evidence" actionKey="route evidence copy" busyAction={busyAction} onPress={copyEvidence} />
              </View>

              {nativeEnvironment ? (
                <View style={styles.diagnosticResult}>
                  <Text style={styles.sectionTitle}>Native capabilities</Text>
                  <DiagnosticLine label="Platform" value={nativeEnvironment.platform} />
                  <DiagnosticLine label="Loaded" value={String(nativeEnvironment.moduleLoaded)} />
                  <DiagnosticLine label="Bundle" value={nativeEnvironment.bundleIdentifier ?? 'unknown'} />
                  <DiagnosticLine label="App" value={nativeEnvironment.appName ?? 'unknown'} />
                  <DiagnosticLine label="Timestamp" value={nativeEnvironment.timestamp} />
                </View>
              ) : null}

              {audioDiagnostics ? (
                <View style={styles.diagnosticResult}>
                  <Text style={styles.sectionTitle}>Audio route</Text>
                  <DiagnosticLine label="Category" value={audioDiagnostics.category} />
                  <DiagnosticLine label="Mode" value={audioDiagnostics.mode} />
                  <DiagnosticLine label="Options" value={audioDiagnostics.categoryOptions.join(', ') || 'none'} />
                  <DiagnosticLine label="Sample rate" value={`${audioDiagnostics.sampleRate} Hz`} />
                  <DiagnosticLine label="IO buffer" value={`${audioDiagnostics.ioBufferDuration}s`} />
                  <DiagnosticLine label="HFP candidate" value={audioDiagnostics.hfpCandidate ? `${audioDiagnostics.hfpCandidate.name} (${audioDiagnostics.hfpCandidate.portType})` : 'none'} />
                  <DiagnosticLine label="Fallback" value={audioDiagnostics.phoneMicFallbackExplicit ? 'phone mic explicit' : 'not needed'} />
                  <DiagnosticLine label="Current input" value={formatPorts(audioDiagnostics.currentInputs)} />
                  <DiagnosticLine label="Current output" value={formatPorts(audioDiagnostics.currentOutputs)} />
                  <DiagnosticLine label="Available inputs" value={formatPorts(audioDiagnostics.availableInputs)} />
                  <DiagnosticLine label="Events" value={audioDiagnostics.recentEvents.length ? `${audioDiagnostics.recentEvents.length} captured` : 'none yet'} />
                </View>
              ) : null}

              {hfpSelection ? (
                <View style={styles.diagnosticResult}>
                  <Text style={styles.sectionTitle}>HFP selection</Text>
                  <DiagnosticLine label="Selected" value={String(hfpSelection.selected)} />
                  <DiagnosticLine label="Fallback" value={hfpSelection.fallback} />
                  <DiagnosticLine label="Input" value={hfpSelection.selectedInput ? `${hfpSelection.selectedInput.name} (${hfpSelection.selectedInput.portType})` : 'none'} />
                </View>
              ) : null}

              {sampleResult ? (
                <View style={styles.diagnosticResult}>
                  <Text style={styles.sectionTitle}>Recorded sample</Text>
                  <DiagnosticLine label="Duration" value={`${sampleResult.durationSeconds}s`} />
                  <DiagnosticLine label="File" value={sampleResult.fileUrl} />
                  <DiagnosticLine label="Finished" value={sampleResult.finishedAt} />
                </View>
              ) : null}

              {playbackResult ? (
                <View style={styles.diagnosticResult}>
                  <Text style={styles.sectionTitle}>Playback</Text>
                  <DiagnosticLine label="Source" value={playbackResult.source} />
                  <DiagnosticLine label="Played" value={String(playbackResult.played)} />
                </View>
              ) : null}

              {nativeError ? <Text style={styles.diagnosticError}>{nativeError}</Text> : null}
            </View>
          ) : null}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

type DiagnosticButtonProps = {
  label: string;
  actionKey: string;
  busyAction: string | null;
  onPress: () => void;
};

type TargetButtonProps = {
  label: string;
  description: string;
  selected: boolean;
  onPress: () => void;
};

function TargetButton({ label, description, selected, onPress }: TargetButtonProps) {
  return (
    <Pressable
      style={[styles.targetButton, selected ? styles.targetButtonSelected : null]}
      onPress={onPress}
    >
      <Text style={styles.targetButtonLabel}>{label}</Text>
      <Text style={styles.targetButtonDescription}>{description}</Text>
    </Pressable>
  );
}

function resolveBackendUrl(target: BackendTarget, customServerUrl: string) {
  if (target === 'custom') return customServerUrl.trim().replace(/\/+$/, '') || BACKEND_TARGETS.production;
  return BACKEND_TARGETS[target];
}

function DiagnosticButton({ label, actionKey, busyAction, onPress }: DiagnosticButtonProps) {
  const isBusy = busyAction === actionKey;
  const isDisabled = busyAction !== null;

  return (
    <Pressable
      style={[styles.diagnosticButton, isDisabled ? styles.diagnosticButtonDisabled : null]}
      onPress={onPress}
      disabled={isDisabled}
    >
      <Text style={styles.diagnosticButtonText}>{isBusy ? 'Working…' : label}</Text>
    </Pressable>
  );
}

function DiagnosticLine({ label, value }: { label: string; value: string }) {
  return <Text style={styles.diagnosticLine}>{label}: {value}</Text>;
}

function formatPorts(ports: { name: string; portType: string }[]) {
  return ports.length ? ports.map((port) => `${port.name} (${port.portType})`).join(' | ') : 'none';
}

function buildRouteEvidence(payload: {
  nativeEnvironment: NativeEnvironment | null;
  audioDiagnostics: AudioRouteDiagnostics | null;
  hfpSelection: HfpSelectionResult | null;
  sampleResult: AudioSampleResult | null;
  playbackResult: AudioPlaybackResult | null;
}) {
  return JSON.stringify(
    {
      copiedAt: new Date().toISOString(),
      ...payload,
    },
    null,
    2,
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  scrollContent: {
    padding: 20,
    paddingTop: 60,
    paddingBottom: 40,
  },
  header: {
    marginBottom: 40,
  },
  backButton: {
    color: '#3b82f6',
    fontSize: 16,
    marginBottom: 16,
  },
  title: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '700',
  },
  form: {
    gap: 12,
  },
  label: {
    color: '#999',
    fontSize: 14,
    fontWeight: '500',
    marginTop: 8,
  },
  input: {
    backgroundColor: '#1a1a1a',
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 8,
    padding: 14,
    color: '#fff',
    fontSize: 16,
  },
  targetGrid: {
    gap: 8,
  },
  targetButton: {
    backgroundColor: '#111',
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 10,
    padding: 12,
  },
  targetButtonSelected: {
    borderColor: '#3b82f6',
    backgroundColor: '#101827',
  },
  targetButtonLabel: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 4,
  },
  targetButtonDescription: {
    color: '#999',
    fontSize: 12,
    lineHeight: 16,
  },
  activeUrl: {
    color: '#bbb',
    fontSize: 12,
    lineHeight: 17,
  },
  saveButton: {
    backgroundColor: '#3b82f6',
    borderRadius: 8,
    padding: 16,
    alignItems: 'center',
    marginTop: 24,
  },
  saveText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  resetButton: {
    borderRadius: 8,
    padding: 16,
    alignItems: 'center',
  },
  resetText: {
    color: '#666',
    fontSize: 14,
  },
  diagnosticCard: {
    backgroundColor: '#111',
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 12,
    padding: 16,
    marginTop: 24,
    gap: 12,
  },
  diagnosticTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  diagnosticDescription: {
    color: '#999',
    fontSize: 14,
    lineHeight: 20,
  },
  buttonGrid: {
    gap: 8,
  },
  diagnosticButton: {
    backgroundColor: '#222',
    borderWidth: 1,
    borderColor: '#444',
    borderRadius: 8,
    padding: 12,
    alignItems: 'center',
  },
  diagnosticButtonDisabled: {
    opacity: 0.5,
  },
  diagnosticButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  routeOverview: {
    gap: 4,
    backgroundColor: '#0a0a0a',
    borderWidth: 1,
    borderColor: '#2a2a2a',
    borderRadius: 10,
    padding: 12,
  },
  diagnosticResult: {
    gap: 4,
    borderTopWidth: 1,
    borderTopColor: '#222',
    paddingTop: 10,
  },
  sectionTitle: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 2,
  },
  diagnosticLine: {
    color: '#bbb',
    fontSize: 12,
    lineHeight: 17,
  },
  diagnosticError: {
    color: '#f87171',
    fontSize: 12,
  },
});
