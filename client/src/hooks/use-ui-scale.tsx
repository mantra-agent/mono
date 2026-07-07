import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";

const LS_KEY = "xyz-ui-scale";
const DEFAULT_SCALE = 110;

function readLocal(): number {
  try {
    const v = localStorage.getItem(LS_KEY);
    if (v) {
      const n = parseInt(v, 10);
      if (n >= 90 && n <= 120) return n;
    }
  } catch {}
  return DEFAULT_SCALE;
}

function applyScale(scale: number) {
  document.documentElement.style.fontSize = `${scale}%`;
}

export function useUiScale() {
  const [scale, setScaleState] = useState(readLocal);

  // Fetch server-side preference on mount
  const { data: serverScale } = useQuery<{ scale: number }>({
    queryKey: ["/api/auth/ui-prefs"],
    staleTime: Infinity,
  });

  // Sync server → local on first load (server wins if localStorage is default)
  useEffect(() => {
    if (serverScale?.scale && serverScale.scale !== scale) {
      const s = serverScale.scale;
      if (s >= 90 && s <= 120) {
        setScaleState(s);
        localStorage.setItem(LS_KEY, String(s));
        applyScale(s);
      }
    }
  }, [serverScale]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist to server
  const persistMutation = useMutation({
    mutationFn: async (newScale: number) => {
      const res = await apiRequest("PATCH", "/api/auth/ui-prefs", { scale: newScale });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/ui-prefs"] });
    },
  });

  const setScale = useCallback((newScale: number) => {
    const clamped = Math.max(90, Math.min(120, newScale));
    setScaleState(clamped);
    localStorage.setItem(LS_KEY, String(clamped));
    applyScale(clamped);
  }, []);

  const persistScale = useCallback((newScale: number) => {
    const clamped = Math.max(90, Math.min(120, newScale));
    persistMutation.mutate(clamped);
  }, [persistMutation]);

  return { scale, setScale, persistScale, DEFAULT_SCALE };
}
