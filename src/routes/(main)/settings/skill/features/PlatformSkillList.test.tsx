// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
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
}));

vi.mock('@lobehub/ui/icons', () => ({ SkillsIcon: () => null }));

vi.mock('antd-style', () => ({
  createStaticStyles: () => ({ badge: '', badges: '' }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('PlatformSkillList', () => {
  beforeEach(() => {
    mocks.catalog.data = undefined;
    mocks.catalog.error = undefined;
    mocks.catalog.isLoading = false;
    mocks.catalog.mutate.mockReset();
  });

  it('renders fetch errors before the empty state and retries', () => {
    mocks.catalog.error = new Error('offline');
    render(<PlatformSkillList />);

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

    render(<PlatformSkillList onSelect={onSelect} />);
    fireEvent.click(screen.getByText('Approved Skill'));

    expect(onSelect).toHaveBeenCalledWith('approved.skill', 'platform-skill');
    expect(screen.getByText('platformSkills.distribution.default')).toBeTruthy();
    expect(screen.getByText('v1.0.0')).toBeTruthy();
  });
});
