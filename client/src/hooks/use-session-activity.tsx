import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { useFocusSession } from "@/hooks/use-focus-session";
import {
  useSessionSubscriptions,
  type SessionStreamMap,
  type SessionStreamStore,
  type VisibleAssistantActivity,
} from "@/hooks/use-session-subscription";
import { isDurablyActiveSession, type ChatSession } from "@shared/models/chat";

const MAX_LIVE_SESSION_SUBSCRIPTIONS = 8;

const ACTIVITY_PRIORITY: Record<VisibleAssistantActivity, number> = {
  none: 0,
  streaming: 1,
  thinking: 2,
  tool: 3,
};

interface SessionStreamContextValue {
  store: SessionStreamStore;
  wsConnected: boolean;
}

interface SessionActivityContextValue {
  visibleAssistantActivity: VisibleAssistantActivity;
}

const SessionStreamContext = createContext<SessionStreamContextValue | null>(null);
const SessionActivityContext = createContext<SessionActivityContextValue | null>(null);

function mostActiveAssistantActivity(streams: SessionStreamMap): VisibleAssistantActivity {
  let mostActive: VisibleAssistantActivity = "none";
  for (const stream of Object.values(streams)) {
    if (!stream.runActive && stream.status !== "streaming") continue;
    if (ACTIVITY_PRIORITY[stream.visibleAssistantActivity] > ACTIVITY_PRIORITY[mostActive]) {
      mostActive = stream.visibleAssistantActivity;
    }
  }
  return mostActive;
}

export function SessionActivityProvider({ children }: { children: ReactNode }) {
  const { activeSessionId: activeSession } = useFocusSession();
  const { data: sessions = [] } = useQuery<ChatSession[]>({
    queryKey: ["/api/sessions"],
    refetchOnWindowFocus: true,
  });

  const liveSessionIds = useMemo(() => {
    const ids = new Set<string>();
    if (activeSession) ids.add(activeSession);
    for (const session of sessions) {
      if (!isDurablyActiveSession(session)) continue;
      ids.add(session.id);
      if (ids.size >= MAX_LIVE_SESSION_SUBSCRIPTIONS) break;
    }
    return Array.from(ids);
  }, [activeSession, sessions]);

  const { store, wsConnected } = useSessionSubscriptions(liveSessionIds, {
    owner: "session-activity-provider",
    activeSession,
  });
  const [visibleAssistantActivity, setVisibleAssistantActivity] = useState<VisibleAssistantActivity>("none");
  useEffect(() => {
    const updateActivity = () => {
      const next = mostActiveAssistantActivity(store.getSnapshot());
      setVisibleAssistantActivity((current) => current === next ? current : next);
    };
    updateActivity();
    return store.subscribe(updateActivity);
  }, [store]);
  const streamValue = useMemo<SessionStreamContextValue>(() => ({
    store,
    wsConnected,
  }), [store, wsConnected]);
  const activityValue = useMemo<SessionActivityContextValue>(() => ({
    visibleAssistantActivity,
  }), [visibleAssistantActivity]);

  return (
    <SessionStreamContext.Provider value={streamValue}>
      <SessionActivityContext.Provider value={activityValue}>
        {children}
      </SessionActivityContext.Provider>
    </SessionStreamContext.Provider>
  );
}

export function useSessionStreams(): SessionStreamContextValue {
  const context = useContext(SessionStreamContext);
  if (!context) {
    throw new Error("useSessionStreams must be used inside SessionActivityProvider");
  }
  return context;
}

export function useSessionActivity(): SessionActivityContextValue {
  const context = useContext(SessionActivityContext);
  if (!context) {
    throw new Error("useSessionActivity must be used inside SessionActivityProvider");
  }
  return context;
}
