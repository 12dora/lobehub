import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getEffectiveApprovalMode, toSelectableApprovalMode } from './approvalMode';

const platformMeta = vi.hoisted(() => ({ current: undefined as { locked: boolean } | undefined }));
const userSettings = vi.hoisted(() => ({ approvalMode: 'manual' as string | undefined }));

vi.mock('@/helpers/platformSettingLocks', () => ({
  isPlatformSettingLocked: () => platformMeta.current?.locked === true,
}));

vi.mock('@/store/user/store', () => ({
  getUserStoreState: () => ({}),
}));

vi.mock('@/store/user/selectors', () => ({
  toolInterventionSelectors: {
    rawApprovalMode: () => userSettings.approvalMode ?? 'manual',
  },
}));

beforeEach(() => {
  platformMeta.current = undefined;
  userSettings.approvalMode = 'manual';
});

describe('getEffectiveApprovalMode', () => {
  it('prefers the topic snapshot over the user preference', () => {
    userSettings.approvalMode = 'manual';

    expect(getEffectiveApprovalMode('auto-run')).toBe('auto-run');
  });

  it('falls back to the user preference without a topic snapshot', () => {
    userSettings.approvalMode = 'allow-list';

    expect(getEffectiveApprovalMode(undefined)).toBe('allow-list');
    expect(getEffectiveApprovalMode(null)).toBe('allow-list');
  });

  it('ignores a topic value that is not a selectable mode', () => {
    userSettings.approvalMode = 'manual';

    expect(getEffectiveApprovalMode('headless' as never)).toBe('manual');
  });

  it('lets a locked platform policy override the topic snapshot', () => {
    userSettings.approvalMode = 'manual';
    platformMeta.current = { locked: true };

    expect(getEffectiveApprovalMode('auto-run')).toBe('manual');
  });

  it('keeps the topic snapshot when the platform policy is managed but unlocked', () => {
    userSettings.approvalMode = 'manual';
    platformMeta.current = { locked: false };

    expect(getEffectiveApprovalMode('auto-run')).toBe('auto-run');
  });

  it('defaults to manual when nothing is configured', () => {
    userSettings.approvalMode = undefined;

    expect(getEffectiveApprovalMode(undefined)).toBe('manual');
  });
});

describe('toSelectableApprovalMode', () => {
  it('maps the internal headless mode onto auto-run', () => {
    expect(toSelectableApprovalMode('headless')).toBe('auto-run');
  });

  it('passes the user-selectable modes through', () => {
    expect(toSelectableApprovalMode('manual')).toBe('manual');
    expect(toSelectableApprovalMode('allow-list')).toBe('allow-list');
    expect(toSelectableApprovalMode('auto-run')).toBe('auto-run');
  });
});
