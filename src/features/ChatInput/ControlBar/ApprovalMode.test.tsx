import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useUserStore } from '@/store/user';
import { USER_SELECTABLE_APPROVAL_MODES } from '@/store/user/slices/settings/selectors';

import ModeSelector from './ApprovalMode';

const platformMeta = vi.hoisted(() => ({
  current: { enabled: false, hidden: false, locked: false, status: 'disabled' },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/usePermission', () => ({
  usePermission: () => ({ allowed: true, reason: undefined }),
}));

vi.mock('@/features/PlatformSettingSourceBadge/usePlatformSettingMeta', () => ({
  usePlatformSettingMeta: () => platformMeta.current,
}));

vi.mock('@/features/PlatformSettingSourceBadge/ManagedSettingField', () => ({
  ManagedSettingFieldContent: ({ children }: { children: () => ReactNode }) => children(),
}));

vi.mock('@lobehub/ui', () => ({
  Button: ({ children, disabled }: { children: ReactNode; disabled?: boolean }) => (
    <button disabled={disabled}>{children}</button>
  ),
  Center: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenu: ({
    children,
    items,
  }: {
    children: ReactNode;
    items: Array<{ key: string; label: ReactNode }>;
  }) => (
    <div>
      {children}
      <div data-testid="approval-menu">
        {items.map((item) => (
          <div data-mode={item.key} key={item.key}>
            {item.label}
          </div>
        ))}
      </div>
    </div>
  ),
  Flexbox: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Icon: () => null,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const initialUserStoreState = useUserStore.getState();

afterEach(() => {
  useUserStore.setState(initialUserStoreState, true);
  platformMeta.current = { enabled: false, hidden: false, locked: false, status: 'disabled' };
});

describe('ApprovalMode managed headless presentation', () => {
  it('shows the real Headless label as disabled when the effective platform value is headless', () => {
    const updateHumanIntervention = vi.fn();
    useUserStore.setState({
      settings: { tool: { humanIntervention: { approvalMode: 'headless' } } },
      updateHumanIntervention,
    });
    platformMeta.current = { enabled: true, hidden: false, locked: true, status: 'ready' };

    render(<ModeSelector />);

    expect(screen.getByRole('button', { name: 'tool.intervention.mode.headless' })).toBeDisabled();
    expect(updateHumanIntervention).not.toHaveBeenCalled();
  });

  it('preserves the legacy Auto Approve fallback for raw headless when the feature is off', () => {
    useUserStore.setState({
      settings: { tool: { humanIntervention: { approvalMode: 'headless' } } },
      updateHumanIntervention: vi.fn(),
    });

    render(<ModeSelector />);

    expect(screen.getByRole('button', { name: 'tool.intervention.mode.autoRun' })).toBeEnabled();
  });

  it('shows Headless without locking a platform-default value that users may override', () => {
    useUserStore.setState({
      settings: { tool: { humanIntervention: { approvalMode: 'headless' } } },
      updateHumanIntervention: vi.fn(),
    });
    platformMeta.current = { enabled: true, hidden: false, locked: false, status: 'ready' };

    render(<ModeSelector />);

    expect(screen.getByRole('button', { name: 'tool.intervention.mode.headless' })).toBeEnabled();
    expect(screen.getByTestId('approval-menu').querySelector('[data-mode="headless"]')).toBeNull();
  });

  it('never exposes headless as a user-selectable menu mutation', () => {
    useUserStore.setState({
      settings: { tool: { humanIntervention: { approvalMode: 'manual' } } },
      updateHumanIntervention: vi.fn(),
    });

    render(<ModeSelector />);

    const menu = screen.getByTestId('approval-menu');
    expect(USER_SELECTABLE_APPROVAL_MODES).toEqual(['auto-run', 'allow-list', 'manual']);
    expect(menu.querySelector('[data-mode="headless"]')).toBeNull();
  });
});
