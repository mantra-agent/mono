import React, { useCallback, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Logger from '../lib/logger';

const LOG_TAG = 'VoiceDiag';

type TestResult = { name: string; status: 'pass' | 'fail' | 'info'; detail: string; ts: string };

// ── Diagnostic tests ──

async function testGlobalState(): Promise<TestResult> {
  const g = global as any;
  const checks = {
    WritableStream: typeof g.WritableStream,
    ReadableStream: typeof g.ReadableStream,
    TransformStream: typeof g.TransformStream,
    CountQueuingStrategy: typeof g.CountQueuingStrategy,
    RTCPeerConnection: typeof g.RTCPeerConnection,
    MediaStream: typeof g.MediaStream,
    navigator: typeof g.navigator,
    'navigator.mediaDevices': typeof g.navigator?.mediaDevices,
  };

  // Check if any are lazy getters
  const lazyInfo: string[] = [];
  for (const key of ['WritableStream', 'ReadableStream', 'TransformStream']) {
    const desc = Object.getOwnPropertyDescriptor(g, key);
    if (desc?.get) lazyInfo.push(`${key}: LAZY GETTER`);
    else if (desc?.value !== undefined) lazyInfo.push(`${key}: direct value`);
    else lazyInfo.push(`${key}: not set`);
  }

  return {
    name: 'Global State',
    status: 'info',
    detail: Object.entries(checks).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n\n' + lazyInfo.join('\n'),
    ts: new Date().toISOString(),
  };
}

async function testPonyfillImport(): Promise<TestResult> {
  try {
    const polyfill = require('web-streams-polyfill');
    const keys = Object.keys(polyfill);
    const hasReadable = typeof polyfill.ReadableStream === 'function';
    const hasWritable = typeof polyfill.WritableStream === 'function';
    return {
      name: 'Ponyfill Import',
      status: hasReadable && hasWritable ? 'pass' : 'fail',
      detail: `Keys: ${keys.join(', ')}\nReadableStream: ${hasReadable}\nWritableStream: ${hasWritable}`,
      ts: new Date().toISOString(),
    };
  } catch (e: any) {
    return { name: 'Ponyfill Import', status: 'fail', detail: e.message, ts: new Date().toISOString() };
  }
}

async function testEagerStreamGlobals(): Promise<TestResult> {
  try {
    const polyfill = require('web-streams-polyfill');
    const g = global as any;
    const before = {
      Writable: typeof g.WritableStream,
      Readable: typeof g.ReadableStream,
    };
    // Install eagerly
    if (typeof g.WritableStream === 'undefined') g.WritableStream = polyfill.WritableStream;
    if (typeof g.ReadableStream === 'undefined') g.ReadableStream = polyfill.ReadableStream;
    if (typeof g.TransformStream === 'undefined') g.TransformStream = polyfill.TransformStream;
    if (typeof g.CountQueuingStrategy === 'undefined') g.CountQueuingStrategy = polyfill.CountQueuingStrategy;
    const after = {
      Writable: typeof g.WritableStream,
      Readable: typeof g.ReadableStream,
    };
    return {
      name: 'Eager Stream Globals',
      status: 'pass',
      detail: `Before: ${JSON.stringify(before)}\nAfter: ${JSON.stringify(after)}\nGlobals installed from ponyfill.`,
      ts: new Date().toISOString(),
    };
  } catch (e: any) {
    return { name: 'Eager Stream Globals', status: 'fail', detail: e.message, ts: new Date().toISOString() };
  }
}

async function testRegisterGlobals(): Promise<TestResult> {
  try {
    const { registerGlobals } = await import('@livekit/react-native');
    registerGlobals();
    return {
      name: 'registerGlobals()',
      status: 'pass',
      detail: 'registerGlobals() completed without crash.',
      ts: new Date().toISOString(),
    };
  } catch (e: any) {
    return { name: 'registerGlobals()', status: 'fail', detail: e.message + '\n' + (e.stack || '').slice(0, 500), ts: new Date().toISOString() };
  }
}

async function testRegisterGlobalsNoStreams(): Promise<TestResult> {
  try {
    const { registerGlobals } = await import('@livekit/react-native');
    registerGlobals({ audio: false });
    return {
      name: 'registerGlobals({audio:false})',
      status: 'pass',
      detail: 'registerGlobals with audio:false completed.',
      ts: new Date().toISOString(),
    };
  } catch (e: any) {
    return { name: 'registerGlobals({audio:false})', status: 'fail', detail: e.message + '\n' + (e.stack || '').slice(0, 500), ts: new Date().toISOString() };
  }
}

async function testEagerThenRegister(): Promise<TestResult> {
  try {
    // Step 1: Install stream globals from ponyfill FIRST
    const polyfill = require('web-streams-polyfill');
    const g = global as any;
    g.WritableStream = polyfill.WritableStream;
    g.ReadableStream = polyfill.ReadableStream;
    g.TransformStream = polyfill.TransformStream;
    g.CountQueuingStrategy = polyfill.CountQueuingStrategy;

    // Step 2: THEN call registerGlobals — shimWebstreams should be a no-op
    const { registerGlobals } = await import('@livekit/react-native');
    registerGlobals();

    return {
      name: 'Eager + registerGlobals',
      status: 'pass',
      detail: 'Pre-installed streams from ponyfill, then registerGlobals succeeded.',
      ts: new Date().toISOString(),
    };
  } catch (e: any) {
    return { name: 'Eager + registerGlobals', status: 'fail', detail: e.message + '\n' + (e.stack || '').slice(0, 500), ts: new Date().toISOString() };
  }
}

async function testElevenLabsImport(): Promise<TestResult> {
  try {
    const loaded = await import('@elevenlabs/react-native');
    const keys = Object.keys(loaded).slice(0, 10);
    return {
      name: 'ElevenLabs Import',
      status: 'pass',
      detail: `Module loaded. Keys: ${keys.join(', ')}`,
      ts: new Date().toISOString(),
    };
  } catch (e: any) {
    return { name: 'ElevenLabs Import', status: 'fail', detail: e.message + '\n' + (e.stack || '').slice(0, 500), ts: new Date().toISOString() };
  }
}

async function testFullPath(): Promise<TestResult> {
  try {
    // 1. Eager stream globals
    const polyfill = require('web-streams-polyfill');
    const g = global as any;
    g.WritableStream = polyfill.WritableStream;
    g.ReadableStream = polyfill.ReadableStream;
    g.TransformStream = polyfill.TransformStream;
    g.CountQueuingStrategy = polyfill.CountQueuingStrategy;

    // 2. registerGlobals
    const { registerGlobals } = await import('@livekit/react-native');
    registerGlobals();

    // 3. ElevenLabs
    const loaded = await import('@elevenlabs/react-native');

    return {
      name: 'Full Voice Path',
      status: 'pass',
      detail: 'Eager streams → registerGlobals → ElevenLabs import all succeeded.',
      ts: new Date().toISOString(),
    };
  } catch (e: any) {
    return { name: 'Full Voice Path', status: 'fail', detail: e.message + '\n' + (e.stack || '').slice(0, 500), ts: new Date().toISOString() };
  }
}

// ── Component ──

interface Props {
  visible: boolean;
  onClose: () => void;
}

const TESTS: Array<{ label: string; run: () => Promise<TestResult> }> = [
  { label: '1. Check global state', run: testGlobalState },
  { label: '2. Import web-streams-polyfill', run: testPonyfillImport },
  { label: '3. Install stream globals eagerly', run: testEagerStreamGlobals },
  { label: '4. registerGlobals() (crashes here?)', run: testRegisterGlobals },
  { label: '5. registerGlobals({audio:false})', run: testRegisterGlobalsNoStreams },
  { label: '6. Eager streams → registerGlobals', run: testEagerThenRegister },
  { label: '7. Import @elevenlabs/react-native', run: testElevenLabsImport },
  { label: '8. Full path (eager+register+11labs)', run: testFullPath },
];

export function VoiceDiagnostics({ visible, onClose }: Props) {
  const [results, setResults] = useState<TestResult[]>([]);
  const [running, setRunning] = useState<string | null>(null);

  const runTest = useCallback(async (test: typeof TESTS[number]) => {
    setRunning(test.label);
    Logger.info(LOG_TAG, `Running: ${test.label}`);
    try {
      const result = await test.run();
      Logger.info(LOG_TAG, `Result: ${result.name} → ${result.status}`, { detail: result.detail });
      setResults(prev => [result, ...prev]);
    } catch (e: any) {
      const result: TestResult = {
        name: test.label,
        status: 'fail',
        detail: `Uncaught: ${e.message}\n${(e.stack || '').slice(0, 300)}`,
        ts: new Date().toISOString(),
      };
      Logger.error(LOG_TAG, `Crash: ${test.label}`, { error: e.message });
      setResults(prev => [result, ...prev]);
    }
    setRunning(null);
  }, []);

  const runAll = useCallback(async () => {
    setResults([]);
    for (const test of TESTS) {
      setRunning(test.label);
      try {
        const result = await test.run();
        setResults(prev => [...prev, result]);
      } catch (e: any) {
        setResults(prev => [...prev, {
          name: test.label,
          status: 'fail' as const,
          detail: `Uncaught: ${e.message}`,
          ts: new Date().toISOString(),
        }]);
      }
    }
    setRunning(null);
  }, []);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Voice Diagnostics</Text>
          <Pressable onPress={onClose} style={styles.closeBtn}>
            <Text style={styles.closeTxt}>✕</Text>
          </Pressable>
        </View>

        <Pressable style={styles.runAllBtn} onPress={runAll} disabled={!!running}>
          <Text style={styles.runAllTxt}>{running ? `Running: ${running}` : 'Run All Tests'}</Text>
        </Pressable>

        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          {TESTS.map(test => (
            <Pressable
              key={test.label}
              style={styles.testBtn}
              onPress={() => runTest(test)}
              disabled={!!running}
            >
              <Text style={styles.testLabel}>{test.label}</Text>
            </Pressable>
          ))}

          {results.length > 0 && (
            <View style={styles.resultsSection}>
              <Text style={styles.resultsHeader}>Results</Text>
              {results.map((r, i) => (
                <View key={`${r.name}-${i}`} style={[styles.result, r.status === 'pass' ? styles.resultPass : r.status === 'fail' ? styles.resultFail : styles.resultInfo]}>
                  <Text style={styles.resultName}>{r.status === 'pass' ? '✅' : r.status === 'fail' ? '❌' : 'ℹ️'} {r.name}</Text>
                  <Text style={styles.resultDetail}>{r.detail}</Text>
                  <Text style={styles.resultTs}>{r.ts}</Text>
                </View>
              ))}
            </View>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a', paddingTop: 60 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingBottom: 12 },
  title: { color: '#fff', fontSize: 20, fontWeight: '700' },
  closeBtn: { padding: 8 },
  closeTxt: { color: '#888', fontSize: 22 },
  runAllBtn: { marginHorizontal: 20, backgroundColor: '#1d4ed8', borderRadius: 12, padding: 14, alignItems: 'center', marginBottom: 16 },
  runAllTxt: { color: '#fff', fontSize: 15, fontWeight: '700' },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 20, paddingBottom: 40 },
  testBtn: { backgroundColor: '#1a1a1a', borderRadius: 10, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: '#2a2a2a' },
  testLabel: { color: '#ddd', fontSize: 14, fontWeight: '600' },
  resultsSection: { marginTop: 24 },
  resultsHeader: { color: '#888', fontSize: 13, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 12 },
  result: { borderRadius: 10, padding: 12, marginBottom: 10, borderWidth: 1 },
  resultPass: { backgroundColor: 'rgba(34,197,94,0.08)', borderColor: 'rgba(34,197,94,0.3)' },
  resultFail: { backgroundColor: 'rgba(239,68,68,0.08)', borderColor: 'rgba(239,68,68,0.3)' },
  resultInfo: { backgroundColor: 'rgba(59,130,246,0.08)', borderColor: 'rgba(59,130,246,0.3)' },
  resultName: { color: '#fff', fontSize: 14, fontWeight: '700', marginBottom: 6 },
  resultDetail: { color: '#bbb', fontSize: 12, fontFamily: 'monospace', lineHeight: 18 },
  resultTs: { color: '#555', fontSize: 10, marginTop: 4 },
});
