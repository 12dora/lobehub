import { MotionProvider } from '@lobehub/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PlatformSettingMetaState } from '@/features/PlatformSettingSourceBadge/usePlatformSettingMeta';
import * as platformMetaModule from '@/features/PlatformSettingSourceBadge/usePlatformSettingMeta';
import { useUserStore } from '@/store/user';

import Analytics from './Analytics';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const wrapper = ({ children }: { children: ReactNode }) => (
  <MotionProvider motion={motion}>{children}</MotionProvider>
);

const meta = (overrides: Partial<PlatformSettingMetaState> = {}): PlatformSettingMetaState => ({
  canReset: false,
  enabled: false,
  error: undefined,
  hidden: false,
  isLoading: false,
  locked: false,
  meta: undefined,
  mode: undefined,
  reset: vi.fn().mockResolvedValue(true),
  resetError: null,
  resetting: false,
  retry: vi.fn().mockResolvedValue(undefined),
  source: undefined,
  status: 'disabled',
  ...overrides,
});

const initialUserStoreState = useUserStore.getState();

afterEach(() => {
  useUserStore.setState(initialUserStoreState, true);
  vi.restoreAllMocks();
});

describe('Analytics managed setting row', () => {
  it('reflects and updates the stored setting when unmanaged', () => {
    const updateGeneralConfig = vi.fn();
    useUserStore.setState({
      settings: { general: { telemetry: true } },
      updateGeneralConfig,
    });
    vi.spyOn(platformMetaModule, 'usePlatformSettingMeta').mockReturnValue(meta());

    render(<Analytics />, { wrapper });

    expect(screen.getByRole('switch')).toBeChecked();

    fireEvent.click(screen.getByRole('switch'));
    expect(updateGeneralConfig).toHaveBeenCalledWith({ telemetry: false });
  });

  it('defaults to off for a user who never opted in', () => {
    useUserStore.setState({ settings: { general: {} } });
    vi.spyOn(platformMetaModule, 'usePlatformSettingMeta').mockReturnValue(meta());

    render(<Analytics />, { wrapper });

    expect(screen.getByRole('switch')).not.toBeChecked();
  });

  it('keeps a locked-off setting visible but greyed out', () => {
    const updateGeneralConfig = vi.fn();
    useUserStore.setState({ settings: { general: { telemetry: false } }, updateGeneralConfig });
    vi.spyOn(platformMetaModule, 'usePlatformSettingMeta').mockReturnValue(
      meta({ effectiveValue: false, enabled: true, locked: true, mode: 'locked', status: 'ready' }),
    );

    render(<Analytics />, { wrapper });

    expect(screen.getByText('analytics.telemetry.title')).toBeInTheDocument();
    expect(screen.getByRole('switch')).not.toBeChecked();
    expect(screen.getByRole('switch')).toBeDisabled();

    fireEvent.click(screen.getByRole('switch'));
    expect(updateGeneralConfig).not.toHaveBeenCalled();
  });

  it('shows the enforced value, not the stale stored opt-in, on a locked path', () => {
    // The store still carries the pre-policy `true` until the next user-state refresh, so a
    // store-driven switch would render disabled-but-ON against a policy that enforces OFF.
    useUserStore.setState({ settings: { general: { telemetry: true } } });
    vi.spyOn(platformMetaModule, 'usePlatformSettingMeta').mockReturnValue(
      meta({ effectiveValue: false, enabled: true, locked: true, mode: 'locked', status: 'ready' }),
    );

    render(<Analytics />, { wrapper });

    expect(screen.getByRole('switch')).not.toBeChecked();
    expect(screen.getByRole('switch')).toBeDisabled();
  });

  it('shows a locked-on setting as on even when the store has not caught up', () => {
    useUserStore.setState({ settings: { general: { telemetry: false } } });
    vi.spyOn(platformMetaModule, 'usePlatformSettingMeta').mockReturnValue(
      meta({ effectiveValue: true, enabled: true, locked: true, mode: 'locked', status: 'ready' }),
    );

    render(<Analytics />, { wrapper });

    expect(screen.getByRole('switch')).toBeChecked();
    expect(screen.getByRole('switch')).toBeDisabled();
  });

  it('removes the complete label, description and control when hidden', () => {
    vi.spyOn(platformMetaModule, 'usePlatformSettingMeta').mockReturnValue(
      meta({ enabled: true, hidden: true, status: 'ready' }),
    );

    const { container } = render(<Analytics />, { wrapper });

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('analytics.telemetry.title')).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it.each(['loading', 'error'] as const)(
    'keeps the row visible and non-interactive during metadata %s',
    (status) => {
      const retry = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(platformMetaModule, 'usePlatformSettingMeta').mockReturnValue(
        meta({
          enabled: true,
          error: status === 'error' ? new Error('offline') : undefined,
          locked: true,
          retry,
          status,
        }),
      );

      render(<Analytics />, { wrapper });

      expect(screen.getByText('analytics.telemetry.title')).toBeInTheDocument();
      expect(screen.getByRole('switch')).toBeDisabled();
      if (status === 'error') {
        fireEvent.click(screen.getByText('platformSource.retryMeta'));
        expect(retry).toHaveBeenCalledTimes(1);
      }
    },
  );
});
