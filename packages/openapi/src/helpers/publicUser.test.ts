// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type { UserItem } from '@/database/schemas';

import { toPublicUser } from './publicUser';

describe('toPublicUser', () => {
  it('removes trusted enterprise identity claims without mutating the source row', () => {
    const internalUser = {
      dingtalkTitle: 'Engineering Manager',
      dingtalkUserId: 'ding-user-1',
      id: 'user-1',
      username: 'ada',
    } as UserItem;

    expect(toPublicUser(internalUser)).toEqual({ id: 'user-1', username: 'ada' });
    expect(internalUser).toMatchObject({
      dingtalkTitle: 'Engineering Manager',
      dingtalkUserId: 'ding-user-1',
    });
  });
});
