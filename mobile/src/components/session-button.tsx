import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { glassesTheme } from '../theme/glasses';

type Status = 'disconnected' | 'connecting' | 'connected' | 'error';

interface SessionButtonProps {
  status: Status;
  onPress: () => void;
  onLongPress?: () => void;
}

export function SessionButton({ status, onPress, onLongPress }: SessionButtonProps) {
  const isConnected = status === 'connected';
  const isConnecting = status === 'connecting';
  const label = isConnecting ? 'Connecting' : isConnected ? 'End session' : 'Start session';

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
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ busy: isConnecting, disabled: isConnecting }}
    >
      <Text style={styles.text}>{isConnecting ? 'Connecting…' : isConnected ? 'End' : 'Start'}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minWidth: 112,
    minHeight: 56,
    borderRadius: glassesTheme.radius.button,
    backgroundColor: glassesTheme.colors.actionPrimary,
    borderWidth: 1,
    borderColor: glassesTheme.colors.actionPrimary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  buttonActive: {
    backgroundColor: glassesTheme.colors.status.error,
    borderColor: glassesTheme.colors.status.error,
  },
  buttonConnecting: {
    backgroundColor: glassesTheme.colors.actionSecondary,
    borderColor: glassesTheme.colors.status.warning,
    opacity: 0.8,
  },
  buttonPressed: {
    opacity: 0.75,
  },
  text: {
    color: glassesTheme.colors.actionPrimaryText,
    fontSize: 16,
    fontWeight: '600',
  },
});
