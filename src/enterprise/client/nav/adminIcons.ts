import type { IconProps } from '@lobehub/ui';
import { SkillsIcon } from '@lobehub/ui/icons';
import {
  Blocks,
  Bot,
  Brain,
  BrainCircuit,
  ChartColumnBig,
  Cog,
  Download,
  FileSearch,
  Fingerprint,
  Gavel,
  LayoutDashboard,
  LayoutTemplate,
  ListTree,
  MessagesSquare,
  Package,
  Palette,
  Radio,
  ScrollText,
  Server,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Timer,
  Users,
} from 'lucide-react';

/**
 * Icon map keyed by AdminNavItem.id — part of the single admin catalog surface.
 * Side nav and any future catalog consumers must read icons from here only.
 */
export const ADMIN_NAV_ICONS: Readonly<Record<string, IconProps['icon']>> = {
  'agents': MessagesSquare,
  'ai': Bot,
  'ai-connectors': Blocks,
  'ai-memory': BrainCircuit,
  'ai-providers': Brain,
  'ai-service-model': Sparkles,
  'ai-skills': SkillsIcon,
  'audit': ScrollText,
  'audit-conversations': FileSearch,
  'audit-exports': Download,
  'audit-legal-holds': Gavel,
  'audit-live': Radio,
  'audit-logs': ListTree,
  'audit-retention': Timer,
  'branding': Palette,
  'content-moderation': ShieldAlert,
  'identity-providers': Fingerprint,
  'managed-resources': ShieldCheck,
  'overview': LayoutDashboard,
  'settings': SlidersHorizontal,
  'stats': ChartColumnBig,
  'system': Settings2,
  'modules': Package,
  'system-general': Cog,
  'system-status': Server,
  'task-templates': LayoutTemplate,
  'unified-management': SlidersHorizontal,
  'users': Users,
};

/** Nav-visible catalog items must declare an icon (detail-only routes may omit). */
export const assertAdminNavIconsComplete = (navIds: readonly string[]): { missing: string[] } => {
  const missing = navIds.filter((id) => !ADMIN_NAV_ICONS[id]);
  return { missing };
};
