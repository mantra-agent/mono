import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { glassesTheme } from '../../theme/glasses';
import type { AlertCardProps } from '@shared/models/glasses';

export function AlertCard({ message, severity }: AlertCardProps) {
  return (
    <View style={[styles.card, { borderLeftWidth: 3, borderLeftColor: glassesTheme.colors.severity[severity] }]}>
      <Text style={styles.message}>{message}</Text>
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
  message: {
    ...glassesTheme.typography.title,
    color: glassesTheme.colors.textPrimary,
  },
});
