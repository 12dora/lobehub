/**
 * @vitest-environment happy-dom
 */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { AdminUserListItem } from './useUsersListSelection';
import { useUsersListSelection } from './useUsersListSelection';

const row = (id: string): AdminUserListItem =>
  ({
    avatar: null,
    createdAt: new Date(),
    dingtalkTitle: null,
    email: `${id}@example.com`,
    fullName: id,
    id,
    lastActiveAt: null,
    providerIds: [],
    roles: [],
    status: 'active',
    username: id,
  }) as AdminUserListItem;

describe('useUsersListSelection', () => {
  it('never lets the actor own row enter selectedRows and disables its checkbox', () => {
    const { result } = renderHook(() =>
      useUsersListSelection({
        currentUserId: 'self',
        selfActionDisabledTitle: 'users.list.selfActionDisabled',
      }),
    );

    const self = row('self');
    const other = row('other');

    expect(result.current.rowSelection.getCheckboxProps?.(self)).toEqual({
      disabled: true,
      title: 'users.list.selfActionDisabled',
    });
    expect(result.current.rowSelection.getCheckboxProps?.(other)).toEqual({
      disabled: false,
      title: undefined,
    });

    act(() => {
      result.current.rowSelection.onChange?.(['self', 'other'], [self, other], { type: 'all' });
    });

    expect(result.current.selectedRows.map((item) => item.id)).toEqual(['other']);
  });
});
