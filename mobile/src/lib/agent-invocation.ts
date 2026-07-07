import * as Linking from 'expo-linking';
import { Logger } from './logger';

export type AgentInvocationAction = 'start' | 'stop' | 'ask' | 'quickVision' | 'liveCoach' | 'unknown';

export type AgentInvocation = {
  action: AgentInvocationAction;
  url: string;
  question?: string;
};

type HandleInvocationOptions = {
  status: string;
  startSession: () => Promise<void>;
  endSession: () => Promise<void>;
  rehearseVoiceOnly: () => Promise<void>;
  runQuickVision: () => Promise<void>;
  router: { replace: (href: '/' | '/voice') => void };
};

export function parseAgentInvocation(url: string): AgentInvocation {
  const parsed = Linking.parse(url);
  const parts = [parsed.hostname, parsed.path]
    .filter((part): part is string => Boolean(part))
    .flatMap((part) => part.split('/'))
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const primary = parts[0] ?? '';
  const secondary = parts[1] ?? '';
  const queryParams = parsed.queryParams ?? {};
  const mode = stringParam(queryParams.mode)?.toLowerCase();
  const question = stringParam(queryParams.text ?? queryParams.question);

  if (primary === 'start' || (primary === 'voice' && secondary === 'start')) {
    return { action: 'start', url };
  }

  if (primary === 'stop' || (primary === 'voice' && secondary === 'stop')) {
    return { action: 'stop', url };
  }

  if (primary === 'ask') {
    return { action: 'ask', url, question };
  }

  if (primary === 'vision' && (mode === 'quick' || secondary === 'quick')) {
    return { action: 'quickVision', url };
  }

  if (primary === 'coach' && (mode === 'live' || secondary === 'live')) {
    return { action: 'liveCoach', url };
  }

  return { action: 'unknown', url };
}

export async function handleAgentInvocation(
  invocation: AgentInvocation,
  options: HandleInvocationOptions,
): Promise<void> {
  Logger.log('Navigation', 'Agent invocation received', {
    action: invocation.action,
    hasQuestion: Boolean(invocation.question),
  });

  if (invocation.action === 'unknown') {
    return;
  }

  if (invocation.action === 'stop') {
    if (options.status === 'connected') {
      await options.endSession();
    }
    return;
  }

  if (invocation.action === 'quickVision') {
    options.router.replace('/');
    await options.runQuickVision();
    return;
  }

  options.router.replace('/voice');
  await options.rehearseVoiceOnly();

  if (invocation.action === 'ask' && invocation.question) {
    Logger.log('Navigation', 'Ask Agent launch context captured', {
      questionLength: invocation.question.length,
    });
  }
}

function stringParam(value: unknown): string | undefined {
  if (Array.isArray(value)) return stringParam(value[0]);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
