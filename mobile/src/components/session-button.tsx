import React from 'react';
import { Pressable, Text, StyleSheet } from 'react-native';
import { productTheme } from '../theme/glasses';

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
    minWidth: 44,
    minHeight: 44,
    borderRadius: 50,
    backgroundColor: productTheme.colors.surfaceMuted,
    borderWidth: 2,
    borderColor: productTheme.colors.borderMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonActive: {
    backgroundColor: productTheme.colors.destructive,
    borderColor: productTheme.colors.destructive,
  },
  buttonConnecting: {
    borderColor: productTheme.colors.connection.connecting,
    opacity: 0.6,
  },
  buttonPressed: {
    opacity: 0.7,
  },
  text: {
    color: productTheme.colors.textPrimary,
    fontSize: 18,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  textActive: {
    color: productTheme.colors.textPrimary,
  },
});
