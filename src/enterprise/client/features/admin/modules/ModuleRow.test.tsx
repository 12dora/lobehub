import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PlatformModuleId } from '@/const/platform/modules';

import ModuleRow from './ModuleRow';

/**
 * Real module ids, invented costs: the assertions are about which chips a given cost shape
 * earns, and pinning them to the measured constant table would turn a re-measurement into a
 * failing UI test.
 */
vi.mock('@/const/platform/modules', () => {
  const free = {
    backgroundJobs: 0,
    externalDeps: [] as string[],
    idleRssMb: 0 as number | null,
    loadKind: 'none',
    loadSensitive: false,
    subprocess: false,
  };

  return {
    PLATFORM_MODULES: {
      audit: { cost: { ...free, idleRssMb: null }, kind: 'hot' },
      bots: { cost: { ...free, idleRssMb: 22 }, kind: 'hot' },
      knowledgeBase: { cost: { ...free, externalDeps: ['s3'] }, kind: 'hot' },
      managedSkills: { cost: { ...free }, kind: 'hot' },
      memory: { cost: { ...free, loadKind: 'perMessage' }, kind: 'hot' },
      platformStats: { cost: { ...free, loadKind: 'onUse' }, kind: 'hot' },
    },
  };
});

/** base-ui's Switch needs a ConfigProvider no admin page mounts; the chips are what is under test. */
vi.mock('@lobehub/ui/base-ui', () => ({
  Switch: ({ checked, disabled }: { checked?: boolean; disabled?: boolean }) => (
    <button aria-checked={Boolean(checked)} disabled={disabled} role="switch" type="button" />
  ),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const entries = Object.entries(options ?? {}).filter(([name]) => name !== 'defaultValue');
      if (entries.length === 0) return key;
      return `${key}(${entries.map(([name, value]) => `${name}=${String(value)}`).join(',')})`;
    },
  }),
}));

/** Blocks stacked in the row's text column: title, description, and the chip row when it exists. */
const blockCount = (container: HTMLElement) =>
  container.querySelector('[data-module]')!.firstElementChild!.children.length;

const renderRow = (id: string) =>
  render(
    <ModuleRow
      checked
      id={id as PlatformModuleId}
      pendingRestart={false}
      readOnly={false}
      unmetDependencies={[]}
      onChange={() => {}}
    />,
  );

describe('ModuleRow cost chips', () => {
  it('renders no load chip for an on-demand module', () => {
    renderRow('platformStats');

    expect(screen.queryByText(/modules\.tags\.loadKind/)).toBeNull();
  });

  it('still renders the load chip for work that happens on every message', () => {
    renderRow('memory');

    expect(screen.getByText('modules.tags.loadKind.perMessage')).toBeTruthy();
  });

  it('hides the memory chip at zero and shows it above zero', () => {
    const { unmount } = renderRow('managedSkills');
    expect(screen.queryByText(/modules\.tags\.idleRss/)).toBeNull();
    unmount();

    renderRow('bots');
    expect(screen.getByText('modules.tags.idleRss(mb=22)')).toBeTruthy();
  });

  it('hides the memory chip when nothing was measured', () => {
    renderRow('audit');

    expect(screen.queryByText(/modules\.tags\.idleRss/)).toBeNull();
  });

  it('renders an external dependency as a requirement, not a bare noun', () => {
    renderRow('knowledgeBase');

    expect(screen.getByText('modules.tags.requires(dep=modules.deps.s3)')).toBeTruthy();
    expect(screen.queryByText('modules.deps.s3')).toBeNull();
  });

  it('drops the chip row entirely when the module costs nothing notable', () => {
    // The wrapper carries its own top margin, so an empty one would pad every free module.
    // Counted against a costed row so the check cannot pass just because the DOM moved.
    const costed = renderRow('bots');
    const withTags = blockCount(costed.container);
    costed.unmount();

    const { container } = renderRow('platformStats');

    expect(screen.queryAllByText(/modules\.tags\./)).toHaveLength(0);
    expect(blockCount(container)).toBe(withTags - 1);
  });
});
