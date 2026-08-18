'use client';

import { Drawer } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { memo, useCallback, useLayoutEffect, useReducer, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import UserDetailBody from './UserDetailBody';

const styles = createStaticStyles(({ css }) => ({
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
   * hidden` would, handing the focus trap something to scroll instead. The clip margin
   * keeps the panel's drop shadow (9px offset + 28px blur + 8px spread) painted.
   */
  popup: css`
    overflow: clip;
    overflow-clip-margin: 48px;
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
 * Mask, ESC and the close icon are the component defaults — all three dismiss.
 */
const UserDetailDrawer = memo<UserDetailDrawerProps>(({ onClose, open, userId }) => {
  const { t } = useTranslation('admin');

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

  const handleAfterOpenChange = useCallback((nextOpen: boolean) => {
    if (nextOpen) return;
    // A close → reopen faster than the animation already re-derived the body from
    // `userId`, so dropping the outgoing id here is always safe.
    lastCommittedUserIdRef.current = null;
    forceRender();
  }, []);

  return (
    <Drawer
      afterOpenChange={handleAfterOpenChange}
      classNames={{ popup: styles.popup }}
      open={open}
      placement="right"
      title={t('users.detail.title')}
      width="min(760px, calc(100vw - 48px))"
      onClose={onClose}
    >
      {renderedUserId ? (
        <UserDetailBody
          key={renderedUserId}
          userId={renderedUserId}
          variant="drawer"
          onDeleted={onClose}
          onDismiss={onClose}
        />
      ) : null}
    </Drawer>
  );
});

UserDetailDrawer.displayName = 'AdminUserDetailDrawer';

export default UserDetailDrawer;
