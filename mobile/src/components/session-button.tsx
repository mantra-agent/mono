import React from 'react';
import { Pressable, Text, StyleSheet } from 'react-native';

type Status = 'disconnected' | 'connecting' | 'connected' | 'error';

interface Props {
  status: Status;
  onPress: () => void;
  onLongPress?: () => void;
}

export function SessionButton({ status, onPress, onLongPress }: Props) {
  const isConnected = status === 'connected';
  const isConnecting = status === 'connecting';

  return (
    <Pressable
      style={({ pressed }) => [
        styles.button,
        isConnected && styles.buttonActive,
        isConnecting && styles.buttonConnecting,
        pressed && styles.buttonPressed,
      ]}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={600}
      disabled={isConnecting}
      accessibilityLabel={isConnected ? 'End session' : 'Start session'}
      accessibilityRole="button"
    >
      <Text style={[styles.text, isConnected && styles.textActive]}>
        {isConnecting ? '...' : isConnected ? 'End' : 'Start'}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: '#1a1a1a',
    borderWidth: 2,
    borderColor: '#333',
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonActive: {
    backgroundColor: '#dc2626',
    borderColor: '#dc2626',
  },
  buttonConnecting: {
    borderColor: '#f59e0b',
    opacity: 0.6,
  },
  buttonPressed: {
    opacity: 0.7,
  },
  text: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  textActive: {
    color: '#fff',
  },
});
