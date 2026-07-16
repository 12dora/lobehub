import { MotionProvider } from '@lobehub/ui';
import { Switch, Tabs } from '@lobehub/ui/base-ui';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Form } from 'antd';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ManagedFormControlContent } from './ManagedFormControl';
import type { PlatformSettingMetaState } from './usePlatformSettingMeta';

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

describe('ManagedFormControlContent', () => {
  it.each([
    ['flag off', meta()],
    ['flag on', meta({ enabled: true, meta: {} as never, status: 'ready' })],
  ])('preserves named Form switch value/onChange with %s', async (_label, platformMeta) => {
    const onValuesChange = vi.fn();
    render(
      <Form initialValues={{ enabled: true }} onValuesChange={onValuesChange}>
        <Form.Item name="enabled" valuePropName="checked">
          <ManagedFormControlContent meta={platformMeta}>
            <Switch aria-label="memory-enabled" />
          </ManagedFormControlContent>
        </Form.Item>
      </Form>,
      { wrapper },
    );

    const control = screen.getByRole('switch');
    expect(control).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(control);

    await waitFor(() =>
      expect(onValuesChange).toHaveBeenCalledWith({ enabled: false }, expect.anything()),
    );
  });

  it.each([
    ['flag off', meta()],
    ['flag on', meta({ enabled: true, meta: {} as never, status: 'ready' })],
  ])('preserves named Form Tabs activeKey/onChange with %s', async (_label, platformMeta) => {
    const onValuesChange = vi.fn();
    render(
      <Form initialValues={{ animationMode: 'agile' }} onValuesChange={onValuesChange}>
        <Form.Item name="animationMode" valuePropName="activeKey">
          <ManagedFormControlContent meta={platformMeta}>
            <Tabs
              items={[
                { key: 'agile', label: 'Agile' },
                { key: 'elegant', label: 'Elegant' },
              ]}
            />
          </ManagedFormControlContent>
        </Form.Item>
      </Form>,
      { wrapper },
    );

    fireEvent.click(screen.getByText('Elegant'));

    await waitFor(() =>
      expect(onValuesChange).toHaveBeenCalledWith({ animationMode: 'elegant' }, expect.anything()),
    );
  });

  it('renders a real disabled control while policy metadata loads or is locked', () => {
    const { rerender } = render(
      <ManagedFormControlContent meta={meta({ enabled: true, locked: true, status: 'loading' })}>
        <Switch aria-label="managed-switch" />
      </ManagedFormControlContent>,
      { wrapper },
    );

    expect(screen.getByRole('switch')).toBeDisabled();
    expect(screen.getByText('platformSource.loadingMeta')).toBeInTheDocument();

    rerender(
      <ManagedFormControlContent
        meta={meta({ enabled: true, locked: true, mode: 'locked', status: 'ready' })}
      >
        <Switch aria-label="managed-switch" />
      </ManagedFormControlContent>,
    );
    expect(screen.getByRole('switch')).toBeDisabled();
  });

  it('keeps the failed-load control visible, disabled, and retryable', () => {
    const retry = vi.fn().mockResolvedValue(undefined);
    render(
      <ManagedFormControlContent
        meta={meta({
          enabled: true,
          error: new Error('offline'),
          locked: true,
          retry,
          status: 'error',
        })}
      >
        <Switch aria-label="managed-switch" />
      </ManagedFormControlContent>,
      { wrapper },
    );

    expect(screen.getByRole('switch')).toBeDisabled();
    fireEvent.click(screen.getByText('platformSource.retryMeta'));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
