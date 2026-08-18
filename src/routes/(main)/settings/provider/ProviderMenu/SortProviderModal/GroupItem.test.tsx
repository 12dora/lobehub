import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { type AiProviderListItem, AiProviderSourceEnum } from '@/types/aiProvider';

import GroupItem from './GroupItem';

vi.mock('@lobehub/icons', () => ({ ProviderIcon: () => null }));

vi.mock('@lobehub/ui', () => {
  const SortableList = { DragHandle: () => null };

  return {
    Avatar: () => null,
    Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    SortableList,
  };
});

// The `providers` namespace ships a name key only for the handful of ids that opt in.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      key === 'chatgptweb.name' ? 'ChatGPT 网页版' : (options?.defaultValue ?? key),
  }),
}));

describe('GroupItem', () => {
  it('names a builtin from its card, so the reorder dialog agrees with the sidebar', () => {
    render(
      <GroupItem
        enabled
        id={'supergrok'}
        name={'SuperGrok'}
        source={AiProviderSourceEnum.Builtin}
      />,
    );

    expect(screen.getByText('Grok')).toBeTruthy();
    expect(screen.queryByText('SuperGrok')).toBeNull();
  });

  it('keeps a legacy custom row’s name when the source column is empty', () => {
    // `source` is nullable in the database, and reading the empty column as "builtin" left the
    // dialog listing a raw id where the row has a perfectly good name.
    render(
      <GroupItem
        enabled
        id={'internal_proxy'}
        name={'Internal Gateway'}
        source={undefined as unknown as AiProviderListItem['source']}
      />,
    );

    expect(screen.getByText('Internal Gateway')).toBeTruthy();
    expect(screen.queryByText('internal_proxy')).toBeNull();
  });

  it('still names a builtin id from its card when the source column is empty', () => {
    render(
      <GroupItem
        enabled
        id={'supergrok'}
        name={'SuperGrok'}
        source={undefined as unknown as AiProviderListItem['source']}
      />,
    );

    expect(screen.getByText('Grok')).toBeTruthy();
  });
});
