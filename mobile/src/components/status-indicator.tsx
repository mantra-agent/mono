import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { glassesTheme } from '../theme/glasses';

type Status = 'disconnected' | 'connecting' | 'connected' | 'error';

interface StatusIndicatorProps {
  status: Status;
  isSpeaking: boolean;
}

function getColor(status: Status, isSpeaking: boolean): string {
  if (status === 'disconnected') return glassesTheme.colors.status.neutral;
  if (status === 'connecting') return glassesTheme.colors.status.warning;
  if (status === 'error') return glassesTheme.colors.status.error;
  if (isSpeaking) return glassesTheme.colors.status.active;
  return glassesTheme.colors.status.success;
}

function getLabel(status: Status, isSpeaking: boolean): string {
  if (status === 'disconnected') return 'Ready';
  if (status === 'connecting') return 'Connecting';
  if (status === 'error') return 'Voice error';
  if (isSpeaking) return 'Speaking';
  return 'Listening';
}

export function StatusIndicator({ status, isSpeaking }: StatusIndicatorProps) {
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const isActive = status === 'connected';

  useEffect(() => {
    if (!isActive) {
      pulseAnim.setValue(1);
      return;
    }
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.18, duration: 1000, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 1000, useNativeDriver: true }),
      ]),
    );
    pulse.start();
    return () => pulse.stop();
  }, [isActive, pulseAnim]);

  const color = getColor(status, isSpeaking);
  const label = getLabel(status, isSpeaking);

  return (
    <View style={styles.container} accessibilityRole="text" accessibilityLabel={`Voice status: ${label}`}>
      <View style={styles.indicatorWrap}>
        <Animated.View
          style={[
            styles.ring,
            { borderColor: color, opacity: isActive ? 0.3 : 0, transform: [{ scale: pulseAnim }] },
          ]}
        />
        <View style={[styles.dot, { backgroundColor: color }]} />
      </View>
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  indicatorWrap: {
    width: 88,
    height: 88,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ring: {
    position: 'absolute',
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 2,
  },
  dot: {
    width: 56,
    height: 56,
    borderRadius: 28,
  },
  label: {
    color: glassesTheme.colors.textPrimary,
    fontSize: 14,
    fontWeight: '600',
  },
});
