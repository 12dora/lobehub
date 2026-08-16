// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import Welcome from './Welcome';

const mocks = vi.hoisted(() => ({
  brandingName: 'AIHub',
  duration: 12,
  nickname: 'AIHub 管理员',
}));

vi.mock('react-i18next', () => ({
  Trans: ({ values }: { values?: { appName?: string; username?: string } }) => (
    <span>
      {values?.username}，这是你与 {values?.appName} 一起记录协作的第 {mocks.duration} 天
    </span>
  ),
  useTranslation: () => ({
    i18n: { language: 'zh-CN' },
    t: (key: string) => key,
  }),
}));

vi.mock('@/enterprise/client/providers/RuntimeBrandingProvider', () => ({
  useBranding: () => ({ name: mocks.brandingName }),
}));

vi.mock('@/libs/swr', () => ({
  useClientDataSWR: () => ({
    data: { createdAt: '2024-01-01', duration: mocks.duration, updatedAt: '2024-01-13' },
    isLoading: false,
  }),
}));

vi.mock('@/store/user', () => ({
  useUserStore: (selector: (state: Record<string, unknown>) => unknown) => selector({}),
}));

vi.mock('@/store/user/selectors', () => ({
  userProfileSelectors: {
    nickName: () => mocks.nickname,
    username: () => 'admin',
  },
}));

vi.mock('../components/TimeLabel', () => ({
  default: () => <div>time-label</div>,
}));

describe('Welcome', () => {
  beforeEach(() => {
    mocks.brandingName = 'AIHub';
  });

  it('interpolates the published runtime brand name instead of the compile-time fallback', () => {
    render(<Welcome />);

    expect(
      screen.getByText(/AIHub 管理员，这是你与 AIHub 一起记录协作的第 12 天/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/LobeHub/)).not.toBeInTheDocument();
  });
});
