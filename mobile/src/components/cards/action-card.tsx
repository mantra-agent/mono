import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { glassesTheme } from '../../theme/glasses';
import type { ActionCardProps } from '@shared/models/glasses';

export function ActionCard({ label, variant = 'primary' }: ActionCardProps) {
  const isPrimary = variant === 'primary';

  return (
    <View style={styles.card}>
      <Pressable style={[styles.button, isPrimary ? styles.primary : styles.secondary]}>
        <Text style={[styles.label, !isPrimary && styles.secondaryLabel]}>{label}</Text>
      </Pressable>
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
  button: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: glassesTheme.radius.button,
  },
  primary: {
    backgroundColor: glassesTheme.colors.actionPrimary,
  },
  secondary: {
    backgroundColor: glassesTheme.colors.actionSecondary,
  },
  label: {
    ...glassesTheme.typography.action,
    color: glassesTheme.colors.textPrimary,
  },
  secondaryLabel: {
    color: glassesTheme.colors.textSecondary,
  },
});
