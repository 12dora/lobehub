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
  it('forces the telemetry switch off regardless of the stored setting (telemetry removed)', () => {
    const updateGeneralConfig = vi.fn();
    useUserStore.setState({
      settings: { general: { telemetry: true } },
      updateGeneralConfig,
    });
    vi.spyOn(platformMetaModule, 'usePlatformSettingMeta').mockReturnValue(meta());

    render(<Analytics />, { wrapper });

    // Even with telemetry:true in the store, the anonymous-usage switch renders OFF because the
    // telemetry selector is hard-forced to false (built-in telemetry removed).
    expect(screen.getByRole('switch')).not.toBeChecked();
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
