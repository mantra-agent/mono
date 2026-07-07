import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { glassesTheme } from '../../theme/glasses';
import type { ListCardProps } from '@shared/models/glasses';

export function ListCard({ title, items, maxVisible }: ListCardProps) {
  const visibleItems = maxVisible ? items.slice(0, maxVisible) : items;

  return (
    <View style={styles.card}>
      <Text style={styles.title}>{title}</Text>
      <View>
        {visibleItems.map((item, i) => (
          <View key={i} style={[styles.listItem, i < visibleItems.length - 1 && styles.listItemBorder]}>
            <Text style={styles.label}>{item.label}</Text>
            {item.meta ? <Text style={styles.meta}>{item.meta}</Text> : null}
          </View>
        ))}
      </View>
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
    marginBottom: 12,
  },
  listItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
  },
  listItemBorder: {
    borderBottomWidth: 1,
    borderBottomColor: glassesTheme.colors.borderSubtle,
  },
  label: {
    fontSize: 15,
    color: glassesTheme.colors.textPrimary,
    flex: 1,
  },
  meta: {
    fontSize: 15,
    color: glassesTheme.colors.textTertiary,
    marginLeft: 8,
  },
});
