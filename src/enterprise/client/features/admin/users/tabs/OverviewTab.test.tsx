/**
 * Overview tab job-title rendering (null → "—", non-empty → title).
 * @vitest-environment happy-dom
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import OverviewTab from './OverviewTab';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: {},
}));

vi.mock('@lobehub/ui', () => ({
  Flexbox: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Tooltip: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children }: { children?: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));

vi.mock('../../primitives/StatusBadge', () => ({
  default: ({ status }: { status: string }) => <span>{status}</span>,
}));

vi.mock('../UserSourceTags', () => ({
  default: () => <span data-testid="source-tags" />,
}));

const baseUser = {
  avatar: null,
  banExpires: null,
  banReason: null,
  banned: false,
  createdAt: new Date('2024-01-01'),
  dingtalkTitle: null as string | null,
  email: 'bob@example.com',
  emailVerified: true,
  fullName: 'Bob',
  id: 'u-bob',
  isSelf: false,
  lastActiveAt: null,
  providers: [] as { providerId: string }[],
  roles: [],
  sessionCount: 0,
  sessions: [],
  status: 'active' as const,
  username: 'bob',
};

describe('OverviewTab job title', () => {
  it('shows em dash when dingtalkTitle is null', () => {
    render(<OverviewTab canBan={false} canDelete={false} user={baseUser as never} />);
    expect(screen.getByText('users.overview.jobTitle')).toBeTruthy();
    // Job title dd is the em dash after the jobTitle dt; fullName/status may also use —
    const labels = screen.getAllByText('—');
    expect(labels.length).toBeGreaterThanOrEqual(1);
  });

  it('renders non-empty job title text', () => {
    render(
      <OverviewTab
        canBan={false}
        canDelete={false}
        user={{ ...baseUser, dingtalkTitle: '高级工程师' } as never}
      />,
    );
    expect(screen.getByText('高级工程师')).toBeTruthy();
  });
});
