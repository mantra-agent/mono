import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { AppState } from 'react-native';
import { apiFetch } from '../lib/api';
import { Logger } from '../lib/logger';

interface User {
  id: number;
  email: string;
  role: string;
}

interface AuthContextValue {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: User | null;
  login: (email: string, password: string) => Promise<string | null>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const checkSession = useCallback(async () => {
    const { data, status } = await apiFetch<{ user: User }>('/api/auth/me');
    if (status === 200 && data?.user) {
      setUser(data.user);
      Logger.debug('Auth', 'Session verified', { userId: data.user.id });
    } else {
      setUser(null);
      if (status !== 401) {
        Logger.warn('Auth', 'Session check failed', { status });
      }
    }
    setIsLoading(false);
  }, []);

  // Check session on mount
  useEffect(() => {
    checkSession();
  }, [checkSession]);

  // Re-verify on app foreground
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        checkSession();
      }
    });
    return () => subscription.remove();
  }, [checkSession]);

  const login = useCallback(async (email: string, password: string): Promise<string | null> => {
    const { data, status } = await apiFetch<{ user: User } | { error: string }>(
      '/api/auth/login',
      {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      },
    );

    if (status === 200 && data && 'user' in data) {
      setUser(data.user);
      Logger.log('Auth', 'Login successful', { userId: data.user.id });
      return null;
    }

    const errorMsg =
      data && 'error' in data ? data.error : 'Login failed';
    Logger.warn('Auth', 'Login failed', { status, error: errorMsg });
    return errorMsg;
  }, []);

  const logout = useCallback(async () => {
    await apiFetch('/api/auth/logout', { method: 'POST' });
    setUser(null);
    Logger.log('Auth', 'Logged out');
  }, []);

  const value: AuthContextValue = {
    isAuthenticated: user !== null,
    isLoading,
    user,
    login,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
