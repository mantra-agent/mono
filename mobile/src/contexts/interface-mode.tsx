import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
const STORAGE_KEY = 'xyz_mobile_interface_mode';
type MobileInterfaceMode = 'mobile_detail' | 'mobile_simple';

type InterfaceModeContextValue = {
  mode: MobileInterfaceMode;
  setMode: (mode: MobileInterfaceMode) => Promise<void>;
  toggleMode: () => Promise<MobileInterfaceMode>;
  isLoaded: boolean;
};

const InterfaceModeContext = createContext<InterfaceModeContextValue | null>(null);

function toMobileMode(value: unknown): MobileInterfaceMode {
  return value === 'mobile_detail' ? 'mobile_detail' : 'mobile_simple';
}

export function InterfaceModeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<MobileInterfaceMode>('mobile_simple');
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (!alive) return;
        setModeState(toMobileMode(stored));
      })
      .finally(() => {
        if (alive) setIsLoaded(true);
      });
    return () => { alive = false; };
  }, []);

  const setMode = useCallback(async (next: MobileInterfaceMode) => {
    const resolved = toMobileMode(next);
    setModeState(resolved);
    await AsyncStorage.setItem(STORAGE_KEY, resolved);
  }, []);

  const toggleMode = useCallback(async (): Promise<MobileInterfaceMode> => {
    const next = mode === 'mobile_simple' ? 'mobile_detail' : 'mobile_simple';
    await setMode(next);
    return next;
  }, [mode, setMode]);

  const value = useMemo<InterfaceModeContextValue>(() => ({ mode, setMode, toggleMode, isLoaded }), [isLoaded, mode, setMode, toggleMode]);

  return <InterfaceModeContext.Provider value={value}>{children}</InterfaceModeContext.Provider>;
}

export function useInterfaceMode(): InterfaceModeContextValue {
  const ctx = useContext(InterfaceModeContext);
  if (!ctx) throw new Error('useInterfaceMode must be used within InterfaceModeProvider');
  return ctx;
}
