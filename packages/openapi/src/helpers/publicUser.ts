import type { UserItem } from '@/database/schemas';

export type PublicUserItem = Omit<UserItem, 'dingtalkTitle' | 'dingtalkUserId'>;

export const toPublicUser = (user: UserItem): PublicUserItem => {
  const { dingtalkTitle: _dingtalkTitle, dingtalkUserId: _dingtalkUserId, ...publicUser } = user;
  return publicUser;
};
