import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getAudioRouteDiagnostics,
  playLastSample,
  recordTenSecondSample,
  startAudioRouteObservers,
  type AudioPlaybackResult,
  type AudioRouteDiagnostics,
  type AudioRoutePort,
  type AudioSampleResult,
} from '../../modules/agent-native/src';
import { Logger } from '../lib/logger';

export type AudioRoutingStatus = 'loading' | 'ready' | 'error';

export type AudioRoutingRoute = {
  input: string;
  output: string;
  inputPorts: AudioRoutePort[];
  outputPorts: AudioRoutePort[];
  hfpCandidate?: AudioRoutePort;
  updatedAt?: string;
};

export type AudioRoutingState = {
  route: AudioRoutingRoute;
  status: AudioRoutingStatus;
  isGlassesInput: boolean;
  isGlassesOutput: boolean;
  bluetoothConnected: boolean;
  routeDescription: string;
  diagnostics: AudioRouteDiagnostics | null;
  sampleResult: AudioSampleResult | null;
  playbackResult: AudioPlaybackResult | null;
  error: string | null;
  refreshRoute: () => Promise<AudioRouteDiagnostics | null>;
  recordDiagnosticSample: () => Promise<AudioSampleResult | null>;
  playDiagnosticSample: () => Promise<AudioPlaybackResult | null>;
};

const INITIAL_ROUTE: AudioRoutingRoute = {
  input: 'Unknown input',
  output: 'Unknown output',
  inputPorts: [],
  outputPorts: [],
};

/**
 * Bluetooth HFP audio routing hook.
 *
 * This reads the native AVAudioSession diagnostics exposed by
 * GlassesAudioDiagnostics instead of assuming the ElevenLabs SDK will route
 * correctly. The voice UI can now show actual input/output route facts before
 * Ray starts an Agent session.
 */
export function useAudioRouting(): AudioRoutingState {
  const [diagnostics, setDiagnostics] = useState<AudioRouteDiagnostics | null>(null);
  const [sampleResult, setSampleResult] = useState<AudioSampleResult | null>(null);
  const [playbackResult, setPlaybackResult] = useState<AudioPlaybackResult | null>(null);
  const [status, setStatus] = useState<AudioRoutingStatus>('loading');
  const [error, setError] = useState<string | null>(null);

  const captureDiagnostics = useCallback(async (source: string, action: () => Promise<AudioRouteDiagnostics>) => {
    setError(null);

    try {
      const nextDiagnostics = await action();
      setDiagnostics(nextDiagnostics);
      setStatus('ready');
      Logger.debug('AudioRouting', `${source} completed`, summarizeDiagnostics(nextDiagnostics));
      return nextDiagnostics;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : `${source} failed`;
      setError(message);
      setStatus('error');
      Logger.error('AudioRouting', `${source} failed`, { message });
      return null;
    }
  }, []);

  const refreshRoute = useCallback(async () => {
    return captureDiagnostics('route refresh', getAudioRouteDiagnostics);
  }, [captureDiagnostics]);

  const recordDiagnosticSample = useCallback(async () => {
    setError(null);

    try {
      const result = await recordTenSecondSample();
      setSampleResult(result);
      setDiagnostics(result.diagnostics);
      setStatus('ready');
      Logger.log('AudioRouting', 'diagnostic sample recorded', {
        fileUrl: result.fileUrl,
        durationSeconds: result.durationSeconds,
        ...summarizeDiagnostics(result.diagnostics),
      });
      return result;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'diagnostic sample failed';
      setError(message);
      setStatus('error');
      Logger.error('AudioRouting', 'diagnostic sample failed', { message });
      return null;
    }
  }, []);

  const playDiagnosticSample = useCallback(async () => {
    setError(null);

    try {
      const result = await playLastSample();
      setPlaybackResult(result);
      Logger.log('AudioRouting', 'diagnostic sample playback started', result);
      return result;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'diagnostic sample playback failed';
      setError(message);
      setStatus('error');
      Logger.error('AudioRouting', 'diagnostic sample playback failed', { message });
      return null;
    }
  }, []);

  useEffect(() => {
    let isMounted = true;

    setStatus('loading');
    startAudioRouteObservers()
      .then((initialDiagnostics) => {
        if (!isMounted) return;
        setDiagnostics(initialDiagnostics);
        setStatus('ready');
        Logger.debug('AudioRouting', 'route observers started', summarizeDiagnostics(initialDiagnostics));
      })
      .catch((caught) => {
        if (!isMounted) return;
        const message = caught instanceof Error ? caught.message : 'route observers failed';
        setError(message);
        setStatus('error');
        Logger.error('AudioRouting', 'route observers failed', { message });
      });

    return () => {
      isMounted = false;
    };
  }, []);

  const route = useMemo(() => buildRoute(diagnostics), [diagnostics]);
  const isGlassesInput = useMemo(() => route.inputPorts.some(isGlassesAudioPort), [route.inputPorts]);
  const isGlassesOutput = useMemo(() => route.outputPorts.some(isGlassesAudioPort), [route.outputPorts]);
  const routeDescription = useMemo(() => `${route.input} → ${route.output}`, [route.input, route.output]);

  return {
    route,
    status,
    isGlassesInput,
    isGlassesOutput,
    bluetoothConnected: isGlassesInput || isGlassesOutput,
    routeDescription,
    diagnostics,
    sampleResult,
    playbackResult,
    error,
    refreshRoute,
    recordDiagnosticSample,
    playDiagnosticSample,
  };
}

function buildRoute(diagnostics: AudioRouteDiagnostics | null): AudioRoutingRoute {
  if (!diagnostics) return INITIAL_ROUTE;

  const inputPorts = diagnostics.currentInputs;
  const outputPorts = diagnostics.currentOutputs;
  const hfpCandidate = diagnostics.hfpCandidate;

  return {
    input: formatPortSummary(inputPorts),
    output: formatPortSummary(outputPorts),
    inputPorts,
    outputPorts,
    hfpCandidate,
    updatedAt: diagnostics.timestamp,
  };
}

function formatPortSummary(ports: AudioRoutePort[]) {
  return ports.length ? ports.map(formatPort).join(' + ') : 'None';
}

function formatPort(port: AudioRoutePort) {
  return `${port.name} (${formatPortType(port.portType)})`;
}

function formatPortType(portType: string) {
  return portType.replace(/^AVAudioSessionPort/, '');
}

function isGlassesAudioPort(port: AudioRoutePort) {
  const haystack = `${port.name} ${port.portType}`.toLowerCase();
  return haystack.includes('bluetoothhfp') || haystack.includes('bluetooth') || haystack.includes('hfp') || haystack.includes('ray-ban') || haystack.includes('glasses');
}

function summarizeDiagnostics(diagnostics: AudioRouteDiagnostics) {
  return {
    input: formatPortSummary(diagnostics.currentInputs),
    output: formatPortSummary(diagnostics.currentOutputs),
    hfpCandidate: diagnostics.hfpCandidate ? formatPort(diagnostics.hfpCandidate) : 'none',
    fallback: diagnostics.phoneMicFallbackExplicit,
    observersActive: diagnostics.observersActive,
  };
}
