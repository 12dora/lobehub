// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_ENTERPRISE_FEATURE_FLAGS } from '@/const/platform/featureFlags';

import { resolvePlatformSkillRuntimeSnapshot } from './runtimeSnapshot';

const flags = (enabled: boolean) => ({
  ...DEFAULT_ENTERPRISE_FEATURE_FLAGS,
  ENABLE_PLATFORM_MANAGED_SKILLS: enabled,
});

describe('resolvePlatformSkillRuntimeSnapshot', () => {
  it('performs zero policy and catalog I/O when the feature is disabled', async () => {
    const getSnapshot = vi.fn();
    const getPublishedCatalog = vi.fn();
    const resolvePinnedForExecution = vi.fn();

    await expect(
      resolvePlatformSkillRuntimeSnapshot({
        db: {} as never,
        flags: flags(false),
        options: {
          catalogService: { getPublishedCatalog, resolvePinnedForExecution },
          policyModel: { getSnapshot },
        },
      }),
    ).resolves.toBeUndefined();
    expect(getSnapshot).not.toHaveBeenCalled();
    expect(getPublishedCatalog).not.toHaveBeenCalled();
  });

  it('retains the legacy pool outside final enforced mode without reading the catalog', async () => {
    const getPublishedCatalog = vi.fn();
    const resolvePinnedForExecution = vi.fn();
    const getSnapshot = vi.fn().mockResolvedValue({
      published: { skills: { enforcementMode: 'ui-only', managed: true } },
      status: 'published',
    });

    await expect(
      resolvePlatformSkillRuntimeSnapshot({
        db: {} as never,
        flags: flags(true),
        options: {
          catalogService: { getPublishedCatalog, resolvePinnedForExecution },
          policyModel: { getSnapshot },
        },
      }),
    ).resolves.toBeUndefined();
    expect(getPublishedCatalog).not.toHaveBeenCalled();
  });

  it('freezes the same published metadata into refs and operation Skill metas', async () => {
    const checksum = 'a'.repeat(64);
    const getPublishedCatalog = vi.fn().mockResolvedValue({
      revision: 'catalog-r1',
      skills: [
        {
          checksum,
          description: 'Managed instructions',
          displayName: 'Managed',
          distribution: 'mandatory',
          skillKey: 'managed.skill',
          source: 'uploaded',
          version: '1.2.3',
        },
      ],
    });
    const resolvePinnedForExecution = vi.fn().mockResolvedValue({
      checksum,
      content: '# Managed',
      contentRef: null,
      resources: [],
      skillKey: 'managed.skill',
      version: '1.2.3',
    });
    const getSnapshot = vi.fn().mockResolvedValue({
      published: { skills: { enforcementMode: 'enforced', managed: true } },
      status: 'published',
    });

    await expect(
      resolvePlatformSkillRuntimeSnapshot({
        db: {} as never,
        flags: flags(true),
        options: {
          catalogService: { getPublishedCatalog, resolvePinnedForExecution },
          policyModel: { getSnapshot },
        },
      }),
    ).resolves.toEqual({
      catalog: {
        refs: [{ checksum, skillKey: 'managed.skill', version: '1.2.3' }],
        revision: 'catalog-r1',
      },
      skills: [
        {
          description: 'Managed instructions',
          identifier: 'managed.skill',
          name: 'managed.skill',
        },
      ],
    });
  });

  it('applies mandatory/default/optional tri-state selection before freezing refs', async () => {
    const makeSkill = (skillKey: string, distribution: 'mandatory' | 'default' | 'optional') => ({
      checksum: 'a'.repeat(64),
      description: skillKey,
      displayName: skillKey,
      distribution,
      skillKey,
      source: 'uploaded' as const,
      version: '1.0.0',
    });
    const skills = [
      makeSkill('mandatory.disabled', 'mandatory'),
      makeSkill('default.disabled', 'default'),
      makeSkill('default.auto', 'default'),
      makeSkill('optional.auto', 'optional'),
      makeSkill('optional.pinned', 'optional'),
    ];
    const result = await resolvePlatformSkillRuntimeSnapshot({
      agentPlugins: [
        { identifier: 'mandatory.disabled', mode: 'disabled' },
        { identifier: 'default.disabled', mode: 'disabled' },
        { identifier: 'optional.pinned', mode: 'pinned' },
      ],
      db: {} as never,
      flags: flags(true),
      options: {
        catalogService: {
          getPublishedCatalog: vi.fn().mockResolvedValue({ revision: 'r1', skills }),
          resolvePinnedForExecution: vi.fn(async (ref) => ({
            ...ref,
            content: '# inline',
            contentRef: null,
            resources: [],
          })),
        },
        policyModel: {
          getSnapshot: vi.fn().mockResolvedValue({
            published: { skills: { enforcementMode: 'enforced', managed: true } },
            status: 'published',
          }),
        },
      },
    });

    expect(result?.catalog.refs.map((item) => item.skillKey)).toEqual([
      'mandatory.disabled',
      'default.auto',
      'optional.pinned',
    ]);
  });
});
