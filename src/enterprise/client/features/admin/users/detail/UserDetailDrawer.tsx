'use client';

import {
  DrawerBackdrop,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerPopup,
  DrawerPortal,
  DrawerRoot,
  DrawerTitle,
} from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { useReducedMotion } from 'motion/react';
import { memo, useCallback, useLayoutEffect, useMemo, useReducer, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import UserDetailBody from './UserDetailBody';

/** Space kept inside the clipped popup box for the panel's drop shadow. */
const SHADOW_GUTTER = 48;
/**
 * Content width. 560px fits the description grids, the session rows and the role
 * card without stranding whitespace; anything wider only spread the same facts out.
 */
export const USER_PANEL_WIDTH = 'min(560px, calc(100vw - 48px))';

/**
 * Motion for the panel. The library default (300ms in / 220ms out, aggressive ease)
 * reads as a snap; this is a longer, decelerating enter and a slightly quicker,
 * symmetric exit — the "settle into place" feel of a sheet rather than a pop-up.
 */
export const USER_PANEL_ENTER_TRANSITION = { duration: 0.48, ease: [0.22, 1, 0.36, 1] } as const;
export const USER_PANEL_EXIT_TRANSITION = { duration: 0.34, ease: [0.4, 0, 0.2, 1] } as const;

/**
 * `motionProps` handed to `DrawerPopup`. They are spread after the atom's own
 * config, so `transition` / `exit` here replace the library defaults; `initial`
 * and `animate` (off-screen → in place) stay the atom's.
 */
export const resolveUserPanelMotion = (reduceMotion: boolean | null) =>
  reduceMotion
    ? {
        exit: { transition: { duration: 0 }, x: '100%' },
        transition: { duration: 0 },
      }
    : {
        exit: { transition: USER_PANEL_EXIT_TRANSITION, x: '100%' },
        transition: USER_PANEL_ENTER_TRANSITION,
      };

const styles = createStaticStyles(({ css }) => ({
  body: css`
    display: flex;
    flex-direction: column;

    width: 100%;
    min-height: 100%;
    padding-block: 12px 24px;
    padding-inline: 20px;
  `,
  /**
   * Keeps the page still while the panel slides in.
   *
   * Root cause: `src/styles/global.ts` sets `transform: translateZ(0)` on `body`, so
   * `body` is the containing block of every `position: fixed` box — this drawer's popup
   * wrapper included. The motion panel enters at `translateX(100%)`, sticking a full
   * panel width past the viewport, which grows `body.scrollWidth`; the dialog's focus
   * trap then scrolls `body` (still programmatically scrollable under `overflow: hidden`)
   * to reveal the close button, so the nav, title and table jump left and slide back as
   * the panel lands.
   *
   * `overflow: clip` cuts the entering panel at the popup's own fixed box, removing that
   * scrollable overflow without making the popup a scroll container — which `overflow:
   * hidden` would, handing the focus trap something to scroll instead. An
   * `overflow-clip-margin` would re-extend the scrollable overflow by the same amount
   * (verified: the page still jumped by exactly the margin), so the room for the panel's
   * drop shadow (9px offset + 28px blur + 8px spread) comes from padding INSIDE the clipped
   * box instead: the popup is widened by ${SHADOW_GUTTER}px on the page side and the panel
   * (flex: 1) keeps its own width.
   */
  popup: css`
    overflow: clip;
    padding-inline-start: ${SHADOW_GUTTER}px;
  `,
}));

export interface UserDetailDrawerProps {
  onClose: () => void;
  open: boolean;
  userId: string | null;
}

/**
 * Slide-in user detail. Stacks over the list instead of navigating away, so the
 * operator keeps their page, filters and selection. `/admin/users/:id` stays a
 * full page for deep links (content moderation, bookmarks).
 *
 * Composed from the base-ui Drawer atoms rather than `<Drawer>` because the packaged
 * component hard-codes its motion; everything else (modal mask, ESC / outside press
 * → close, close button, `afterOpenChange` via exit-complete) mirrors it.
 */
const UserDetailDrawer = memo<UserDetailDrawerProps>(({ onClose, open, userId }) => {
  const { t } = useTranslation('admin');
  const reduceMotion = useReducedMotion();

  /**
   * The rendered user is derived from `userId` in the same render — never mirrored
   * into state. Mirroring lagged one render behind: reopening after an exit painted
   * an empty panel first, and switching A → B committed A's body once more.
   *
   * The ref only keeps the *outgoing* user alive while the panel slides out
   * (`open === false`, search param already cleared) so the body does not blank
   * mid-animation; it is dropped once the exit animation reports back.
   *
   * It is written from a layout effect, never during render: a concurrent render
   * that is started and then abandoned (transition + suspended child) would
   * otherwise leave its user in the ref and paint that never-committed user
   * during the next exit.
   */
  const lastCommittedUserIdRef = useRef<string | null>(null);
  const [, forceRender] = useReducer((tick: number) => tick + 1, 0);

  const renderedUserId = userId ?? (open ? null : lastCommittedUserIdRef.current);

  // No dependency list on purpose: every commit re-arms the outgoing user, including
  // the one forced right after a stale exit callback cleared the ref.
  useLayoutEffect(() => {
    if (userId) lastCommittedUserIdRef.current = userId;
  });

  const handleExitComplete = useCallback(() => {
    // A close → reopen faster than the animation already re-derived the body from
    // `userId`, so dropping the outgoing id here is always safe.
    lastCommittedUserIdRef.current = null;
    forceRender();
  }, []);

  // ESC, outside press and the close button all arrive here as `nextOpen === false`.
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen || !open) return;
      onClose();
    },
    [onClose, open],
  );

  const motionProps = useMemo(() => resolveUserPanelMotion(reduceMotion), [reduceMotion]);

  return (
    <DrawerRoot
      modal
      open={open}
      onExitComplete={handleExitComplete}
      onOpenChange={handleOpenChange}
    >
      <DrawerPortal>
        <DrawerBackdrop />
        <DrawerPopup
          className={styles.popup}
          motionProps={motionProps}
          placement="right"
          popupStyle={{ width: `calc(${USER_PANEL_WIDTH} + ${SHADOW_GUTTER}px)` }}
          width={USER_PANEL_WIDTH}
        >
          <DrawerHeader>
            <DrawerTitle>{t('users.detail.title')}</DrawerTitle>
            <DrawerClose aria-label={t('users.detail.closePanel')} />
          </DrawerHeader>
          <DrawerContent>
            <div className={styles.body}>
              {renderedUserId ? (
                <UserDetailBody
                  key={renderedUserId}
                  userId={renderedUserId}
                  variant="drawer"
                  onDeleted={onClose}
                  onDismiss={onClose}
                />
              ) : null}
            </div>
          </DrawerContent>
        </DrawerPopup>
      </DrawerPortal>
    </DrawerRoot>
  );
});

UserDetailDrawer.displayName = 'AdminUserDetailDrawer';

export default UserDetailDrawer;
