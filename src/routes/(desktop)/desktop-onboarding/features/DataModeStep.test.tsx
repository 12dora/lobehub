import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PlatformSettingMetaState } from '@/features/PlatformSettingSourceBadge/usePlatformSettingMeta';
import { useUserStore } from '@/store/user';

import DataModeStep from './DataModeStep';

const mocks = vi.hoisted(() => ({
  meta: undefined as unknown,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('antd-style', () => ({ cssVar: new Proxy({}, { get: () => '#000' }) }));

vi.mock('@lobehub/ui', () => ({
  Block: ({
    children,
    clickable,
    onClick,
  }: {
    children?: ReactNode;
    clickable?: boolean;
    onClick?: () => void;
  }) => (
    <button data-clickable={String(!!clickable)} type="button" onClick={onClick}>
      {children}
    </button>
  ),
  Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  Checkbox: () => <span data-testid="selected-check" />,
  Empty: ({ description, title }: { description?: ReactNode; title?: ReactNode }) => (
    <div>
      <span>{title}</span>
      <span>{description}</span>
    </div>
  ),
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@/enterprise/client/providers/RuntimeBrandingProvider', () => ({
  useBranding: () => ({ name: 'LobeHub' }),
}));

vi.mock('../components/LobeMessage', () => ({ default: () => null }));

vi.mock('../components/OnboardingFooterActions', () => ({
  default: ({ left, right }: { left?: ReactNode; right?: ReactNode }) => (
    <div>
      {left}
      {right}
    </div>
  ),
}));

vi.mock('@/features/PlatformSettingSourceBadge/usePlatformSettingMeta', () => ({
  usePlatformSettingMeta: () => mocks.meta,
}));

const meta = (overrides: Partial<PlatformSettingMetaState> = {}): PlatformSettingMetaState =>
  ({
    canReset: false,
    enabled: false,
    error: undefined,
    hidden: false,
    isLoading: false,
    locked: false,
    meta: undefined,
    mode: undefined,
    reset: vi.fn(),
    resetError: null,
    resetting: false,
    retry: vi.fn(),
    source: undefined,
    status: 'disabled',
    ...overrides,
  }) as PlatformSettingMetaState;

const initialUserStoreState = useUserStore.getState();

const setup = ({
  stored,
  ...metaOverrides
}: Partial<PlatformSettingMetaState> & { stored?: boolean } = {}) => {
  const updateGeneralConfig = vi.fn();
  mocks.meta = meta(metaOverrides);
  useUserStore.setState({
    settings: { general: stored === undefined ? {} : { telemetry: stored } },
    updateGeneralConfig,
  });

  render(<DataModeStep onBack={vi.fn()} onNext={vi.fn()} />);

  return { updateGeneralConfig };
};

/** The two mode cards are the only `Block`s on the screen, in share-then-privacy order. */
const modeCards = () => screen.getAllByRole('button').filter((el) => el.dataset.clickable);
const shareCard = () => modeCards()[0]!;
const privacyCard = () => modeCards()[1]!;

afterEach(() => {
  cleanup();
  useUserStore.setState(initialUserStoreState, true);
  vi.clearAllMocks();
});

describe('DataModeStep', () => {
  it('defaults to privacy mode when telemetry has never been enabled', () => {
    setup();

    expect(privacyCard()).toContainElement(screen.getByTestId('selected-check'));
    expect(screen.getByText('screen4.footerNote')).toBeInTheDocument();
  });

  it('lets an unmanaged user opt in', () => {
    const { updateGeneralConfig } = setup();

    fireEvent.click(shareCard());

    expect(updateGeneralConfig).toHaveBeenCalledWith({ telemetry: true });
  });

  it('pins the choice to the enforced value and stops writes when the platform locks telemetry', () => {
    const { updateGeneralConfig } = setup({
      effectiveValue: false,
      enabled: true,
      locked: true,
      mode: 'locked',
      status: 'ready',
      stored: false,
    });

    expect(privacyCard()).toContainElement(screen.getByTestId('selected-check'));
    expect(shareCard().dataset.clickable).toBe('false');
    expect(screen.getByText('screen4.managed')).toBeInTheDocument();

    fireEvent.click(shareCard());

    expect(updateGeneralConfig).not.toHaveBeenCalled();
    expect(privacyCard()).toContainElement(screen.getByTestId('selected-check'));
  });

  it('follows the newly enforced value while the store still holds the old opt-in', () => {
    // The store keeps the pre-policy `true` until the next refresh, so reading it would show
    // the share card as the enforced pick when the platform has just turned telemetry off.
    setup({
      effectiveValue: false,
      enabled: true,
      locked: true,
      mode: 'locked',
      status: 'ready',
      stored: true,
    });

    expect(privacyCard()).toContainElement(screen.getByTestId('selected-check'));
  });

  it('keeps the share card selected when the platform locks telemetry on', () => {
    setup({
      effectiveValue: true,
      enabled: true,
      locked: true,
      mode: 'locked',
      status: 'ready',
      stored: false,
    });

    expect(shareCard()).toContainElement(screen.getByTestId('selected-check'));
  });
});
