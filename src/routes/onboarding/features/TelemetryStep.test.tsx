import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PlatformSettingMetaState } from '@/features/PlatformSettingSourceBadge/usePlatformSettingMeta';
import { useUserStore } from '@/store/user';

import TelemetryStep from './TelemetryStep';

const mocks = vi.hoisted(() => ({
  meta: undefined as unknown,
}));

vi.mock('react-i18next', () => ({
  Trans: () => null,
  useTranslation: () => ({ i18n: { language: 'en-US' }, t: (key: string) => key }),
}));

vi.mock('antd-style', () => ({ cssVar: new Proxy({}, { get: () => '#000' }) }));

vi.mock('@lobehub/ui', () => ({
  Block: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button disabled={disabled} type="button" onClick={onClick}>
      {children}
    </button>
  ),
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Icon: () => null,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@lobehub/ui/awesome', () => ({
  TypewriterEffect: ({ sentences }: { sentences: string[] }) => <span>{sentences[0]}</span>,
}));

vi.mock('@lobehub/ui/chat', () => ({ LoadingDots: () => null }));

vi.mock('antd', () => ({ Steps: () => null }));

vi.mock('@lobehub/ui/base-ui', () => ({
  Switch: ({
    checked,
    disabled,
    onChange,
  }: {
    checked?: boolean;
    disabled?: boolean;
    onChange?: (value: boolean) => void;
  }) => (
    <button
      aria-checked={checked}
      disabled={disabled}
      role="switch"
      type="button"
      onClick={() => onChange?.(!checked)}
    />
  ),
}));

vi.mock('@/components/Branding', () => ({ ProductLogo: () => null }));

vi.mock('@/enterprise/client/providers/RuntimeBrandingProvider', () => ({
  useBranding: () => ({ name: 'LobeHub' }),
}));

vi.mock('@/hooks/useDefaultInboxDisplayName', () => ({
  useDefaultInboxDisplayName: () => 'Lobe',
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

const setup = (
  { stored, ...metaOverrides }: Partial<PlatformSettingMetaState> & { stored?: boolean } = {},
  onNext = vi.fn(),
) => {
  const updateGeneralConfig = vi.fn();
  mocks.meta = meta(metaOverrides);
  useUserStore.setState({
    settings: { general: stored === undefined ? {} : { telemetry: stored } },
    updateGeneralConfig,
  });

  render(<TelemetryStep onNext={onNext} />);

  return { onNext, updateGeneralConfig };
};

const switchEl = () => screen.getByRole('switch');
const nextButton = () => screen.getByText('telemetry.next');

afterEach(() => {
  cleanup();
  useUserStore.setState(initialUserStoreState, true);
  vi.clearAllMocks();
});

describe('TelemetryStep', () => {
  it('starts opted out for a new user and records the declined choice', () => {
    const { onNext, updateGeneralConfig } = setup();

    expect(switchEl()).not.toBeChecked();
    expect(switchEl()).toBeEnabled();

    fireEvent.click(nextButton());

    // The decline must be persisted, not just left unset — otherwise nothing marks the choice.
    expect(updateGeneralConfig).toHaveBeenCalledWith({ telemetry: false });
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('persists the opt-in when the user turns the switch on', () => {
    const { updateGeneralConfig } = setup();

    fireEvent.click(switchEl());
    expect(switchEl()).toBeChecked();

    fireEvent.click(nextButton());
    expect(updateGeneralConfig).toHaveBeenCalledWith({ telemetry: true });
  });

  it('reflects an already stored opt-in', () => {
    setup({ stored: true });

    expect(switchEl()).toBeChecked();
  });

  it('forces the switch off and disables it when the platform locks telemetry off', () => {
    const { onNext, updateGeneralConfig } = setup({
      effectiveValue: false,
      enabled: true,
      locked: true,
      mode: 'locked',
      status: 'ready',
      stored: false,
    });

    expect(switchEl()).not.toBeChecked();
    expect(switchEl()).toBeDisabled();
    expect(screen.getByText('telemetry.rows.managed')).toBeInTheDocument();

    fireEvent.click(nextButton());

    // A locked path is owned by the platform: writing the user's local pick would either be
    // rejected server-side or silently diverge from the enforced value.
    expect(updateGeneralConfig).not.toHaveBeenCalled();
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('shows the enforced value when the platform locks telemetry on', () => {
    setup({
      effectiveValue: true,
      enabled: true,
      locked: true,
      mode: 'locked',
      status: 'ready',
      stored: true,
    });

    expect(switchEl()).toBeChecked();
    expect(switchEl()).toBeDisabled();
  });

  it('shows the newly enforced value while the store still holds the old opt-in', () => {
    // The policy is resolved into user settings server-side, but the local store keeps the
    // pre-policy `true` until the next refresh — the switch must not read disabled-but-ON.
    setup({
      effectiveValue: false,
      enabled: true,
      locked: true,
      mode: 'locked',
      status: 'ready',
      stored: true,
    });

    expect(switchEl()).not.toBeChecked();
    expect(switchEl()).toBeDisabled();
  });

  it.each(['loading', 'error'] as const)(
    'keeps the switch non-interactive while the policy is %s',
    (status) => {
      const { updateGeneralConfig } = setup({
        enabled: true,
        // usePlatformSettingMeta fails closed: locked stays true until the policy is known.
        locked: true,
        status,
      });

      expect(switchEl()).toBeDisabled();

      fireEvent.click(nextButton());
      expect(updateGeneralConfig).not.toHaveBeenCalled();
    },
  );

  it('drops the switch entirely when the platform hides the setting', () => {
    setup({ enabled: true, hidden: true, locked: true, status: 'ready' });

    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });
});
