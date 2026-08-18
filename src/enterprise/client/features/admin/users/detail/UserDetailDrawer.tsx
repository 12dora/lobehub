'use client';

import { Drawer } from '@lobehub/ui/base-ui';
import { memo, useCallback, useLayoutEffect, useReducer, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import UserDetailBody from './UserDetailBody';

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
