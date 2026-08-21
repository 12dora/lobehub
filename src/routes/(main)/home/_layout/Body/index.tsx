'use client';

import type { MenuProps } from '@lobehub/ui';
import { Accordion, ActionIcon, DropdownMenu, Flexbox, Icon } from '@lobehub/ui';
import { EyeOffIcon, MoreHorizontalIcon, SlidersHorizontalIcon } from 'lucide-react';
import type { Key, ReactElement } from 'react';
import { memo, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useActiveWorkspaceId } from '@/business/client/hooks/useActiveWorkspaceId';
import { useSidebarLayoutPolicy } from '@/enterprise/client/hooks/useSidebarLayoutPolicy';
import NavItem from '@/features/NavPanel/components/NavItem';
import { useWorkspaceAwareNavigate } from '@/features/Workspace/useWorkspaceAwareNavigate';
import WorkspaceLink from '@/features/Workspace/WorkspaceLink';
import { useActiveTabKey } from '@/hooks/useActiveTabKey';
import type { NavItem as NavItemType } from '@/hooks/useNavLayout';
import { useNavLayout } from '@/hooks/useNavLayout';
import Recents from '@/routes/(main)/home/features/Recents';
import { useGlobalStore } from '@/store/global';
import { systemStatusSelectors } from '@/store/global/selectors';
import { SIDEBAR_SPACER_ID } from '@/store/global/selectors/systemStatus';
import { isModifierClick } from '@/utils/navigation';

import Agent from './Agent';
import { openCustomizeSidebarModal } from './CustomizeSidebarModal';
import Private from './Private';

export enum GroupKey {
  Agent = 'agent',
  Community = 'community',
  Pages = 'pages',
  Private = 'private',
  Project = 'project',
  Recents = 'recents',
  Resource = 'resource',
}

const ACCORDION_KEYS = new Set<string>([GroupKey.Recents, GroupKey.Agent, GroupKey.Private]);

/**
 * Hover prefetch for the heaviest sidebar destinations. Their route chunks are
 * lazy (`dynamicElement` / `dynamicLayout`), so a cold first click suspends and
 * shows the outlet fallback. Warming the exact same module ids the router
 * imports means the click usually resolves from cache instead — the specifiers
 * must stay character-identical so Vite treats them as the same chunk.
 *
 * Each entry lists the layout(s) plus the index leaf the URL actually lands on.
 *
 * Keep in sync with `src/spa/router/desktopRouter.config*.tsx`; a stale entry
 * only wastes a prefetch, it can never break navigation.
 */
const ROUTE_CHUNK_PREFETCHERS: Record<string, () => Promise<unknown>[]> = {
  '/community': () => [
    import('@/routes/(main)/community/_layout'),
    import('@/routes/(main)/community/(list)/_layout'),
    import('@/routes/(main)/community/(list)/(home)'),
  ],
  '/image': () => [
    import('@/routes/(main)/(create)/image/_layout'),
    import('@/routes/(main)/(create)/image'),
  ],
  '/memory': () => [
    import('@/routes/(main)/memory/_layout'),
    import('@/routes/(main)/memory/(home)'),
  ],
  '/resource': () => [
    import('@/routes/(main)/resource/_layout'),
    import('@/routes/(main)/resource/(home)/_layout'),
    import('@/routes/(main)/resource/(home)'),
  ],
};

const prefetchedRoutes = new Set<string>();

const prefetchRouteChunks = (url: string) => {
  const loadChunks = ROUTE_CHUNK_PREFETCHERS[url];
  if (!loadChunks || prefetchedRoutes.has(url)) return;

  prefetchedRoutes.add(url);
  for (const chunk of loadChunks()) {
    // A failed prefetch must stay silent (offline, deploy skew): let the real
    // navigation surface the error, and allow a later hover to retry.
    void chunk.catch(() => prefetchedRoutes.delete(url));
  }
};

/** Keys rendered in the header — must be excluded from the body to avoid duplicates
 * when migrating users whose persisted sidebarItems still include them. */
const HEADER_KEYS = new Set<string>(['home', 'search']);

const accordionComponents: Record<string, (key: string) => ReactElement> = {
  [GroupKey.Agent]: (key) => <Agent itemKey={key} key={key} />,
  [GroupKey.Private]: (key) => <Private itemKey={key} key={key} />,
  [GroupKey.Recents]: (key) => <Recents itemKey={key} key={key} />,
};

const mergeSidebarExpandedKeys = (
  currentKeys: string[],
  accordionKeys: string[],
  expandedKeys: Key[],
): string[] => {
  const nextExpandedKeys = new Set(expandedKeys.map(String));
  const accordionKeySet = new Set(accordionKeys);
  const nextKeys = currentKeys.filter((key) => !accordionKeySet.has(key));

  for (const key of accordionKeys) {
    if (nextExpandedKeys.has(key)) nextKeys.push(key);
  }

  return nextKeys;
};

const Body = memo(() => {
  const { t } = useTranslation('common');
  const tab = useActiveTabKey();
  const navigate = useWorkspaceAwareNavigate();
  const { topNavItems, bottomMenuItems } = useNavLayout();
  // Personal mode has no notion of "private vs workspace-public" — every row
  // is implicitly the owner's. Hide the Private section entirely there so the
  // sidebar doesn't sprout an empty accordion users can't populate.
  const activeWorkspaceId = useActiveWorkspaceId();
  const sidebarItems = useGlobalStore(systemStatusSelectors.sidebarItems(activeWorkspaceId));
  const sidebarExpandedKeys = useGlobalStore(
    systemStatusSelectors.sidebarExpandedKeys(activeWorkspaceId),
  );
  const hiddenSections = useGlobalStore(
    systemStatusSelectors.hiddenSidebarSections(activeWorkspaceId),
  );
  const updateSystemStatus = useGlobalStore((s) => s.updateSystemStatus);

  // Platform-managed sidebar (M15): when the admin centrally manages the layout, apply the
  // published layout (order + hidden groups) and hide the user's customization controls.
  const sidebarPolicy = useSidebarLayoutPolicy();
  const managedSidebar = sidebarPolicy.managed;
  const effectiveSidebarItems =
    managedSidebar && sidebarPolicy.layout ? sidebarPolicy.layout.sidebarItems : sidebarItems;
  const effectiveHiddenSections =
    managedSidebar && sidebarPolicy.layout
      ? sidebarPolicy.layout.hiddenSidebarSections
      : hiddenSections;

  const hideSection = useCallback(
    (key: string) => {
      updateSystemStatus({ hiddenSidebarSections: [...hiddenSections, key] });
    },
    [hiddenSections, updateSystemStatus],
  );

  const getContextMenuItems = useCallback(
    (key: string): MenuProps['items'] => [
      {
        icon: <Icon icon={EyeOffIcon} />,
        key: 'hideSection',
        label: t('navPanel.hideSection'),
        onClick: () => hideSection(key),
      },
      { type: 'divider' as const },
      {
        icon: <Icon icon={SlidersHorizontalIcon} />,
        key: 'customizeSidebar',
        label: t('navPanel.customizeSidebar'),
        onClick: () => openCustomizeSidebarModal(),
      },
    ],
    [t, hideSection],
  );

  // Build a map of nav link items by key
  const navLinkItems = useMemo(() => {
    const map = new Map<string, NavItemType>();
    for (const item of topNavItems) map.set(item.key, item);
    for (const item of bottomMenuItems) map.set(item.key, item);
    return map;
  }, [topNavItems, bottomMenuItems]);

  // Items that must always be visible regardless of hiddenSections
  const isVisible = useCallback(
    (k: string) => {
      // Private accordion is workspace-only. In personal mode every row is
      // implicitly owner-private, so a dedicated bucket would be a noisy
      // empty section.
      if (k === GroupKey.Private && !activeWorkspaceId) return false;
      return (
        k === GroupKey.Agent || k === SIDEBAR_SPACER_ID || !effectiveHiddenSections.includes(k)
      );
    },
    [effectiveHiddenSections, activeWorkspaceId],
  );

  const visibleKeys = useMemo(
    () => effectiveSidebarItems.filter((k) => !HEADER_KEYS.has(k) && isVisible(k)),
    [effectiveSidebarItems, isVisible],
  );

  const renderNavLink = useCallback(
    (key: string) => {
      const navItem = navLinkItems.get(key);
      if (!navItem || navItem.hidden) return null;
      return (
        <WorkspaceLink
          key={key}
          to={navItem.url!}
          onMouseEnter={() => prefetchRouteChunks(navItem.url!)}
          onClick={(e) => {
            if (isModifierClick(e)) return;
            e.preventDefault();
            navigate(navItem.url!);
          }}
        >
          <NavItem
            active={tab === key}
            contextMenuItems={managedSidebar ? undefined : getContextMenuItems(key)}
            icon={navItem.icon}
            title={navItem.title}
            actions={
              // Platform-managed: the nav-link "..." holds only layout controls, so it
              // disappears entirely (conversation/assistant menus are unaffected).
              managedSidebar ? undefined : (
                <DropdownMenu items={getContextMenuItems(key)} nativeButton={false}>
                  <ActionIcon icon={MoreHorizontalIcon} size={'small'} style={{ flex: 'none' }} />
                </DropdownMenu>
              )
            }
          />
        </WorkspaceLink>
      );
    },
    [navLinkItems, tab, getContextMenuItems, navigate, managedSidebar],
  );

  const handleAccordionExpandedChange = useCallback(
    (accordionKeys: string[], expandedKeys: Key[]) => {
      updateSystemStatus({
        sidebarExpandedKeys: mergeSidebarExpandedKeys(
          sidebarExpandedKeys,
          accordionKeys,
          expandedKeys,
        ),
      });
    },
    [sidebarExpandedKeys, updateSystemStatus],
  );

  // Render the flat list in `sidebarItems` order: group consecutive accordion
  // items into an Accordion, interleave non-accordion keys as nav links, and
  // emit a flex spacer wherever the spacer sentinel appears.
  const content = useMemo(() => {
    const elements: ReactElement[] = [];
    let accGroup: { element: ReactElement; key: string }[] = [];

    const flushAccordion = () => {
      if (accGroup.length > 0) {
        const accordionKeys = accGroup.map((item) => item.key);

        elements.push(
          <Accordion
            expandedKeys={sidebarExpandedKeys}
            gap={8}
            key={`acc-${elements.length}`}
            onExpandedChange={(keys) => handleAccordionExpandedChange(accordionKeys, keys)}
          >
            {accGroup.map((item) => item.element)}
          </Accordion>,
        );
        accGroup = [];
      }
    };

    for (const key of visibleKeys) {
      if (key === SIDEBAR_SPACER_ID) {
        flushAccordion();
        elements.push(
          <div
            aria-hidden
            data-sidebar-bottom-spacer
            key={`spacer-${elements.length}`}
            style={{ flex: '1 1 0', minHeight: 0 }}
          />,
        );
      } else if (ACCORDION_KEYS.has(key)) {
        const comp = accordionComponents[key]?.(key);
        if (comp) accGroup.push({ element: comp, key });
      } else {
        flushAccordion();
        const link = renderNavLink(key);
        if (link) elements.push(link);
      }
    }
    flushAccordion();

    return elements;
  }, [visibleKeys, renderNavLink, sidebarExpandedKeys, handleAccordionExpandedChange]);

  return (
    <Flexbox flex={1} gap={1} paddingInline={4} style={{ minHeight: '100%' }}>
      {content}
    </Flexbox>
  );
});

export default Body;
