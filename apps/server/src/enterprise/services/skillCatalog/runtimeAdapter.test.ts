// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { PlatformSkillOperationResolver } from './runtimeAdapter';

const checksum = 'a'.repeat(64);
const ref = { checksum, skillKey: 'managed.skill', version: '1.0.0' };
const snapshot = { refs: [ref], revision: 'catalog-r1' };

describe('PlatformSkillOperationResolver', () => {
  it('uses the frozen ref, caches by revision and never falls through by name', async () => {
    const resolvePinnedForExecution = vi.fn().mockResolvedValue({
      allowBuiltinOverride: false,
      checksum,
      content: '# pinned',
      contentRef: null,
      description: 'Pinned',
      displayName: 'Pinned',
      distribution: 'default',
      manifest: { description: 'Pinned' },
      resources: [],
      skillId: 'skill-1',
      skillKey: 'managed.skill',
      source: 'uploaded',
      version: '1.0.0',
      versionId: 'version-1',
    });
    const resolver = new PlatformSkillOperationResolver(snapshot, { resolvePinnedForExecution });

    await expect(resolver.findByName('managed.skill')).resolves.toMatchObject({
      content: '# pinned',
      identifier: 'managed.skill',
    });
    await resolver.findByName('managed.skill');
    await expect(resolver.findByName('newly.published')).resolves.toBeUndefined();
    expect(resolvePinnedForExecution).toHaveBeenCalledTimes(1);
    expect(resolvePinnedForExecution).toHaveBeenCalledWith(ref);
  });

  it('caches a checksum/version mismatch as a fail-closed miss', async () => {
    const resolvePinnedForExecution = vi.fn().mockResolvedValue(undefined);
    const resolver = new PlatformSkillOperationResolver(snapshot, { resolvePinnedForExecution });

    await expect(resolver.findByName('managed.skill')).resolves.toBeUndefined();
    await expect(resolver.findByName('managed.skill')).resolves.toBeUndefined();
    expect(resolvePinnedForExecution).toHaveBeenCalledTimes(1);
  });
});
