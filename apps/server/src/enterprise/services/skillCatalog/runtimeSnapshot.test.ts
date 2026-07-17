// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_ENTERPRISE_FEATURE_FLAGS } from '@/const/platform/featureFlags';

import { resolvePlatformSkillRuntimeSnapshot } from './runtimeSnapshot';

const flags = (enabled: boolean) => ({
  ...DEFAULT_ENTERPRISE_FEATURE_FLAGS,
  ENABLE_PLATFORM_MANAGED_SKILLS: enabled,
});
const identity = { agentId: 'agent-1', operationId: 'operation-1', userId: 'user-1' };
const signProof = vi.fn().mockResolvedValue('signed-proof');

describe('resolvePlatformSkillRuntimeSnapshot', () => {
  it('performs zero policy and catalog I/O when the feature is disabled', async () => {
    const getPublishedCatalog = vi.fn();
    const resolvePinnedForExecution = vi.fn();

    await expect(
      resolvePlatformSkillRuntimeSnapshot({
        db: {} as never,
        effectiveMode: 'enforced',
        flags: flags(false),
        identity,
        options: {
          catalogService: { getPublishedCatalog, resolvePinnedForExecution },
          signProof,
        },
      }),
    ).resolves.toBeUndefined();
    expect(getPublishedCatalog).not.toHaveBeenCalled();
  });

  it.each(['observe', 'ui-only', 'unmanaged'] as const)(
    'retains the legacy pool in %s mode without policy or catalog I/O',
    async (effectiveMode) => {
      const getPublishedCatalog = vi.fn();
      const resolvePinnedForExecution = vi.fn();

      await expect(
        resolvePlatformSkillRuntimeSnapshot({
          db: {} as never,
          effectiveMode,
          flags: flags(true),
          identity,
          options: {
            catalogService: { getPublishedCatalog, resolvePinnedForExecution },
            signProof,
          },
        }),
      ).resolves.toBeUndefined();
      expect(getPublishedCatalog).not.toHaveBeenCalled();
      expect(signProof).not.toHaveBeenCalled();
    },
  );

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
    await expect(
      resolvePlatformSkillRuntimeSnapshot({
        db: {} as never,
        effectiveMode: 'enforced',
        flags: flags(true),
        identity,
        options: {
          catalogService: { getPublishedCatalog, resolvePinnedForExecution },
          signProof,
        },
      }),
    ).resolves.toEqual({
      catalog: {
        agentId: 'agent-1',
        mandatorySkillIds: ['managed.skill'],
        operationId: 'operation-1',
        proof: 'signed-proof',
        refs: [{ checksum, skillKey: 'managed.skill', version: '1.2.3' }],
        revision: 'catalog-r1',
      },
      skills: [
        {
          activated: true,
          content: '# Managed',
          description: 'Managed instructions',
          identifier: 'managed.skill',
          name: 'managed.skill',
        },
      ],
    });
  });

  it('signs an empty enforced selection instead of dropping operation authority', async () => {
    const emptySigner = vi.fn().mockResolvedValue('empty-proof');
    const result = await resolvePlatformSkillRuntimeSnapshot({
      db: {} as never,
      effectiveMode: 'enforced',
      flags: flags(true),
      identity,
      options: {
        catalogService: {
          getPublishedCatalog: vi.fn().mockResolvedValue({ revision: 'empty-r1', skills: [] }),
          isPublishedCatalogExecutionReady: vi.fn(() => true),
          resolvePinnedForExecution: vi.fn(),
        },
        signProof: emptySigner,
      },
    });

    expect(result?.catalog).toMatchObject({ proof: 'empty-proof', refs: [] });
    expect(emptySigner).toHaveBeenCalledWith(expect.objectContaining({ refs: [] }));
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
      effectiveMode: 'enforced',
      flags: flags(true),
      identity,
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
        signProof,
      },
    });

    expect(result?.catalog.refs.map((item) => item.skillKey)).toEqual([
      'mandatory.disabled',
      'default.auto',
      'optional.pinned',
    ]);
    expect(result?.catalog.mandatorySkillIds).toEqual(['mandatory.disabled']);
    expect(result?.skills.find((item) => item.identifier === 'mandatory.disabled')).toMatchObject({
      activated: true,
      content: '# inline',
    });
  });
});
