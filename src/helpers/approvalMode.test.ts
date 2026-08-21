import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getEffectiveApprovalMode,
  toSelectableApprovalMode,
  toTopicApprovalSnapshot,
} from './approvalMode';

const lockMirror = vi.hoisted(() => ({
  locked: new Set<string>(),
  status: 'ready' as 'disabled' | 'unknown' | 'ready',
}));
const userSettings = vi.hoisted(() => ({ approvalMode: 'manual' as string | undefined }));

vi.mock('@/helpers/platformSettingLocks', () => ({
  isPlatformSettingLocked: (path: string) => lockMirror.locked.has(path),
  isPlatformSettingLockUnknown: () => lockMirror.status === 'unknown',
}));

vi.mock('@/store/user/store', () => ({
  getUserStoreState: () => ({}),
}));

vi.mock('@/store/user/selectors', () => ({
  toolInterventionSelectors: {
    rawApprovalMode: () => userSettings.approvalMode ?? 'manual',
  },
}));

const APPROVAL_PATH = 'tool.humanIntervention.approvalMode';

beforeEach(() => {
  lockMirror.locked = new Set();
  lockMirror.status = 'ready';
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

  it('returns the exact headless preference — never downgraded to auto-run', () => {
    userSettings.approvalMode = 'headless';

    expect(getEffectiveApprovalMode(undefined)).toBe('headless');
  });

  it('lets a locked platform policy override the topic snapshot', () => {
    userSettings.approvalMode = 'manual';
    lockMirror.locked = new Set([APPROVAL_PATH]);

    expect(getEffectiveApprovalMode('auto-run')).toBe('manual');
  });

  it('keeps the topic snapshot when the platform policy is managed but unlocked', () => {
    userSettings.approvalMode = 'manual';

    expect(getEffectiveApprovalMode('auto-run')).toBe('auto-run');
  });

  it('ignores a lock on an unrelated settings path', () => {
    userSettings.approvalMode = 'manual';
    lockMirror.locked = new Set(['defaultAgent.config.model']);

    expect(getEffectiveApprovalMode('auto-run')).toBe('auto-run');
  });

  it('defaults to manual when nothing is configured', () => {
    userSettings.approvalMode = undefined;

    expect(getEffectiveApprovalMode(undefined)).toBe('manual');
  });

  describe('fail-closed while the platform lock state is unknown', () => {
    it('ignores the topic snapshot and resolves to manual', () => {
      lockMirror.status = 'unknown';
      userSettings.approvalMode = 'auto-run';

      expect(getEffectiveApprovalMode('auto-run')).toBe('manual');
    });

    it('ignores an auto-run user preference too', () => {
      lockMirror.status = 'unknown';
      userSettings.approvalMode = 'auto-run';

      expect(getEffectiveApprovalMode(undefined)).toBe('manual');
    });

    it('resolves normally again once the mirror reports the deployment unmanaged', () => {
      lockMirror.status = 'disabled';
      userSettings.approvalMode = 'manual';

      expect(getEffectiveApprovalMode('auto-run')).toBe('auto-run');
    });
  });
});

describe('toSelectableApprovalMode', () => {
  it('maps the internal headless mode onto auto-run for the picker', () => {
    expect(toSelectableApprovalMode('headless')).toBe('auto-run');
  });

  it('passes the user-selectable modes through', () => {
    expect(toSelectableApprovalMode('manual')).toBe('manual');
    expect(toSelectableApprovalMode('allow-list')).toBe('allow-list');
    expect(toSelectableApprovalMode('auto-run')).toBe('auto-run');
  });
});

describe('toTopicApprovalSnapshot', () => {
  it('never snapshots headless', () => {
    expect(toTopicApprovalSnapshot('headless')).toBeUndefined();
  });

  it('passes the storable modes through', () => {
    expect(toTopicApprovalSnapshot('manual')).toBe('manual');
    expect(toTopicApprovalSnapshot('allow-list')).toBe('allow-list');
    expect(toTopicApprovalSnapshot('auto-run')).toBe('auto-run');
  });
});
