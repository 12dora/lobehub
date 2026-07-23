import { describe, expect, it } from 'vitest';

import type { AdminSkillGetOutput, AdminSkillVersionSummary } from './types';
import {
  createSkillWriteEpochGuard,
  freezeSkillWriteSnapshot,
  isRollbackableSkillVersion,
} from './writeOperation';

const snapshot = (id = 'skill-1', revision = 3): AdminSkillGetOutput => ({
  baseRevision: revision,
  draft: {
    allowBuiltinOverride: false,
    currentVersionId: null,
    description: null,
    displayName: id,
    distribution: 'default',
    draftSequence: revision,
    enabled: true,
    id,
    revision,
    skillKey: id,
    source: 'uploaded',
    status: 'draft',
  },
  draftToken: String(revision).repeat(64),
  latestVersion: null,
  publishedVersion: null,
});

const version = (id: string, lastPublishedRevision: number | null): AdminSkillVersionSummary => ({
  checksum: 'a'.repeat(64),
  createdAt: new Date(0),
  createdBy: null,
  id,
  lastPublishedRevision,
  skillId: 'skill-1',
  validation: null,
  version: id === 'v1' ? '1.0.0' : '2.0.0',
});

describe('M08 frozen write operations', () => {
  it('freezes CAS, target, and fingerprint against later SWR drift', () => {
    const data = snapshot();
    const frozen = freezeSkillWriteSnapshot(data, { versionId: 'v1' });
    data.baseRevision = 9;
    data.draftToken = 'z'.repeat(64);
    expect(frozen).toMatchObject({
      baseRevision: 3,
      draftToken: '3'.repeat(64),
      id: 'skill-1',
      versionId: 'v1',
    });
    expect(frozen.fingerprint).toContain('skill-1');
    expect(Object.isFrozen(frozen)).toBe(true);
  });

  it('offers rollback only for versions with server publication provenance', () => {
    expect(isRollbackableSkillVersion(version('v1', 2))).toBe(true);
    expect(isRollbackableSkillVersion(version('v2', null))).toBe(false);
  });

  it('invalidates callbacks captured for another resource or prior epoch', () => {
    const guard = createSkillWriteEpochGuard();
    const first = guard.begin('skill-1')!;
    expect(() => guard.assertCurrent(first, 'skill-1')).not.toThrow();
    expect(() => guard.assertCurrent(first, 'skill-2')).toThrow('PLATFORM_REVISION_CONFLICT');
    const newer = guard.begin('skill-1')!;
    expect(() => guard.assertCurrent(first, 'skill-1')).toThrow('PLATFORM_REVISION_CONFLICT');
    expect(() => guard.assertCurrent(newer, 'skill-1')).not.toThrow();
    guard.invalidate();
    expect(() => guard.assertCurrent(first, 'skill-1')).toThrow('PLATFORM_REVISION_CONFLICT');
  });
});
