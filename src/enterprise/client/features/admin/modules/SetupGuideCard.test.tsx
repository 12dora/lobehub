import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import type { AdminModulesState } from '@/enterprise/client/services/adminModules';

import SetupGuideCard from './SetupGuideCard';
import { isSetupGuideDismissed } from './setupGuideDismissal';

const access = {
  permissions: [PLATFORM_PERMISSIONS.SYSTEM_READ] as string[],
  status: 'allowed' as string,
};
const state = { data: undefined as AdminModulesState | undefined };

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('react-router', () => ({ useNavigate: () => vi.fn() }));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, onClick }: { children?: unknown; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children as never}
    </button>
  ),
}));

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => access,
}));

vi.mock('./useAdminModules', () => ({
  useAdminModules: () => ({ data: state.data }),
}));

const buildState = (setupCompletedAt: string | null): AdminModulesState =>
  ({ snapshot: { setupCompletedAt } }) as AdminModulesState;

beforeEach(() => {
  window.sessionStorage.clear();
  access.permissions = [PLATFORM_PERMISSIONS.SYSTEM_READ];
  state.data = buildState(null);
});

describe('SetupGuideCard', () => {
  it('invites the operator to finish setup while the marker is missing', () => {
    render(<SetupGuideCard />);
    expect(screen.getByText('modules.guide.title')).toBeTruthy();
  });

  it('disappears once setup has been completed', () => {
    state.data = buildState('2026-08-17T00:00:00.000Z');
    render(<SetupGuideCard />);
    expect(screen.queryByText('modules.guide.title')).toBeNull();
  });

  it('stays dismissed across remounts within the session', () => {
    const first = render(<SetupGuideCard />);
    fireEvent.click(screen.getByText('modules.guide.later'));
    expect(screen.queryByText('modules.guide.title')).toBeNull();
    expect(isSetupGuideDismissed()).toBe(true);

    // Navigating away and back used to bring the card straight back.
    first.unmount();
    render(<SetupGuideCard />);
    expect(screen.queryByText('modules.guide.title')).toBeNull();
  });

  it('never shows to an admin who could not act on it', () => {
    access.permissions = [];
    render(<SetupGuideCard />);
    expect(screen.queryByText('modules.guide.title')).toBeNull();
  });
});
