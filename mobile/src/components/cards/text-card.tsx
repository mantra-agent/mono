import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { glassesTheme } from '../../theme/glasses';
import type { TextCardProps } from '@shared/models/glasses';

export function TextCard({ title, subtitle, urgency }: TextCardProps) {
  const titleColor = urgency ? glassesTheme.colors.urgency[urgency] : glassesTheme.colors.textPrimary;

  return (
    <View style={styles.card}>
      <Text style={[styles.title, { color: titleColor }]}>{title}</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
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
  title: {
    ...glassesTheme.typography.title,
    color: glassesTheme.colors.textPrimary,
  },
  subtitle: {
    ...glassesTheme.typography.subtitle,
    color: glassesTheme.colors.textSecondary,
    marginTop: 4,
  },
});
