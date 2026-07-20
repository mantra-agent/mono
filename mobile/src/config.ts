import AsyncStorage from '@react-native-async-storage/async-storage';

export type BackendTarget = 'production' | 'development' | 'custom';

const envServerUrl = process.env.EXPO_PUBLIC_SERVER_URL?.trim().replace(/\/+$/, '');
const envProductionServerUrl = process.env.EXPO_PUBLIC_PRODUCTION_SERVER_URL?.trim().replace(/\/+$/, '');
const envDevelopmentServerUrl = process.env.EXPO_PUBLIC_DEVELOPMENT_SERVER_URL?.trim().replace(/\/+$/, '');
const envBackendTarget = process.env.EXPO_PUBLIC_BACKEND_TARGET;

export const BACKEND_TARGETS: Record<Exclude<BackendTarget, 'custom'>, string> = {
  production: envProductionServerUrl || (envBackendTarget === 'production' ? envServerUrl || '' : ''),
  development: envDevelopmentServerUrl || (envBackendTarget === 'development' ? envServerUrl || '' : ''),
};

const DEFAULTS = {
  ELEVENLABS_AGENT_ID: 'YOUR_AGENT_ID',
  BACKEND_TARGET: envBackendTarget === 'development' ? 'development' as BackendTarget : 'production' as BackendTarget,
  CUSTOM_SERVER_URL: '',
} as const;

const STORAGE_KEYS = {
  ELEVENLABS_AGENT_ID: 'config:agentId',
  BACKEND_TARGET: 'config:backendTarget',
  CUSTOM_SERVER_URL: 'config:customServerUrl',
} as const;

function normalizeServerUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, '');
  if (!normalized) return '';
  try {
    const parsed = new URL(normalized);
    const localDevelopment = __DEV__ && parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !localDevelopment) return '';
    return parsed.origin;
  } catch {
    return '';
  }
}

function isBackendTarget(value: string): value is BackendTarget {
  return value === 'production' || value === 'development' || value === 'custom';
}

class AppConfig {
  private cache: Record<string, string> = {};
  private loaded = false;
  private loadPromise: Promise<void> | null = null;

  async load(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = AsyncStorage.multiGet(Object.values(STORAGE_KEYS))
      .then((pairs) => {
        for (const [key, value] of pairs) {
          if (value != null) this.cache[key] = value;
        }
        this.loaded = true;
      })
      .finally(() => {
        this.loadPromise = null;
      });

    return this.loadPromise;
  }

  get ELEVENLABS_AGENT_ID(): string {
    return this.cache[STORAGE_KEYS.ELEVENLABS_AGENT_ID] ?? DEFAULTS.ELEVENLABS_AGENT_ID;
  }

  get BACKEND_TARGET(): BackendTarget {
    const saved = this.cache[STORAGE_KEYS.BACKEND_TARGET];
    return saved && isBackendTarget(saved) ? saved : DEFAULTS.BACKEND_TARGET;
  }

  get CUSTOM_SERVER_URL(): string {
    return this.cache[STORAGE_KEYS.CUSTOM_SERVER_URL] ?? DEFAULTS.CUSTOM_SERVER_URL;
  }

  get SERVER_URL(): string {
    if (this.BACKEND_TARGET === 'custom') {
      const customUrl = normalizeServerUrl(this.CUSTOM_SERVER_URL);
      return customUrl || normalizeServerUrl(BACKEND_TARGETS.production);
    }

    return normalizeServerUrl(BACKEND_TARGETS[this.BACKEND_TARGET]);
  }

  get TRUSTED_ORIGIN(): string {
    return new URL(this.SERVER_URL).origin;
  }

  async set(key: keyof typeof STORAGE_KEYS, value: string): Promise<void> {
    const storageKey = STORAGE_KEYS[key];
    const normalizedValue = key === 'CUSTOM_SERVER_URL' ? normalizeServerUrl(value) : value.trim();
    await AsyncStorage.setItem(storageKey, normalizedValue);
    this.cache[storageKey] = normalizedValue;
  }

  async reset(): Promise<void> {
    const keys = Object.values(STORAGE_KEYS);
    await AsyncStorage.multiRemove(keys);
    this.cache = {};
    this.loaded = false;
    this.loadPromise = null;
  }
}

export default new AppConfig();
