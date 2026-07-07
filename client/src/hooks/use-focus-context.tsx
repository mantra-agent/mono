import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from "react";

export interface FocusEntity {
  type: string;
  id: string;
  label?: string;
}

export interface FocusContextValue {
  entity?: FocusEntity;
  subView?: string;
  state?: Record<string, string>;
}

interface FocusContextShape {
  current: FocusContextValue | null;
  publish: (id: string, value: FocusContextValue | null) => void;
}

const Ctx = createContext<FocusContextShape>({
  current: null,
  publish: () => {},
});

export function FocusContextProvider({ children }: { children: ReactNode }) {
  const stackRef = useRef<Array<{ id: string; value: FocusContextValue }>>([]);
  const [current, setCurrent] = useState<FocusContextValue | null>(null);

  const publish = useCallback((id: string, value: FocusContextValue | null) => {
    const stack = stackRef.current.filter((e) => e.id !== id);
    if (value && (value.entity || value.subView || (value.state && Object.keys(value.state).length > 0))) {
      stack.push({ id, value });
    }
    stackRef.current = stack;
    const next = stack.length > 0 ? stack[stack.length - 1].value : null;
    setCurrent((prev) => {
      if (prev === next) return prev;
      if (prev && next && JSON.stringify(prev) === JSON.stringify(next)) return prev;
      return next;
    });
  }, []);

  const ctxValue = useMemo<FocusContextShape>(() => ({ current, publish }), [current, publish]);
  return <Ctx.Provider value={ctxValue}>{children}</Ctx.Provider>;
}

export function useFocusContextValue(): FocusContextValue | null {
  return useContext(Ctx).current;
}

export function useFocusContext(value: FocusContextValue | null) {
  const id = useId();
  const { publish } = useContext(Ctx);
  const serialized = value ? JSON.stringify(value) : null;
  useEffect(() => {
    publish(id, serialized ? (JSON.parse(serialized) as FocusContextValue) : null);
    return () => publish(id, null);
  }, [id, serialized, publish]);
}
