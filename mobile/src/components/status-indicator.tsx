import React, { useEffect, useRef } from 'react';
import { View, Animated, StyleSheet, Text } from 'react-native';

type Status = 'disconnected' | 'connecting' | 'connected' | 'error';

interface Props {
  status: Status;
  isSpeaking: boolean;
}

function getColor(status: Status, isSpeaking: boolean): string {
  if (status === 'disconnected') return '#333';
  if (status === 'connecting') return '#f59e0b';
  if (status === 'error') return '#ef4444';
  if (isSpeaking) return '#3b82f6';
  return '#22c55e';
}

function getLabel(status: Status, isSpeaking: boolean): string {
  if (status === 'disconnected') return 'Ready';
  if (status === 'connecting') return 'Connecting';
  if (status === 'error') return 'Error';
  if (isSpeaking) return 'Speaking';
  return 'Listening';
}

export function StatusIndicator({ status, isSpeaking }: Props) {
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const isActive = status === 'connected';

  useEffect(() => {
    if (isActive) {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.3,
            duration: 1000,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 1000,
            useNativeDriver: true,
          }),
        ]),
      );
      pulse.start();
      return () => pulse.stop();
    } else {
      pulseAnim.setValue(1);
    }
  }, [isActive, pulseAnim]);

  const color = getColor(status, isSpeaking);

  return (
    <View style={styles.container}>
      <Animated.View
        style={[
          styles.ring,
          {
            borderColor: color,
            opacity: isActive ? 0.3 : 0,
            transform: [{ scale: pulseAnim }],
          },
        ]}
      />
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.label, { color }]}>
        {getLabel(status, isSpeaking)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 80,
  },
  ring: {
    position: 'absolute',
    width: 120,
    height: 120,
    borderRadius: 60,
    borderWidth: 2,
  },
  dot: {
    width: 80,
    height: 80,
    borderRadius: 40,
  },
  label: {
    marginTop: 20,
    fontSize: 16,
    fontWeight: '500',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
});
