import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { glassesTheme } from '../../theme/glasses';
import type { TimerCardProps } from '@shared/models/glasses';

export function TimerCard({ label, targetTime }: TimerCardProps) {
  let display = targetTime;
  try {
    const target = new Date(targetTime);
    display = target.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {}

  return (
    <View style={styles.card}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.timer}>{display}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    paddingVertical: glassesTheme.spacing.cardY,
    paddingHorizontal: glassesTheme.spacing.cardX,
    borderRadius: glassesTheme.radius.card,
    backgroundColor: glassesTheme.colors.cardBackground,
    borderWidth: 1,
    borderColor: glassesTheme.colors.borderSubtle,
  },
  label: {
    ...glassesTheme.typography.label,
    color: glassesTheme.colors.textPrimary,
  },
  timer: {
    ...glassesTheme.typography.timer,
    color: glassesTheme.colors.textPrimary,
    marginTop: 4,
    fontVariant: ['tabular-nums'],
  },
});
