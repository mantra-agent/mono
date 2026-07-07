import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { glassesTheme } from '../../theme/glasses';
import type { TransitionCardProps } from '@shared/models/glasses';

export function TransitionCard({ message }: TransitionCardProps) {
  return (
    <View style={styles.card}>
      <Text style={styles.message}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    paddingVertical: 40,
    paddingHorizontal: glassesTheme.spacing.cardX,
    borderRadius: glassesTheme.radius.card,
    backgroundColor: glassesTheme.colors.cardBackground,
    borderWidth: 1,
    borderColor: glassesTheme.colors.borderSubtle,
    alignItems: 'center',
  },
  message: {
    ...glassesTheme.typography.transition,
    color: glassesTheme.colors.textSecondary,
    textAlign: 'center',
  },
});
