import { useState, useEffect, useRef, useCallback } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { apiFetch } from '../lib/api';
import { Logger } from '../lib/logger';
import type { SurfaceDescriptor } from '@shared/models/glasses';

const CACHE_KEY = 'surface:lastDescriptor';
const POLL_INTERVAL_MS = 60_000;

function hashComponents(components: SurfaceDescriptor['components']): string {
  return JSON.stringify(components);
}

export function useSurface() {
  const [descriptor, setDescriptor] = useState<SurfaceDescriptor | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isConnected, setIsConnected] = useState(false);
  const lastHashRef = useRef<string>('');

  const fetchSurface = useCallback(async () => {
    const { data, status } = await apiFetch<SurfaceDescriptor>('/api/glasses/surface');

    if (status === 200 && data) {
      setIsConnected(true);
      const hash = hashComponents(data.components);
      if (hash !== lastHashRef.current) {
        lastHashRef.current = hash;
        setDescriptor(data);
        AsyncStorage.setItem(CACHE_KEY, JSON.stringify(data)).catch(() => {});
        Logger.debug('Surface', 'Updated surface', { componentCount: data.components.length });
      }
    } else {
      setIsConnected(false);
      Logger.warn('Surface', 'Fetch failed', { status });
    }

    setIsLoading(false);
  }, []);

  useEffect(() => {
    AsyncStorage.getItem(CACHE_KEY)
      .then((cached) => {
        if (!cached) return;
        try {
          const parsed = JSON.parse(cached) as SurfaceDescriptor;
          setDescriptor(parsed);
          lastHashRef.current = hashComponents(parsed.components);
          Logger.debug('Surface', 'Loaded cached descriptor');
        } catch {
          Logger.warn('Surface', 'Failed to parse cached descriptor');
        }
      })
      .catch(() => {})
      .finally(() => {
        fetchSurface();
      });
  }, [fetchSurface]);

  useEffect(() => {
    const interval = setInterval(fetchSurface, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchSurface]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        Logger.debug('Surface', 'App foregrounded, refreshing');
        fetchSurface();
      }
    });
    return () => subscription.remove();
  }, [fetchSurface]);

  return { descriptor, isLoading, isConnected };
}
