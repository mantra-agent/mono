import { requireNativeModule, type EventSubscription } from 'expo-modules-core';

// ── Environment ──

export type NativeEnvironment = {
  platform: string;
  moduleLoaded: boolean;
  timestamp: string;
  appName?: string;
  bundleIdentifier?: string;
  appVersion?: string;
  buildNumber?: string;
};

// ── Audio Route ──

export type AudioRoutePort = {
  uid: string;
  name: string;
  portType: string;
  channels?: number;
  dataSources?: string[];
  selectedDataSource?: string;
};

export type AudioRouteEvent = {
  type: 'routeChange' | 'interruption';
  timestamp: string;
  reason?: string;
  phase?: string;
  route: {
    inputs: AudioRoutePort[];
    outputs: AudioRoutePort[];
  };
};

export type HfpCandidate = AudioRoutePort & {
  isSelected: boolean;
};

export type AudioRouteDiagnostics = {
  timestamp: string;
  category: string;
  mode: string;
  categoryOptions: string[];
  sampleRate: number;
  ioBufferDuration: number;
  preferredInput?: AudioRoutePort;
  currentInputs: AudioRoutePort[];
  currentOutputs: AudioRoutePort[];
  availableInputs: AudioRoutePort[];
  hfpCandidate?: HfpCandidate;
  phoneMicFallbackExplicit: boolean;
  observersActive: boolean;
  recentEvents: AudioRouteEvent[];
};

export type HfpSelectionResult = {
  selected: boolean;
  fallback: 'none' | 'phoneMic';
  selectedInput?: AudioRoutePort;
  diagnostics: AudioRouteDiagnostics;
};

export type AudioSampleResult = {
  fileUrl: string;
  durationSeconds: number;
  startedAt: string;
  finishedAt: string;
  diagnostics: AudioRouteDiagnostics;
};

export type AudioPlaybackResult = {
  played: boolean;
  source: 'sample' | 'tone' | 'file';
  fileUrl?: string;
  frequencyHz?: number;
  durationSeconds?: number;
};

// ── Meta DAT ──

export type DatEvent = {
  type: string;
  timestamp: string;
  [key: string]: unknown;
};

export type DatDevice = {
  id: string;
  name?: string;
  type?: string;
  supportsDisplay?: boolean;
};

export type DatResult = {
  timestamp: string;
  error?: string;
  errorType?: string;
  [key: string]: unknown;
};

export type DatConfigureResult = DatResult & {
  configured?: boolean;
  deviceCount?: number;
};

export type DatDeviceListResult = DatResult & {
  devices?: DatDevice[];
  registrationState?: string;
};

export type DatConnectResult = DatResult & {
  connected?: boolean;
  sessionState?: string;
};

export type DatStreamResult = DatResult & {
  streaming?: boolean;
  frameCount?: number;
};

export type DatPhotoResult = DatResult & {
  contentType?: string;
  byteCount?: number;
  fileUrl?: string | null;
};

export type DatDisplayResult = DatResult & {
  sent?: boolean;
};

export type DatDisplayContent = {
  type?: 'text' | 'flexbox' | 'button' | 'image';
  text?: string;
  message?: string;
  style?: 'heading' | 'body';
  label?: string;
  url?: string;
  padding?: number;
  children?: DatDisplayContent[];
};

// ── Module Interface ──

type AgentNativeModule = {
  // Environment
  getNativeEnvironment(): Promise<NativeEnvironment>;
  // Audio
  startAudioRouteObservers(): Promise<AudioRouteDiagnostics>;
  getAudioRouteDiagnostics(): Promise<AudioRouteDiagnostics>;
  selectHfpInput(): Promise<HfpSelectionResult>;
  recordTenSecondSample(): Promise<AudioSampleResult>;
  playBase64Audio(audioBase64: string, fileExtension?: string | null): Promise<AudioPlaybackResult>;
  playAudioFileUrl(fileUrl: string): Promise<AudioPlaybackResult>;
  playLastSample(): Promise<AudioPlaybackResult>;
  playTestTone(): Promise<AudioPlaybackResult>;
  copyRouteEvidence(evidence: string): Promise<{ copied: boolean }>;
  // DAT
  configureDat(): Promise<DatConfigureResult>;
  startDatRegistration(): Promise<DatResult>;
  handleDatUrl(url: string): Promise<{ handled: boolean; timestamp: string; error?: string }>;
  checkDatCameraPermission(): Promise<DatResult>;
  requestDatCameraPermission(): Promise<DatResult>;
  autoSetupDat(): Promise<DatResult>;
  listDatDevices(): Promise<DatDeviceListResult>;
  connectDatDevice(deviceId?: string | null): Promise<DatConnectResult>;
  disconnectDat(): Promise<DatResult>;
  startDatVideoStream(): Promise<DatStreamResult>;
  stopDatVideoStream(): Promise<DatStreamResult>;
  captureDatPhoto(): Promise<DatPhotoResult>;
  sendDatDisplay(content: DatDisplayContent): Promise<DatDisplayResult>;
  // Events
  addListener(eventName: 'onMetaDATEvent', listener: (event: DatEvent) => void): EventSubscription;
  removeListeners(count: number): void;
};

function getNativeModule(): AgentNativeModule {
  return requireNativeModule<AgentNativeModule>('AgentNative');
}

// ── Environment ──

export async function getNativeEnvironment(): Promise<NativeEnvironment> {
  return getNativeModule().getNativeEnvironment();
}

// ── Audio Route ──

export async function startAudioRouteObservers(): Promise<AudioRouteDiagnostics> {
  return getNativeModule().startAudioRouteObservers();
}

export async function getAudioRouteDiagnostics(): Promise<AudioRouteDiagnostics> {
  return getNativeModule().getAudioRouteDiagnostics();
}

export async function selectHfpInput(): Promise<HfpSelectionResult> {
  return getNativeModule().selectHfpInput();
}

export async function recordTenSecondSample(): Promise<AudioSampleResult> {
  return getNativeModule().recordTenSecondSample();
}

export async function playBase64Audio(audioBase64: string, fileExtension?: string | null): Promise<AudioPlaybackResult> {
  return getNativeModule().playBase64Audio(audioBase64, fileExtension ?? null);
}

export async function playAudioFileUrl(fileUrl: string): Promise<AudioPlaybackResult> {
  return getNativeModule().playAudioFileUrl(fileUrl);
}

export async function playLastSample(): Promise<AudioPlaybackResult> {
  return getNativeModule().playLastSample();
}

export async function playTestTone(): Promise<AudioPlaybackResult> {
  return getNativeModule().playTestTone();
}

export async function copyRouteEvidence(evidence: string): Promise<{ copied: boolean }> {
  return getNativeModule().copyRouteEvidence(evidence);
}

// ── Meta DAT ──

export async function configureDat(): Promise<DatConfigureResult> {
  return getNativeModule().configureDat();
}

export async function startDatRegistration(): Promise<DatResult> {
  return getNativeModule().startDatRegistration();
}

export async function handleDatUrl(url: string): Promise<{ handled: boolean; timestamp: string; error?: string }> {
  return getNativeModule().handleDatUrl(url);
}

export async function listDatDevices(): Promise<DatDeviceListResult> {
  return getNativeModule().listDatDevices();
}

export async function connectDatDevice(deviceId?: string | null): Promise<DatConnectResult> {
  return getNativeModule().connectDatDevice(deviceId ?? null);
}

export async function disconnectDat(): Promise<DatResult> {
  return getNativeModule().disconnectDat();
}

export async function startDatVideoStream(): Promise<DatStreamResult> {
  return getNativeModule().startDatVideoStream();
}

export async function stopDatVideoStream(): Promise<DatStreamResult> {
  return getNativeModule().stopDatVideoStream();
}

export async function captureDatPhoto(): Promise<DatPhotoResult> {
  return getNativeModule().captureDatPhoto();
}

export async function sendDatDisplay(content: DatDisplayContent): Promise<DatDisplayResult> {
  return getNativeModule().sendDatDisplay(content);
}

// ── Events ──

export function addDatEventListener(listener: (event: DatEvent) => void): EventSubscription {
  return getNativeModule().addListener('onMetaDATEvent', listener);
}

// Camera permission - delegates to the actual native SDK call
export async function autoSetupDat(): Promise<DatResult> {
  return getNativeModule().autoSetupDat();
}

export async function checkDatCameraPermission(): Promise<DatResult> {
  return getNativeModule().checkDatCameraPermission();
}

export async function requestDatCameraPermission(): Promise<DatResult> {
  return getNativeModule().requestDatCameraPermission();
}



