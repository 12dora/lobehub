'use client';

import { Flexbox } from '@lobehub/ui';
import {
  BrainCircuitIcon,
  BubblesIcon,
  CalendarClockIcon,
  HeartPulseIcon,
  LightbulbIcon,
  SearchIcon,
  SignatureIcon,
} from 'lucide-react';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { type NavItemProps } from '@/features/NavPanel/components/NavItem';
import NavItem from '@/features/NavPanel/components/NavItem';
import { useWorkspaceAwareNavigate } from '@/features/Workspace/useWorkspaceAwareNavigate';
import { usePathname } from '@/libs/router/navigation';
import { useGlobalStore } from '@/store/global';
import { isModifierClick } from '@/utils/navigation';

interface Item {
  icon: NavItemProps['icon'];
  key: string;
  onClick?: () => void;
  title: NavItemProps['title'];
  url?: string;
}

/**
 * Hover prefetch for the memory leaves. Each specifier must stay
 * character-identical to the one in `src/spa/router/desktopRouter.config*.tsx`
 * so Vite resolves them to the same chunk; a stale entry only wastes a
 * prefetch, it can never break navigation.
 */
const MEMORY_CHUNK_PREFETCHERS: Record<string, () => Promise<unknown>> = {
  '/memory': () => import('@/routes/(main)/memory/(home)'),
  '/memory/activities': () => import('@/routes/(main)/memory/activities'),
  '/memory/contexts': () => import('@/routes/(main)/memory/contexts'),
  '/memory/experiences': () => import('@/routes/(main)/memory/experiences'),
  '/memory/identities': () => import('@/routes/(main)/memory/identities'),
  '/memory/preferences': () => import('@/routes/(main)/memory/preferences'),
};

const prefetchedRoutes = new Set<string>();

const prefetchRouteChunk = (url: string) => {
  const load = MEMORY_CHUNK_PREFETCHERS[url];
  if (!load || prefetchedRoutes.has(url)) return;

  prefetchedRoutes.add(url);
  // A failed prefetch must stay silent (offline, deploy skew): let the real
  // navigation surface the error, and allow a later hover to retry.
  void load().catch(() => prefetchedRoutes.delete(url));
};

enum MemoryTabKey {
  Activities = 'activities',
  Contexts = 'contexts',
  Experiences = 'experiences',
  Home = 'home',
  Identities = 'identities',
  Preferences = 'preferences',
}

const useActiveTabKey = () => {
  const pathname = usePathname();
  if (pathname === '/memory') return MemoryTabKey.Home;
  return (pathname.split('/memory/').find(Boolean)! as MemoryTabKey) || MemoryTabKey.Home;
};

const Nav = memo(() => {
  const tab = useActiveTabKey();
  const navigate = useWorkspaceAwareNavigate();
  const { t } = useTranslation('memory');
  const toggleCommandMenu = useGlobalStore((s) => s.toggleCommandMenu);

  const items: Item[] = useMemo(
    () => [
      {
        icon: SearchIcon,
        key: 'search',
        onClick: () => {
          toggleCommandMenu(true);
        },
        title: t('tab.search'),
      },
      {
        icon: BrainCircuitIcon,
        key: MemoryTabKey.Home,
        title: t('tab.home'),
        url: '/memory',
      },
      {
        icon: SignatureIcon,
        key: MemoryTabKey.Identities,
        title: t('tab.identities'),
        url: '/memory/identities',
      },
      {
        icon: BubblesIcon,
        key: MemoryTabKey.Contexts,
        title: t('tab.contexts'),
        url: '/memory/contexts',
      },
      {
        icon: HeartPulseIcon,
        key: MemoryTabKey.Preferences,
        title: t('tab.preferences'),
        url: '/memory/preferences',
      },
      {
        icon: LightbulbIcon,
        key: MemoryTabKey.Experiences,
        title: t('tab.experiences'),
        url: '/memory/experiences',
      },
      {
        icon: CalendarClockIcon,
        key: MemoryTabKey.Activities,
        title: t('tab.activities'),
        url: '/memory/activities',
      },
    ],
    [t],
  );

  return (
    <Flexbox gap={1} paddingInline={4}>
      {items.map((item) => {
        const content = (
          <NavItem
            active={tab === item.key}
            icon={item.icon}
            key={item.key}
            title={item.title}
            onClick={item.onClick}
          />
        );
        if (!item.url) return content;

        return (
          <Link
            key={item.key}
            to={item.url}
            onClick={(e) => {
              if (isModifierClick(e)) return;
              e.preventDefault();
              item?.onClick?.();
              if (item.url) {
                navigate(item.url);
              }
            }}
            onMouseEnter={() => {
              if (item.url) prefetchRouteChunk(item.url);
            }}
          >
            <NavItem active={tab === item.key} icon={item.icon} title={item.title} />
          </Link>
        );
      })}
    </Flexbox>
  );
});

export default Nav;
