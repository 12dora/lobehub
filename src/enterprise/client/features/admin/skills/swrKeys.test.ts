import { describe, expect, it } from 'vitest';

import {
  buildAdminSkillDependentsKey,
  buildAdminSkillGetKey,
  buildAdminSkillListKey,
  buildAdminSkillVersionKey,
  buildAdminSkillVersionsKey,
} from './swrKeys';

describe('M08 admin Skill SWR keys', () => {
  it('includes every server-side list filter and cursor dimension', () => {
    expect(
      buildAdminSkillListKey({
        cursor: 'cursor-1',
        distribution: 'mandatory',
        enabled: false,
        limit: 100,
        query: 'search all rows',
        source: 'uploaded',
        status: 'published',
      }),
    ).toEqual([
      'admin.skills.list',
      'cursor-1',
      'mandatory',
      false,
      100,
      'search all rows',
      'uploaded',
      'published',
    ]);
  });

  it('isolates detail, immutable version, history and dependent pages', () => {
    expect(buildAdminSkillGetKey('skill-1')).toEqual(['admin.skills.get', 'skill-1']);
    expect(buildAdminSkillVersionKey('skill-1', 'version-1')).toEqual([
      'admin.skills.getVersion',
      'skill-1',
      'version-1',
    ]);
    expect(
      buildAdminSkillVersionsKey({ cursor: 'v-cursor', limit: 20, skillId: 'skill-1' }),
    ).toEqual(['admin.skills.listVersions', 'skill-1', 'v-cursor', 20]);
    expect(
      buildAdminSkillDependentsKey({
        cursor: 'd-cursor',
        limit: 50,
        skillId: 'skill-1',
        versionId: 'version-1',
      }),
    ).toEqual(['admin.skills.getDependents', 'skill-1', 'version-1', 'd-cursor', 50]);
  });
});
