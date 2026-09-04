// @vitest-environment happy-dom
import { MotionProvider } from '@lobehub/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  ManagedCompositeSettingFieldContent,
  ManagedSettingFieldContent,
  mergePlatformSettingMetas,
} from './ManagedSettingField';
import type { PlatformSettingMetaState } from './usePlatformSettingMeta';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const wrapper = ({ children }: { children: ReactNode }) => (
  <MotionProvider motion={motion}>{children}</MotionProvider>
);

/** Ready + platform-sourced: the state that renders the 「组织默认」 badge. */
const meta = (overrides: Partial<PlatformSettingMetaState> = {}): PlatformSettingMetaState => ({
  canReset: false,
  enabled: true,
  error: undefined,
  hidden: false,
  isLoading: false,
  locked: false,
  meta: undefined,
  mode: 'default',
  reset: vi.fn().mockResolvedValue(true),
  resetError: null,
  resetting: false,
  retry: vi.fn().mockResolvedValue(undefined),
  source: 'platform',
  status: 'ready',
  ...overrides,
});

const control = () => <button type="button">control</button>;

describe('ManagedCompositeSettingFieldContent', () => {
  it('renders exactly one organization badge for a two-leaf composite', () => {
    render(
      <ManagedCompositeSettingFieldContent metas={[meta(), meta()]}>
        {control}
      </ManagedCompositeSettingFieldContent>,
      { wrapper },
    );

    expect(screen.getAllByText('platformSource.organizationDefault')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'control' })).toHaveLength(1);
  });

  it('still renders one badge once a third (reasoningEffort) leaf joins the cluster', () => {
    render(
      <ManagedCompositeSettingFieldContent metas={[meta(), meta(), meta()]}>
        {control}
      </ManagedCompositeSettingFieldContent>,
      { wrapper },
    );

    expect(screen.getAllByText('platformSource.organizationDefault')).toHaveLength(1);
  });

  it('matches the single-meta field for one leaf', () => {
    const single = render(
      <ManagedSettingFieldContent meta={meta()}>{control}</ManagedSettingFieldContent>,
      { wrapper },
    );
    const singleBadges = screen.getAllByText('platformSource.organizationDefault').length;
    single.unmount();

    render(
      <ManagedCompositeSettingFieldContent metas={[meta()]}>
        {control}
      </ManagedCompositeSettingFieldContent>,
      { wrapper },
    );

    expect(screen.getAllByText('platformSource.organizationDefault')).toHaveLength(singleBadges);
  });

  it('renders children unmanaged when there are no metas', () => {
    render(
      <ManagedCompositeSettingFieldContent metas={[]}>
        {control}
      </ManagedCompositeSettingFieldContent>,
      { wrapper },
    );

    expect(screen.queryByText('platformSource.organizationDefault')).toBeNull();
    expect(screen.getByRole('button', { name: 'control' })).toBeInTheDocument();
  });

  it('hides the whole control when any leaf is hidden', () => {
    render(
      <ManagedCompositeSettingFieldContent metas={[meta(), meta({ hidden: true })]}>
        {control}
      </ManagedCompositeSettingFieldContent>,
      { wrapper },
    );

    expect(screen.queryByRole('button', { name: 'control' })).toBeNull();
  });

  it('disables the control when any single leaf is locked', () => {
    const children = vi.fn(() => <button type="button">control</button>);
    render(
      <ManagedCompositeSettingFieldContent metas={[meta(), meta({ locked: true, mode: 'locked' })]}>
        {children}
      </ManagedCompositeSettingFieldContent>,
      { wrapper },
    );

    expect(children).toHaveBeenCalledWith({ disabled: true, hidden: false, locked: true });
    // Locked outranks the org-default badge, and still only one header is drawn.
    expect(screen.getAllByText('platformSource.managedByOrg')).toHaveLength(1);
    expect(screen.queryByText('platformSource.organizationDefault')).toBeNull();
  });

  it('resets every resettable leaf from the single merged action', () => {
    const first = meta({ canReset: true, mode: 'default', source: 'user' });
    const second = meta({ canReset: true, mode: 'default', source: 'user' });

    render(
      <ManagedCompositeSettingFieldContent metas={[first, second]}>
        {control}
      </ManagedCompositeSettingFieldContent>,
      { wrapper },
    );

    expect(screen.getAllByText('platformSource.personal')).toHaveLength(1);
    fireEvent.click(screen.getByText('platformSource.resetToOrg'));

    expect(first.reset).toHaveBeenCalledTimes(1);
    expect(second.reset).toHaveBeenCalledTimes(1);
  });
});

describe('mergePlatformSettingMetas', () => {
  it('fails closed on status: any loading leaf makes the cluster loading', () => {
    expect(mergePlatformSettingMetas([meta(), meta({ status: 'loading' })]).status).toBe('loading');
    expect(mergePlatformSettingMetas([meta(), meta({ status: 'error' })]).status).toBe('error');
    expect(mergePlatformSettingMetas([meta(), meta()]).status).toBe('ready');
  });

  it('carries the leading leaf effective value, matching how `meta` is merged', () => {
    expect(
      mergePlatformSettingMetas([meta({ effectiveValue: 'gpt-5' }), meta({ effectiveValue: 'o3' })])
        .effectiveValue,
    ).toBe('gpt-5');
  });

  it('retries every leaf', async () => {
    const first = meta();
    const second = meta();

    await mergePlatformSettingMetas([first, second]).retry();

    expect(first.retry).toHaveBeenCalledTimes(1);
    expect(second.retry).toHaveBeenCalledTimes(1);
  });
});
