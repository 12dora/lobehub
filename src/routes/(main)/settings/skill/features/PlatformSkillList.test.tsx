// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PlatformSkillList from './PlatformSkillList';

const mocks = vi.hoisted(() => ({
  catalog: {
    data: undefined as
      | undefined
      | {
          revision: string;
          skills: Array<{
            checksum: string;
            description: string | null;
            displayName: string;
            distribution: 'mandatory' | 'default' | 'optional';
            skillKey: string;
            source: 'builtin' | 'uploaded';
            version: string;
          }>;
        },
    error: undefined as Error | undefined,
    isLoading: false,
    mutate: vi.fn(),
  },
  toolState: {
    platformSkillRuntimeEnforced: true,
    platformSkillRuntimeStatus: 'ready' as 'error' | 'loading' | 'ready' | 'unmanaged',
  },
}));

vi.mock('@/store/tool', () => ({
  useToolStore: (selector: (state: typeof mocks.toolState) => unknown) => selector(mocks.toolState),
}));

vi.mock('@/enterprise/client/features/skills', () => ({
  usePublishedSkillCatalog: () => mocks.catalog,
}));

vi.mock('@/components/AsyncError', () => ({
  default: ({ onRetry }: { onRetry: () => void }) => (
    <button type="button" onClick={onRetry}>
      catalog-error
    </button>
  ),
}));

vi.mock('@/components/Loading/BrandTextLoading', () => ({
  default: () => <div>catalog-loading</div>,
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
    'aria-label': ariaLabel,
    onInputChange,
    value,
  }: {
    'aria-label': string;
    'onInputChange': (value: string) => void;
    'value': string;
  }) => (
    <input
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onInputChange(event.target.value)}
    />
  ),
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({
    'aria-label': ariaLabel,
    children,
    disabled,
    onClick,
  }: {
    'aria-label': string;
    'children': ReactNode;
    'disabled'?: boolean;
    'onClick': () => void;
  }) => (
    <button aria-label={ariaLabel} disabled={disabled} type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock('@lobehub/ui/icons', () => ({ SkillsIcon: () => null }));

vi.mock('antd-style', () => ({
  createStaticStyles: () => ({ badge: '', badges: '' }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { page: number; pages: number }) =>
      values ? `${key}:${values.page}/${values.pages}` : key,
  }),
}));

const LocationProbe = () => {
  const location = useLocation();
  return <span data-testid="location">{location.search}</span>;
};

const renderList = (
  props: ComponentProps<typeof PlatformSkillList> = {},
  initialEntry = '/settings/skill',
) =>
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <PlatformSkillList {...props} />
      <LocationProbe />
    </MemoryRouter>,
  );

const publishedSkill = (index: number) => {
  const suffix = String(index).padStart(3, '0');
  return {
    checksum: 'a'.repeat(64),
    description: `Description ${suffix}`,
    displayName: `Skill ${suffix}`,
    distribution: 'default' as const,
    skillKey: `skill.${suffix}`,
    source: 'uploaded' as const,
    version: '1.0.0',
  };
};

describe('PlatformSkillList', () => {
  beforeEach(() => {
    mocks.catalog.data = undefined;
    mocks.catalog.error = undefined;
    mocks.catalog.isLoading = false;
    mocks.catalog.mutate.mockReset();
    mocks.toolState.platformSkillRuntimeEnforced = true;
    mocks.toolState.platformSkillRuntimeStatus = 'ready';
  });

  it('renders fetch errors before the empty state and retries', () => {
    mocks.catalog.data = { revision: 'cached-empty', skills: [] };
    mocks.catalog.error = new Error('offline');
    renderList();

    expect(screen.getByText('catalog-error')).toBeTruthy();
    expect(screen.queryByText('platformSkills.empty.title')).toBeNull();
    fireEvent.click(screen.getByText('catalog-error'));
    expect(mocks.catalog.mutate).toHaveBeenCalledOnce();
  });

  it('selects a published Skill by stable skillKey', () => {
    const onSelect = vi.fn();
    mocks.catalog.data = {
      revision: 'revision-1',
      skills: [
        {
          checksum: 'a'.repeat(64),
          description: 'Approved',
          displayName: 'Approved Skill',
          distribution: 'default',
          skillKey: 'approved.skill',
          source: 'uploaded',
          version: '1.0.0',
        },
      ],
    };

    renderList({ onSelect });
    fireEvent.click(screen.getByText('Approved Skill'));

    expect(onSelect).toHaveBeenCalledWith('approved.skill', 'platform-skill');
    expect(screen.getByText('platformSkills.distribution.default')).toBeTruthy();
    expect(screen.getByText('v1.0.0')).toBeTruthy();
  });

  it('keeps search and bounded pagination in the URL', async () => {
    mocks.catalog.data = {
      revision: 'revision-large',
      skills: Array.from({ length: 120 }, (_, index) => publishedSkill(index + 1)),
    };
    renderList({}, '/settings/skill?page=2');

    expect(screen.getByText('Skill 051')).toBeTruthy();
    expect(screen.queryByText('Skill 001')).toBeNull();
    expect(screen.getByText('platformSkills.pagination.status:2/3')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'platformSkills.pagination.next' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('page=3'));
    expect(screen.getByText('Skill 101')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('platformSkills.search.label'), {
      target: { value: 'Skill 119' },
    });
    await waitFor(() => {
      const params = new URLSearchParams(screen.getByTestId('location').textContent ?? '');
      expect(params.get('q')).toBe('Skill 119');
      expect(params.get('page')).toBe('1');
    });
    expect(screen.getByText('Skill 119')).toBeTruthy();
    expect(screen.queryByText('Skill 101')).toBeNull();
  });

  it('lets user pagination move away from the selected item without snapping back', async () => {
    mocks.catalog.data = {
      revision: 'revision-large',
      skills: Array.from({ length: 120 }, (_, index) => publishedSkill(index + 1)),
    };
    renderList({ selectedIdentifier: 'skill.001' }, '/settings/skill?page=1');

    fireEvent.click(screen.getByRole('button', { name: 'platformSkills.pagination.next' }));

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('page=2'));
    expect(screen.getByText('Skill 051')).toBeTruthy();
    expect(screen.queryByText('Skill 001')).toBeNull();
  });

  it('restores the page containing the URL-selected Skill', async () => {
    mocks.catalog.data = {
      revision: 'revision-large',
      skills: Array.from({ length: 120 }, (_, index) => publishedSkill(index + 1)),
    };
    renderList({ selectedIdentifier: 'skill.101' }, '/settings/skill?page=1');

    await waitFor(() => {
      const params = new URLSearchParams(screen.getByTestId('location').textContent ?? '');
      expect(params.get('page')).toBe('3');
    });
    expect(screen.getByText('Skill 101')).toBeTruthy();
  });
});
