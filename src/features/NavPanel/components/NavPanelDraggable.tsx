'use client';

import { DraggablePanel } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { m, useReducedMotion } from 'motion/react';
import { type ReactNode } from 'react';
import { memo, Suspense, useEffect, useMemo, useRef } from 'react';

import NavPanelUpgradeEntry from '@/business/client/features/NavPanelUpgradeEntry';
import { isDesktop } from '@/const/version';
import { TOGGLE_BUTTON_ID } from '@/features/NavPanel/ToggleLeftPanelButton';
import {
  getInlineSign,
  getSectionDirection,
  NAV_SECTION_TRAVEL_PX,
  SECTION_TRANSITION_EASE,
  SECTION_TRANSITION_S,
  type SectionDirection,
} from '@/features/RouteTransition/timing';
import Footer from '@/routes/(main)/home/_layout/Footer';
import { USER_DROPDOWN_ICON_ID } from '@/routes/(main)/home/_layout/Header/components/User';
import { useGlobalStore } from '@/store/global';
import {
  NAV_PANEL_MAX_WIDTH,
  NAV_PANEL_MIN_WIDTH,
  systemStatusSelectors,
} from '@/store/global/selectors';
import { isMacOS } from '@/utils/platform';

import { useNavPanelSizeChangeHandler } from '../hooks/useNavPanel';
import { BACK_BUTTON_ID } from './BackButton';

const draggableStyles = createStaticStyles(({ css, cssVar }) => ({
  content: css`
    position: relative;

    overflow: hidden;
    display: flex;
    flex-direction: column;

    height: 100%;
    min-height: 100%;
    max-height: 100%;
  `,
  inner: css`
    position: relative;

    overflow: hidden;
    flex: 1;

    min-width: 240px;
    max-width: 100%;
    min-height: 0;
  `,
  layer: css`
    position: absolute;
    inset: 0;

    overflow: hidden;
    display: flex;
    flex-direction: column;

    min-width: 240px;
    max-width: 100%;
    min-height: 100%;
    max-height: 100%;
  `,
  panel: css`
    user-select: none;
    height: 100%;
    color: ${cssVar.colorTextSecondary};
    background: ${isDesktop && isMacOS() ? 'transparent' : cssVar.colorBgLayout};

    * {
      user-select: none;
    }

    #${TOGGLE_BUTTON_ID} {
      width: 0 !important;
      opacity: 0;
      transition:
        opacity,
        width 0.2s ${cssVar.motionEaseOut};
    }

    #${USER_DROPDOWN_ICON_ID} {
      width: 0 !important;
      opacity: 0;
      transition:
        opacity,
        width 0.2s ${cssVar.motionEaseOut};
    }
    #${BACK_BUTTON_ID} {
      width: 24px !important;
    }

    &:hover {
      #${TOGGLE_BUTTON_ID} {
        width: 32px !important;
        opacity: 1;
      }

      #${USER_DROPDOWN_ICON_ID} {
        width: 14px !important;
        opacity: 1;
      }
    }
  `,
}));

interface NavPanelSectionContent {
  key: string;
  node: ReactNode;
}

interface NavPanelDraggableProps {
  activeContent: NavPanelSectionContent;
}

/**
 * Extracted so its first render is the first *real* section: the parent returns
 * a bare placeholder until the persisted panel width hydrates, and a mount flag
 * living up there would already be set by that placeholder — making the first
 * genuine section fade in as if it were a section swap.
 */
const NavPanelSection = memo<{ activeContent: NavPanelSectionContent }>(({ activeContent }) => {
  const reduceMotion = useReducedMotion();

  // The panel's very first section must appear without motion (it is part of the
  // app's first paint, not a section swap).
  const hasRenderedSectionRef = useRef(false);
  useEffect(() => {
    hasRenderedSectionRef.current = true;
  }, []);

  // Hierarchy direction from the shared depth/peer table (`RouteTransition/timing`),
  // never from `history` — a refresh, a workspace-prefixed URL or a `replace` all
  // produce histories that do not describe the level the user perceives.
  const previousKeyRef = useRef<string | null>(null);
  const directionRef = useRef<SectionDirection>(0);
  if (previousKeyRef.current !== activeContent.key) {
    directionRef.current =
      previousKeyRef.current === null
        ? 0
        : getSectionDirection(previousKeyRef.current, activeContent.key);
    previousKeyRef.current = activeContent.key;
  }

  const shouldAnimate = hasRenderedSectionRef.current && !reduceMotion;

  return (
    // Enter-only directional slide, deliberately NOT an `AnimatePresence`
    // crossfade: an exit animation would keep the outgoing sidebar subtree mounted
    // and live for the duration of the transition, so two sidebars would overlap
    // in the accessibility tree (duplicate controls and duplicate DOM ids) and
    // their effects/cleanup would run late. Keying on `activeContent.key`
    // therefore unmounts the old section immediately — exactly the pre-existing
    // remount semantics — and only the incoming section is animated, sliding up
    // over the panel's own opaque background.
    //
    // A transform is safe *here* (unlike on the main outlet): this layer is
    // already `position: absolute` inside an `overflow: hidden` clip, and the
    // footer / upgrade entry are siblings outside it.
    <m.div
      animate={{ opacity: 1, x: 0 }}
      className={draggableStyles.layer}
      key={activeContent.key}
      initial={
        shouldAnimate
          ? { opacity: 0, x: directionRef.current * NAV_SECTION_TRAVEL_PX * getInlineSign() }
          : false
      }
      transition={{
        duration: reduceMotion ? 0 : SECTION_TRANSITION_S,
        ease: SECTION_TRANSITION_EASE,
      }}
    >
      {activeContent.node}
    </m.div>
  );
});

NavPanelSection.displayName = 'NavPanelSection';

const classNames = {
  content: draggableStyles.content,
};

export const NavPanelDraggable = memo<NavPanelDraggableProps>(({ activeContent }) => {
  const [expand, togglePanel, isStatusInit] = useGlobalStore((s) => [
    systemStatusSelectors.showLeftPanel(s),
    s.toggleLeftPanel,
    systemStatusSelectors.isStatusInit(s),
  ]);
  const handleSizeChange = useNavPanelSizeChangeHandler();

  // Defer DraggablePanel mount until system status hydrates; otherwise defaultSize
  // captures the pre-hydration default and the DOM drifts off NavigationBar's live width.
  const defaultWidthRef = useRef(0);
  if (defaultWidthRef.current === 0 && isStatusInit) {
    defaultWidthRef.current = systemStatusSelectors.leftPanelWidth(useGlobalStore.getState());
  }

  const styles = useMemo(
    () => ({
      background: isDesktop && isMacOS() ? 'transparent' : cssVar.colorBgLayout,
      zIndex: 11,
    }),
    [],
  );

  if (defaultWidthRef.current === 0) {
    const pendingWidth = systemStatusSelectors.leftPanelWidth(useGlobalStore.getState());
    return <div aria-hidden style={{ flexShrink: 0, height: '100%', width: pendingWidth }} />;
  }

  const defaultSize = { height: '100%', width: defaultWidthRef.current };

  return (
    <DraggablePanel
      className={draggableStyles.panel}
      classNames={classNames}
      defaultSize={defaultSize}
      expand={expand}
      expandable={false}
      maxWidth={NAV_PANEL_MAX_WIDTH}
      minWidth={NAV_PANEL_MIN_WIDTH}
      placement="left"
      showBorder={false}
      style={styles}
      onExpandChange={togglePanel}
      onSizeDragging={handleSizeChange}
    >
      <div className={draggableStyles.inner}>
        <NavPanelSection activeContent={activeContent} />
      </div>
      <Suspense fallback={null}>
        <NavPanelUpgradeEntry />
      </Suspense>
      <Suspense>
        <Footer />
      </Suspense>
    </DraggablePanel>
  );
});
