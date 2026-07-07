import React from 'react';
import { View, StyleSheet } from 'react-native';
import { TextCard } from './cards/text-card';
import { ListCard } from './cards/list-card';
import { TimerCard } from './cards/timer-card';
import { AlertCard } from './cards/alert-card';
import { ActionCard } from './cards/action-card';
import { TransitionCard } from './cards/transition-card';
import { glassesTheme } from '../theme/glasses';
import type { SurfaceDescriptor, ComponentDescriptor } from '@shared/models/glasses';

const COMPONENT_MAP: Record<string, React.ComponentType<any>> = {
  TextCard,
  ActionCard,
  ListCard,
  TimerCard,
  AlertCard,
  TransitionCard,
};

function renderComponent(component: ComponentDescriptor) {
  const Component = COMPONENT_MAP[component.type];
  if (!Component) return null;
  return <Component key={component.id} {...component.props} />;
}

export function SurfaceRenderer({ descriptor }: { descriptor: SurfaceDescriptor | null }) {
  if (!descriptor?.components.length) return null;
  return <View style={styles.surface}>{descriptor.components.map(renderComponent)}</View>;
}

const styles = StyleSheet.create({
  surface: {
    gap: glassesTheme.spacing.surfaceGap,
    paddingHorizontal: glassesTheme.spacing.surfaceX,
  },
});
