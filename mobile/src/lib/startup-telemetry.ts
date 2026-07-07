import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

export type StartupPhase =
  | 'process_start'
  | 'polyfills_start'
  | 'register_globals_start'
  | 'register_globals_done'
  | 'polyfills_done'
  | 'router_import_start'
  | 'app_mounted';

type TelemetryKind =
  | 'phase'
  | 'fatal_js_error'
  | 'unhandled_promise_rejection'
  | 'previous_launch_incomplete'
  | 'sentry_status';

type StartupTelemetryEvent = {
  kind: TelemetryKind;
  phase?: StartupPhase;
  isFatal?: boolean;
  errorName?: string | null;
  errorMessage?: string | null;
  errorStack?: string | null;
  payload?: Record<string, unknown>;
};

type PriorLaunch = {
  mobileSessionId: string;
  phase: StartupPhase;
  updatedAt: string;
};

const DEVICE_ID_KEY = 'agent.mobile.telemetry.deviceId';
const PRIOR_LAUNCH_KEY = 'agent.mobile.telemetry.priorLaunch';
const QUEUE_KEY = 'agent.mobile.telemetry.queue';
const TELEMETRY_TIMEOUT_MS = 2500;
const MAX_QUEUE_EVENTS = 25;

const mobileSessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
let deviceId: string | null = null;
let handlersInstalled = false;
let previousLaunchChecked = false;
let backendUrl: string | null = null;

function getConfigConstants(): Record<string, any> | null {
  try {
    return require('expo-constants').default || require('expo-constants');
  } catch {
    return null;
  }
}


function getConstantsExtra(constants: Record<string, any> | null): Record<string, any> {
  return constants?.expoConfig?.extra || constants?.manifest?.extra || {};
}

function resolveBackendUrl(): string {
  if (backendUrl) return backendUrl;
  const constants = getConfigConstants();
  const extra = getConstantsExtra(constants);
  const configured = typeof extra?.apiUrl === 'string' ? extra.apiUrl : null;
  backendUrl = configured || (__DEV__ ? 'http://localhost:5000' : 'https://xyz-production.up.railway.app');
  return backendUrl;
}

function safeText(value: unknown, max = 1000): string | null {
  if (value == null) return null;
  const text = String(value);
  return text.length > max ? text.slice(0, max) : text;
}

async function getDeviceId(): Promise<string> {
  if (deviceId) return deviceId;
  const existing = await AsyncStorage.getItem(DEVICE_ID_KEY);
  if (existing) {
    deviceId = existing;
    return existing;
  }
  deviceId = `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  await AsyncStorage.setItem(DEVICE_ID_KEY, deviceId);
  return deviceId;
}

function collectIdentity() {
  const constants = getConfigConstants();
  const extra = getConstantsExtra(constants);
  const expoConfig = constants?.expoConfig || {};
  return {
    platform: Platform.OS,
    osVersion: String(Platform.Version || ''),
    deviceModel: safeText((Platform.constants as any)?.Model || (Platform.constants as any)?.model || (Platform.constants as any)?.systemName, 256),
    appVersion: safeText(expoConfig?.version, 128),
    nativeBuildVersion: safeText(expoConfig?.ios?.buildNumber || expoConfig?.android?.versionCode, 128),
    runtimeVersion: safeText(expoConfig?.runtimeVersion, 256),
    updateId: null,
    updateGroupId: null,
    bundleIdentifier: safeText(expoConfig?.ios?.bundleIdentifier || expoConfig?.android?.package, 256),
    easBuildId: safeText(extra?.easBuildId || extra?.buildId, 256),
    buildProfile: safeText(extra?.easBuildProfile || extra?.buildProfile || process.env.EXPO_PUBLIC_EAS_BUILD_PROFILE, 128),
    gitSha: safeText(extra?.gitSha || extra?.sourceRef || process.env.EXPO_PUBLIC_GIT_SHA, 128),
    sourceRef: safeText(extra?.sourceRef || extra?.gitRef || process.env.EXPO_PUBLIC_SOURCE_REF, 256),
  };
}

async function persistQueuedEvent(event: StartupTelemetryEvent & { occurredAt: string }) {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    const current = raw ? JSON.parse(raw) : [];
    const next = [...(Array.isArray(current) ? current : []), event].slice(-MAX_QUEUE_EVENTS);
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(next));
  } catch {}
}

async function flushPersistedQueue() {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    if (!raw) return;
    await AsyncStorage.removeItem(QUEUE_KEY);
    const queued = JSON.parse(raw);
    if (!Array.isArray(queued)) return;
    for (const item of queued.slice(-MAX_QUEUE_EVENTS)) {
      await sendTelemetry(item, false);
    }
  } catch {}
}

async function sendTelemetry(event: StartupTelemetryEvent & { occurredAt: string }, persistOnFailure = true) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), TELEMETRY_TIMEOUT_MS) : null;
  try {
    const id = await getDeviceId();
    const payload = {
      ...collectIdentity(),
      ...event,
      mobileSessionId,
      deviceId: id,
    };
    await fetch(`${resolveBackendUrl().replace(/\/$/, '')}/api/mobile/telemetry/startup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller?.signal,
    });
  } catch {
    if (persistOnFailure) await persistQueuedEvent(event);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function enqueue(event: StartupTelemetryEvent) {
  const withTime = { ...event, occurredAt: new Date().toISOString() };
  void sendTelemetry(withTime);
}

async function persistPhase(phase: StartupPhase) {
  const prior: PriorLaunch = { mobileSessionId, phase, updatedAt: new Date().toISOString() };
  await AsyncStorage.setItem(PRIOR_LAUNCH_KEY, JSON.stringify(prior));
}

async function clearPhase() {
  await AsyncStorage.removeItem(PRIOR_LAUNCH_KEY);
}

async function reportPreviousIncompleteOnce() {
  if (previousLaunchChecked) return;
  previousLaunchChecked = true;
  try {
    await flushPersistedQueue();
    const raw = await AsyncStorage.getItem(PRIOR_LAUNCH_KEY);
    if (!raw) return;
    const prior = JSON.parse(raw) as PriorLaunch;
    if (prior?.phase && prior.phase !== 'app_mounted') {
      enqueue({
        kind: 'previous_launch_incomplete',
        phase: prior.phase,
        payload: { previousMobileSessionId: prior.mobileSessionId, previousUpdatedAt: prior.updatedAt },
      });
    }
  } catch {}
}

export function markStartupPhase(phase: StartupPhase) {
  enqueue({ kind: 'phase', phase });
  void persistPhase(phase);
  if (phase === 'process_start') void reportPreviousIncompleteOnce();
}

export function markAppMounted() {
  enqueue({ kind: 'phase', phase: 'app_mounted' });
  void clearPhase();
}

function eventFromReason(kind: TelemetryKind, reason: unknown): StartupTelemetryEvent {
  const error = reason instanceof Error ? reason : null;
  return {
    kind,
    isFatal: kind === 'fatal_js_error',
    errorName: safeText(error?.name || 'Error', 500),
    errorMessage: safeText(error?.message || reason, 1000),
    errorStack: safeText(error?.stack, 8000),
  };
}

export function installGlobalErrorHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  try {
    const errorUtils = (global as any).ErrorUtils;
    const previousHandler = errorUtils?.getGlobalHandler?.();
    if (errorUtils?.setGlobalHandler) {
      errorUtils.setGlobalHandler((error: unknown, isFatal?: boolean) => {
        enqueue({ ...eventFromReason('fatal_js_error', error), isFatal: Boolean(isFatal) });
        if (typeof previousHandler === 'function') previousHandler(error, isFatal);
      });
    }
  } catch {}

  try {
    const globalAny = global as any;
    const listeners = globalAny.process;
    if (listeners?.on) {
      listeners.on('unhandledRejection', (reason: unknown) => {
        enqueue(eventFromReason('unhandled_promise_rejection', reason));
      });
    }
  } catch {}
}

export function reportSentryStatus(active: boolean, missing: string[] = []) {
  enqueue({ kind: 'sentry_status', payload: { active, missing } });
}
