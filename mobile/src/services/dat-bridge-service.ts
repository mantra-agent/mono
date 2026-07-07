/**
 * DAT Bridge Service — always-on polling, auto-setup, and capture upload.
 *
 * Runs at app root level (not gated by debug overlay visibility).
 * Polls the server for remote DAT commands and executes them via native bridge.
 * On mount, attempts auto-setup: configure → register check → connect.
 * After capture, automatically uploads the photo to object storage.
 */
import { useCallback, useEffect, useRef } from 'react';
import {
  addDatEventListener,
  autoSetupDat,
  captureDatPhoto,
  checkDatCameraPermission,
  connectDatDevice,
  configureDat,
  listDatDevices,
  requestDatCameraPermission,
  startDatRegistration,
  type DatResult,
} from '../../modules/agent-native/src';
import { apiFetch } from '../lib/api';
import { Logger } from '../lib/logger';
import Config from '../config';

const LOG_TAG = 'DATBridge';
const COMMAND_TIMEOUT_MS = 45_000;
const CAPTURE_TIMEOUT_MS = 35_000;

function sleep(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  });
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  try {
    return await Promise.race([promise, sleep(ms)]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} ${message}`);
  }
}

type DATRemoteCommand = {
  id: number;
  action: string;
  params: Record<string, unknown>;
  note: string | null;
};

/**
 * Upload a captured photo (base64 JPEG) to object storage via the server.
 * Returns the objectPath on success, null on failure.
 */
async function uploadCapture(base64: string, capturedAt?: string): Promise<string | null> {
  const byteEstimate = Math.floor((base64.length * 3) / 4);
  Logger.info(LOG_TAG, 'Capture upload starting', { base64Length: base64.length, byteEstimate, capturedAt: capturedAt ?? null });
  try {
    await Config.load();
    Logger.debug(LOG_TAG, 'Capture upload target resolved', { serverUrl: Config.SERVER_URL });
    const res = await fetch(`${Config.SERVER_URL}/api/mobile/dat-capture/upload`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base64,
        contentType: 'image/jpeg',
        capturedAt: capturedAt ?? new Date().toISOString(),
      }),
    });
    Logger.info(LOG_TAG, 'Capture upload response received', { status: res.status, ok: res.ok });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      Logger.error(LOG_TAG, 'Upload failed', { status: res.status, body: body.slice(0, 500) });
      return null;
    }
    const data = (await res.json()) as { objectPath: string; byteCount: number };
    Logger.info(LOG_TAG, 'Photo uploaded', { objectPath: data.objectPath, bytes: data.byteCount });
    return data.objectPath;
  } catch (e) {
    Logger.error(LOG_TAG, 'Upload error', { error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/**
 * Hook that runs always-on DAT bridge polling and auto-setup.
 * Mount once at app root level.
 */
export function useDATBridgeService() {
  const lastIdRef = useRef(0);
  const runningRef = useRef(false);
  const setupDoneRef = useRef(false);

  const executeCommand = useCallback(async (command: DATRemoteCommand) => {
    Logger.debug(LOG_TAG, `Executing remote command: ${command.action}`, { id: command.id });
    let result: DatResult | null = null;
    let error: string | null = null;
    let status: 'ok' | 'error' = 'ok';

    try {
      switch (command.action) {
        case 'status':
          result = await configureDat();
          break;
        case 'preflight':
          result = await configureDat();
          break;
        case 'initialize':
          result = await configureDat();
          break;
        case 'listDevices':
          result = await listDatDevices();
          break;
        case 'register':
          result = await startDatRegistration();
          break;
        case 'requestCamera':
          result = await requestDatCameraPermission();
          break;
        case 'checkCamera':
          result = await checkDatCameraPermission();
          break;
        case 'connect': {
          const deviceId = (command.params?.deviceId as string) ?? null;
          result = await connectDatDevice(deviceId);
          break;
        }
        case 'capture': {
          Logger.info(LOG_TAG, 'Capture command entered native bridge', { commandId: command.id });
          const setupResult = await withTimeout(autoSetupDat(), COMMAND_TIMEOUT_MS, 'capture autoSetup');
          Logger.info(LOG_TAG, 'Capture auto-setup result', {
            commandId: command.id,
            autoSetup: setupResult?.autoSetup ?? null,
            connected: setupResult?.connected ?? null,
            stoppedAt: setupResult?.stoppedAt ?? null,
            sessionState: setupResult?.sessionState ?? null,
            error: setupResult?.error ?? null,
            errorType: setupResult?.errorType ?? null,
          });
          const captureResult = await withTimeout(captureDatPhoto(), CAPTURE_TIMEOUT_MS, 'capture');
          const captureKeys = captureResult && typeof captureResult === 'object' ? Object.keys(captureResult) : [];
          Logger.info(LOG_TAG, 'Capture command returned from native bridge', {
            commandId: command.id,
            keys: captureKeys,
            contentType: captureResult?.contentType ?? null,
            byteCount: captureResult?.byteCount ?? null,
            hasBase64: Boolean((captureResult as Record<string, unknown> | null)?.base64),
            base64Length: typeof (captureResult as Record<string, unknown> | null)?.base64 === 'string'
              ? ((captureResult as Record<string, unknown>).base64 as string).length
              : 0,
            fileUrl: captureResult?.fileUrl ?? null,
            error: captureResult?.error ?? null,
            errorType: captureResult?.errorType ?? null,
          });
          result = captureResult;

          // Auto-upload if capture succeeded and has base64 data
          if (captureResult && typeof captureResult === 'object' && 'base64' in captureResult) {
            const raw = captureResult as Record<string, unknown>;
            const base64 = raw.base64 as string;
            if (base64 && base64.length > 100) {
              const objectPath = await uploadCapture(base64, raw.timestamp as string);
              if (objectPath) {
                // Replace base64 with objectPath in result (don't send megabytes of base64 to server)
                delete raw.base64;
                raw.objectPath = objectPath;
                raw.uploaded = true;
                result = raw as DatResult;
              } else {
                Logger.warn(LOG_TAG, 'Capture upload returned no objectPath', { commandId: command.id });
              }
            } else {
              Logger.warn(LOG_TAG, 'Capture result missing usable base64 payload', { commandId: command.id, base64Length: base64?.length ?? 0 });
            }
          } else {
            Logger.warn(LOG_TAG, 'Capture result had no base64 field', { commandId: command.id, keys: captureKeys });
          }
          break;
        }
        case 'autoSetup':
          result = await autoSetupDat();
          break;
        default:
          error = `Unknown action: ${command.action}`;
          status = 'error';
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      status = 'error';
      Logger.error(LOG_TAG, `Command ${command.action} failed`, { error });
    }

    // Post result back to server (without base64 — already uploaded)
    try {
      const resultToSend = result && typeof result === 'object' && 'base64' in result
        ? { ...result as Record<string, unknown>, base64: undefined }
        : result;

      Logger.info(LOG_TAG, 'Posting command result', { commandId: command.id, status, hasResult: Boolean(resultToSend), error });
      await apiFetch(`/api/mobile/dat-debug/commands/${command.id}/result`, {
        method: 'POST',
        body: JSON.stringify({
          status,
          result: resultToSend ?? { error },
          error,
          mobileTimestamp: new Date().toISOString(),
        }),
      });
      Logger.info(LOG_TAG, 'Posted command result', { commandId: command.id, status });
    } catch (e) {
      Logger.error(LOG_TAG, 'Failed to post command result', {
        commandId: command.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }, []);

  // Mirror native DAT photo lifecycle events into remote client logs.
  useEffect(() => {
    const subscription = addDatEventListener((event) => {
      if (event.type.startsWith('capturePhoto') || event.type.startsWith('photo')) {
        Logger.info(LOG_TAG, 'Native DAT event', event);
      }
    });

    return () => subscription.remove();
  }, []);

  // Always-on polling
  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      if (cancelled || runningRef.current) return;
      runningRef.current = true;
      try {
        const { data } = await withTimeout(apiFetch<{
          commands: DATRemoteCommand[];
          latestId: number;
        }>(`/api/mobile/dat-debug/commands?sinceId=${lastIdRef.current}`), COMMAND_TIMEOUT_MS, 'poll');

        if (!cancelled && data?.commands?.length) {
          for (const command of data.commands) {
            lastIdRef.current = Math.max(lastIdRef.current, command.id);
            await executeCommand(command);
          }
        } else if (data?.latestId) {
          lastIdRef.current = Math.max(lastIdRef.current, data.latestId);
        }
      } catch {
        // Network errors are expected when server is unreachable
      } finally {
        runningRef.current = false;
      }
    };

    void poll();
    const timer = setInterval(() => {
      void poll();
    }, 2000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [executeCommand]);

  // Auto-setup on mount (once)
  useEffect(() => {
    if (setupDoneRef.current) return;
    setupDoneRef.current = true;

    const setup = async () => {
      try {
        Logger.info(LOG_TAG, 'Starting auto-setup');
        const result = await autoSetupDat();
        Logger.info(LOG_TAG, 'Auto-setup complete', { result });
      } catch (e) {
        Logger.warn(LOG_TAG, 'Auto-setup failed (non-fatal)', {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    };

    const timeout = setTimeout(() => {
      void setup();
    }, 2000);

    return () => clearTimeout(timeout);
  }, []);
}
