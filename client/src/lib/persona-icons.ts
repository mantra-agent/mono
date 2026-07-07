import {
  Bot, User, Shield, Trophy, Zap, Palette, Heart,
  Sparkles, Brain, Target, Compass, BookOpen, Star,
  Flame, Eye, Lightbulb, Feather, Anchor, Gem,
  Rocket, Glasses, Coffee, Briefcase, Globe, Swords,
  type LucideIcon,
} from "lucide-react";

const ICON_MAP: Record<string, LucideIcon> = {
  Bot,
  User,
  Shield,
  Trophy,
  Zap,
  Palette,
  Heart,
  Sparkles,
  Brain,
  Target,
  Compass,
  BookOpen,
  Star,
  Flame,
  Eye,
  Lightbulb,
  Feather,
  Anchor,
  Gem,
  Rocket,
  Glasses,
  Coffee,
  Briefcase,
  Globe,
  Swords,
};

export const AVAILABLE_ICONS = Object.keys(ICON_MAP);

export function resolvePersonaIcon(iconName: string | undefined | null): LucideIcon {
  if (iconName && ICON_MAP[iconName]) {
    return ICON_MAP[iconName];
  }
  return Bot;
}
