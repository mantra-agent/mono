import React, { Component, type ErrorInfo, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  captureDatPhoto,
  connectDatDevice,
  configureDat,
  listDatDevices,
  requestDatCameraPermission,
  checkDatCameraPermission,
  startDatRegistration,
  autoSetupDat,
  type DatDevice,
  type DatResult,
} from '../../modules/agent-native/src';
import { Logger } from '../lib/logger';
import { glassesTheme } from '../theme/glasses';

// ── Types ──

type StatusIndicator = 'ok' | 'error' | 'unknown' | 'pending';
type LogEntry = { label: string; timestamp: string; result: unknown };

function isErrorResult<T>(result: T | DatResult): boolean {
  return result != null && typeof result === 'object' && 'error' in result;
}

function formatResult(result: unknown): string {
  if (result == null) return 'null';
  if (typeof result === 'string') return result;
  try { return JSON.stringify(result, null, 2); } catch { return String(result); }
}

// ── Main Component ──

function DebugOverlayContent({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [status, setStatus] = useState<{ label: string; indicator: StatusIndicator }>({ label: 'Not checked', indicator: 'unknown' });
  const [devices, setDevices] = useState<DatDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);

  const addLog = useCallback((label: string, result: unknown) => {
    setLog((prev) => [{ label, timestamp: new Date().toISOString(), result }, ...prev].slice(0, 20));
  }, []);

  const run = useCallback(
    async <T,>(label: string, action: () => Promise<T>): Promise<T | null> => {
      if (activeAction) return null;
      setActiveAction(label);
      try {
        const result = await action();
        addLog(label, result);
        return result;
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        addLog(label, { error });
        return null;
      } finally {
        setActiveAction(null);
      }
    },
    [activeAction, addLog],
  );

  // Auto-refresh status on open
  useEffect(() => {
    if (!visible) return;
    const refresh = async () => {
      try {
        const result = await configureDat();
        if (result && !isErrorResult(result)) {
          setStatus({ label: 'SDK configured', indicator: 'ok' });
        } else {
          setStatus({ label: 'SDK error', indicator: 'error' });
        }
        const devResult = await listDatDevices();
        if (devResult && !isErrorResult(devResult)) {
          const devs = (devResult as { devices?: DatDevice[] }).devices ?? [];
          setDevices(devs);
          if (devs.length > 0 && !selectedDeviceId) {
            setSelectedDeviceId(devs[0].id);
          }
          setStatus({ label: `Ready · ${devs.length} device${devs.length !== 1 ? 's' : ''}`, indicator: 'ok' });
        }
      } catch {
        setStatus({ label: 'Init failed', indicator: 'error' });
      }
    };
    void refresh();
  }, [visible, selectedDeviceId]);

  if (!visible) return null;

  return (
    <View style={styles.shell} pointerEvents="box-none">
      <View style={styles.panel}>
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <View style={[styles.dot, styles[`${status.indicator}Dot`]]} />
            <Text style={styles.title}>{status.label}</Text>
          </View>
          <Pressable style={styles.closeButton} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close">
            <Text style={styles.closeText}>×</Text>
          </Pressable>
        </View>

        {/* Actions */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.actions}>
          <Btn label="Auto Setup" busy={activeAction === 'Auto Setup'} onPress={() => run('Auto Setup', autoSetupDat)} />
          <Btn label="Register" busy={activeAction === 'Register'} onPress={() => run('Register', startDatRegistration)} />
          <Btn label="Camera Perm" busy={activeAction === 'Camera Perm'} onPress={() => run('Camera Perm', requestDatCameraPermission)} />
          <Btn label="Connect" busy={activeAction === 'Connect'} disabled={!selectedDeviceId} onPress={() => run('Connect', () => connectDatDevice(selectedDeviceId))} />
          <Btn label="Capture" busy={activeAction === 'Capture'} onPress={() => run('Capture', captureDatPhoto)} />
          <Btn label="Check Perm" busy={activeAction === 'Check Perm'} onPress={() => run('Check Perm', checkDatCameraPermission)} />
          <Btn label="Devices" busy={activeAction === 'Devices'} onPress={async () => {
            const r = await run('Devices', listDatDevices);
            if (r && !isErrorResult(r)) {
              const devs = (r as { devices?: DatDevice[] }).devices ?? [];
              setDevices(devs);
              if (devs.length > 0 && !selectedDeviceId) setSelectedDeviceId(devs[0].id);
            }
          }} />
        </ScrollView>

        {/* Device selector (only if multiple) */}
        {devices.length > 1 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.deviceRow}>
            {devices.map((d) => (
              <Pressable
                key={d.id}
                style={[styles.deviceChip, d.id === selectedDeviceId && styles.deviceChipSelected]}
                onPress={() => setSelectedDeviceId(d.id)}
              >
                <Text style={[styles.deviceText, d.id === selectedDeviceId && styles.deviceTextSelected]}>
                  {d.name ?? d.id.slice(-6)}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}

        {/* Log */}
        <ScrollView style={styles.logScroll} nestedScrollEnabled>
          {log.map((entry, i) => (
            <View key={`${entry.timestamp}-${i}`} style={styles.logEntry}>
              <Text style={styles.logLabel}>{entry.label}</Text>
              <Text style={styles.logBody} numberOfLines={4}>{formatResult(entry.result)}</Text>
            </View>
          ))}
          {log.length === 0 ? (
            <Text style={styles.logEmpty}>Polling is always on. Use buttons above or send commands from web.</Text>
          ) : null}
        </ScrollView>
      </View>
    </View>
  );
}

// ── Button ──

function Btn({ label, busy, disabled, onPress }: { label: string; busy: boolean; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable
      style={[styles.btn, busy && styles.btnBusy, disabled && styles.btnDisabled]}
      onPress={onPress}
      disabled={busy || disabled}
    >
      <Text style={[styles.btnText, (busy || disabled) && styles.btnTextDim]}>{label}</Text>
    </Pressable>
  );
}

// ── Error Boundary ──

class DebugErrorBoundary extends Component<{ children: ReactNode; onClose: () => void }, { hasError: boolean; error: Error | null }> {
  state = { hasError: false, error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { hasError: true, error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { Logger.error('DebugOverlay', 'Crashed', { error: error.message, stack: info.componentStack }); }
  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.shell}>
          <View style={styles.panel}>
            <Text style={styles.title}>Debug overlay crashed</Text>
            <Text style={styles.logBody}>{this.state.error?.message}</Text>
            <Btn label="Close" busy={false} onPress={this.props.onClose} />
          </View>
        </View>
      );
    }
    return this.props.children;
  }
}

// ── Export ──

export function DebugOverlay(props: { visible: boolean; onClose: () => void }) {
  if (!props.visible) return null;
  return (
    <DebugErrorBoundary onClose={props.onClose}>
      <DebugOverlayContent {...props} />
    </DebugErrorBoundary>
  );
}

// ── Styles ──

const styles = StyleSheet.create({
  shell: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
    zIndex: 9999,
  },
  panel: {
    backgroundColor: '#1a1a2e',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 24,
    maxHeight: '50%',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  title: {
    color: glassesTheme.colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  closeButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeText: {
    color: glassesTheme.colors.text,
    fontSize: 18,
    lineHeight: 20,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  okDot: { backgroundColor: '#4ade80' },
  errorDot: { backgroundColor: '#f87171' },
  unknownDot: { backgroundColor: '#94a3b8' },
  pendingDot: { backgroundColor: '#facc15' },
  actions: {
    gap: 6,
    paddingBottom: 8,
  },
  btn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  btnBusy: {
    backgroundColor: 'rgba(250,204,21,0.15)',
  },
  btnDisabled: {
    opacity: 0.4,
  },
  btnText: {
    color: glassesTheme.colors.text,
    fontSize: 12,
    fontWeight: '500',
  },
  btnTextDim: {
    opacity: 0.5,
  },
  deviceRow: {
    gap: 6,
    paddingBottom: 8,
  },
  deviceChip: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  deviceChipSelected: {
    backgroundColor: 'rgba(74,222,128,0.2)',
  },
  deviceText: {
    color: glassesTheme.colors.textSecondary,
    fontSize: 11,
  },
  deviceTextSelected: {
    color: '#4ade80',
  },
  logScroll: {
    maxHeight: 180,
  },
  logEntry: {
    paddingVertical: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  logLabel: {
    color: glassesTheme.colors.text,
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 2,
  },
  logBody: {
    color: glassesTheme.colors.textSecondary,
    fontSize: 10,
    fontFamily: 'monospace',
  },
  logEmpty: {
    color: glassesTheme.colors.textSecondary,
    fontSize: 11,
    fontStyle: 'italic',
    textAlign: 'center',
    paddingVertical: 12,
  },
});
