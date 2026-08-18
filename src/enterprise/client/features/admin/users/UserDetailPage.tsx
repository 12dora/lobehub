'use client';

import { memo } from 'react';
import { useParams } from 'react-router';

import UserDetailBody from './detail/UserDetailBody';

/**
 * `/admin/users/:id` — full-page user detail, kept for deep links (content
 * moderation, bookmarks, audit). The list opens the same body in a slide-in panel.
 */
const UserDetailPage = memo(() => {
  const { id: userId } = useParams<{ id: string }>();

  return <UserDetailBody userId={userId} variant="page" />;
});

UserDetailPage.displayName = 'AdminUserDetailPage';

export default UserDetailPage;
