import { describe, expect, it, vi } from 'vitest';

import {
  getPlatformSkillToggleMode,
  indexPlatformSkillRefs,
  PLATFORM_SKILL_ID_PREFIX,
  PlatformSkillInFlightCache,
  platformSkillRuntimeId,
  resolvePlatformSkillSelection,
  toPlatformSkillListItem,
  toPlatformSkillResourceContent,
} from './skills';

describe('platform skill runtime protocol', () => {
  const ref = { checksum: 'a'.repeat(64), skillKey: 'approved.skill', version: '1.0.0' };

  it('builds a stable runtime id and indexes refs by key and id', () => {
    const id = platformSkillRuntimeId(ref);
    expect(id).toBe(`${PLATFORM_SKILL_ID_PREFIX}${ref.skillKey}@${ref.version}#${ref.checksum}`);
    const { byId, byKey } = indexPlatformSkillRefs([ref]);
    expect(byKey.get(ref.skillKey)).toEqual(ref);
    expect(byId.get(id)).toEqual(ref);
  });

  it('projects list items with optional display metadata', () => {
    expect(
      toPlatformSkillListItem(ref, { description: 'desc', displayName: 'Name' }),
    ).toMatchObject({
      description: 'desc',
      id: platformSkillRuntimeId(ref),
      identifier: ref.skillKey,
      name: 'Name',
    });
  });

  it('projects resource content into the shared SkillResourceContent envelope', () => {
    expect(
      toPlatformSkillResourceContent('refs/a.txt', {
        content: 'body',
        fileHash: 'hash',
        size: 4,
      }),
    ).toEqual({
      content: 'body',
      encoding: 'utf8',
      fileHash: 'hash',
      fileType: 'text/plain',
      path: 'refs/a.txt',
      size: 4,
    });
  });

  it('evicts rejected in-flight cache entries so later lookups can succeed', async () => {
    const cache = new PlatformSkillInFlightCache<string>();
    const first = cache.set('k', Promise.reject(new Error('transient')));
    await expect(first).rejects.toThrow('transient');
    expect(cache.size).toBe(0);

    const resolve = vi.fn(async () => 'ok');
    const second = cache.set('k', resolve());
    await expect(second).resolves.toBe('ok');
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(1);
  });
});

describe('platform Skill distribution selection', () => {
  it.each([
    ['mandatory', 'auto', true, true, false],
    ['mandatory', 'disabled', true, true, false],
    ['default', 'auto', true, false, true],
    ['default', 'pinned', true, true, true],
    ['default', 'disabled', false, false, true],
    ['optional', 'auto', false, false, true],
    ['optional', 'pinned', true, true, true],
    ['optional', 'disabled', false, false, true],
  ] as const)(
    '%s + %s -> available=%s activated=%s mutable=%s',
    (distribution, mode, available, activated, mutable) => {
      expect(resolvePlatformSkillSelection(distribution, mode)).toEqual({
        activated,
        available,
        mutable,
      });
    },
  );

  it('maps only mutable controls to persisted tri-state modes', () => {
    expect(getPlatformSkillToggleMode('mandatory', false)).toBeNull();
    expect(getPlatformSkillToggleMode('default', true)).toBe('auto');
    expect(getPlatformSkillToggleMode('default', false)).toBe('disabled');
    expect(getPlatformSkillToggleMode('optional', true)).toBe('pinned');
    expect(getPlatformSkillToggleMode('optional', false)).toBe('disabled');
  });
});
