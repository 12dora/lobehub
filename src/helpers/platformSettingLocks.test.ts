import { beforeEach, describe, expect, it } from 'vitest';

import {
  getPlatformSettingLockStatus,
  isPlatformSettingLocked,
  isPlatformSettingLockUnknown,
  markPlatformSettingLocksUnknown,
  markPlatformSettingsUnmanaged,
  publishPlatformSettingLocks,
  resetPlatformSettingLocks,
} from './platformSettingLocks';

const APPROVAL_PATH = 'tool.humanIntervention.approvalMode';

beforeEach(() => {
  resetPlatformSettingLocks();
});

describe('platformSettingLocks', () => {
  it('starts unknown so callers fail closed before bootstrap classifies the deployment', () => {
    expect(getPlatformSettingLockStatus()).toBe('unknown');
    expect(isPlatformSettingLockUnknown()).toBe(true);
    expect(isPlatformSettingLocked(APPROVAL_PATH)).toBe(false);
  });

  it('marks an unmanaged deployment as known-not-locked', () => {
    markPlatformSettingsUnmanaged();

    expect(getPlatformSettingLockStatus()).toBe('disabled');
    expect(isPlatformSettingLockUnknown()).toBe(false);
    expect(isPlatformSettingLocked(APPROVAL_PATH)).toBe(false);
  });

  it('publishes only the locked paths and becomes ready', () => {
    publishPlatformSettingLocks({
      'defaultAgent.config.model': { locked: false },
      'systemAgent.agentMeta.model': {},
      [APPROVAL_PATH]: { locked: true },
    });

    expect(getPlatformSettingLockStatus()).toBe('ready');
    expect(isPlatformSettingLockUnknown()).toBe(false);
    expect(isPlatformSettingLocked(APPROVAL_PATH)).toBe(true);
    expect(isPlatformSettingLocked('defaultAgent.config.model')).toBe(false);
    expect(isPlatformSettingLocked('systemAgent.agentMeta.model')).toBe(false);
  });

  it('replaces the previous snapshot instead of merging', () => {
    publishPlatformSettingLocks({ [APPROVAL_PATH]: { locked: true } });
    publishPlatformSettingLocks({ 'defaultAgent.config.model': { locked: true } });

    expect(isPlatformSettingLocked(APPROVAL_PATH)).toBe(false);
    expect(isPlatformSettingLocked('defaultAgent.config.model')).toBe(true);
  });

  it('tolerates an undefined payload', () => {
    publishPlatformSettingLocks({ [APPROVAL_PATH]: { locked: true } });
    publishPlatformSettingLocks(undefined);

    expect(getPlatformSettingLockStatus()).toBe('ready');
    expect(isPlatformSettingLocked(APPROVAL_PATH)).toBe(false);
  });

  it('drops back to unknown on an account / policy change so stale locks are never read', () => {
    publishPlatformSettingLocks({ [APPROVAL_PATH]: { locked: true } });
    markPlatformSettingLocksUnknown();

    expect(getPlatformSettingLockStatus()).toBe('unknown');
    expect(isPlatformSettingLocked(APPROVAL_PATH)).toBe(false);
  });

  it('an unmanaged mark also clears previously published locks', () => {
    publishPlatformSettingLocks({ [APPROVAL_PATH]: { locked: true } });
    markPlatformSettingsUnmanaged();

    expect(isPlatformSettingLocked(APPROVAL_PATH)).toBe(false);
  });
});
