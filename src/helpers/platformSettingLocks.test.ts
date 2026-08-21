import { beforeEach, describe, expect, it } from 'vitest';

import {
  isPlatformSettingLocked,
  publishPlatformSettingLocks,
  resetPlatformSettingLocks,
} from './platformSettingLocks';

beforeEach(() => {
  resetPlatformSettingLocks();
});

describe('platformSettingLocks', () => {
  it('reports nothing locked before anything is published', () => {
    expect(isPlatformSettingLocked('tool.humanIntervention.approvalMode')).toBe(false);
  });

  it('publishes only the locked paths', () => {
    publishPlatformSettingLocks({
      'tool.humanIntervention.approvalMode': { locked: true },
      'defaultAgent.config.model': { locked: false },
      'systemAgent.agentMeta.model': {},
    });

    expect(isPlatformSettingLocked('tool.humanIntervention.approvalMode')).toBe(true);
    expect(isPlatformSettingLocked('defaultAgent.config.model')).toBe(false);
    expect(isPlatformSettingLocked('systemAgent.agentMeta.model')).toBe(false);
  });

  it('replaces the previous snapshot instead of merging', () => {
    publishPlatformSettingLocks({ 'tool.humanIntervention.approvalMode': { locked: true } });
    publishPlatformSettingLocks({ 'defaultAgent.config.model': { locked: true } });

    expect(isPlatformSettingLocked('tool.humanIntervention.approvalMode')).toBe(false);
    expect(isPlatformSettingLocked('defaultAgent.config.model')).toBe(true);
  });

  it('tolerates an undefined payload', () => {
    publishPlatformSettingLocks({ 'tool.humanIntervention.approvalMode': { locked: true } });
    publishPlatformSettingLocks(undefined);

    expect(isPlatformSettingLocked('tool.humanIntervention.approvalMode')).toBe(false);
  });
});
