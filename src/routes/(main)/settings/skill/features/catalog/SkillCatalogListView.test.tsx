// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import SkillCatalogListView from './SkillCatalogListView';

vi.mock('@/components/AsyncError', () => ({
  default: ({ onRetry }: { onRetry?: () => void }) => (
    <button type="button" onClick={onRetry}>
      error-retry
    </button>
  ),
}));

vi.mock('@/components/Loading/BrandTextLoading', () => ({
  default: () => <div>loading</div>,
}));

vi.mock('@/features/NavPanel/components/NavItem', () => ({
  default: ({ onClick, title }: { onClick: () => void; title: string }) => (
    <button type="button" onClick={onClick}>
      {title}
    </button>
  ),
}));

vi.mock('@lobehub/ui', () => ({
  Center: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Empty: ({ title }: { title: ReactNode }) => <div>{title}</div>,
  Flexbox: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Icon: () => null,
  SearchBar: ({
    onInputChange,
    value,
  }: {
    onInputChange: (value: string) => void;
    value: string;
  }) => (
    <input
      aria-label="search"
      value={value}
      onChange={(event) => onInputChange(event.target.value)}
    />
  ),
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button disabled={disabled} type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock('@lobehub/ui/icons', () => ({
  SkillsIcon: () => null,
}));

describe('SkillCatalogListView', () => {
  it('filters client-side and selects by injected id', () => {
    const onSelect = vi.fn();
    const setQuery = vi.fn();
    render(
      <SkillCatalogListView
        emptyDesc="empty-desc"
        emptyTitle="empty-title"
        query="alp"
        searchEmptyDesc="no-match-desc"
        searchEmptyTitle="no-match"
        searchLabel="search"
        searchPlaceholder="search…"
        selectedId="a"
        setQuery={setQuery}
        items={[
          {
            displayName: 'Alpha',
            distribution: 'default',
            id: 'a',
            source: 'uploaded',
          },
          {
            displayName: 'Beta',
            distribution: 'optional',
            id: 'b',
            source: 'builtin',
          },
        ]}
        onSelect={onSelect}
      />,
    );

    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.queryByText('Beta')).toBeNull();
    fireEvent.click(screen.getByText('Alpha'));
    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('shows empty when no items and not loading', () => {
    render(
      <SkillCatalogListView
        emptyDesc="empty-desc"
        emptyTitle="empty-title"
        items={[]}
        query=""
        searchEmptyDesc="no-match-desc"
        searchEmptyTitle="no-match"
        searchLabel="search"
        searchPlaceholder="search…"
        setQuery={vi.fn()}
      />,
    );
    expect(screen.getByText('empty-title')).toBeTruthy();
  });

  it('prefers error over empty when fetch failed with no rows', () => {
    render(
      <SkillCatalogListView
        emptyDesc="empty-desc"
        emptyTitle="empty-title"
        error={new Error('boom')}
        items={[]}
        query=""
        searchEmptyDesc="no-match-desc"
        searchEmptyTitle="no-match"
        searchLabel="search"
        searchPlaceholder="search…"
        setQuery={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText('error-retry')).toBeTruthy();
    expect(screen.queryByText('empty-title')).toBeNull();
  });
});
