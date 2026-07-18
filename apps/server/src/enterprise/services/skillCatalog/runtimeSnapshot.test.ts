// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_ENTERPRISE_FEATURE_FLAGS } from '@/const/platform/featureFlags';

import type { SkillCatalogReadService } from './readService';
import {
  resolvePinnedPlatformSkillRuntimeSnapshot,
  resolvePlatformSkillRuntimeSnapshot,
} from './runtimeSnapshot';

type FakeCatalogService = Pick<
  SkillCatalogReadService,
  'getPublishedCatalog' | 'resolvePinnedForExecution'
>;

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

describe('resolvePinnedPlatformSkillRuntimeSnapshot (SKILL-EXACT)', () => {
  const checksum = 'a'.repeat(64);
  // A catalog that resolves EXACTLY the requested {skillKey, version, checksum} to its historical
  // content — the pinned ref, not the catalog head, is the authority.
  const historicalCatalog = () => {
    // Must NOT be read — pinned refs drive resolution.
    const getPublishedCatalog = vi.fn(() => {
      throw new Error('pinned resolution must not read the catalog head');
    });
    const resolvePinnedForExecution = vi.fn(
      async (ref: { checksum: string; skillKey: string; version: string }) => ({
        ...ref,
        content: `# ${ref.skillKey} v${ref.version} content`,
        contentRef: null,
        description: `${ref.skillKey} desc`,
        resources: [],
      }),
    );
    const service = { getPublishedCatalog, resolvePinnedForExecution };
    return service as unknown as FakeCatalogService & typeof service;
  };
  // A catalog whose exact resolution fails (missing / checksum mismatch / tampered version).
  const unresolvableCatalog = () => {
    const getPublishedCatalog = vi.fn();
    const resolvePinnedForExecution = vi.fn(async () => undefined);
    const service = { getPublishedCatalog, resolvePinnedForExecution };
    return service as unknown as FakeCatalogService & typeof service;
  };

  it('resolves the exact pinned v1 Skill content — not the catalog head — and signs over the refs', async () => {
    const catalogService = historicalCatalog();
    const signer = vi.fn().mockResolvedValue('pinned-proof');
    const result = await resolvePinnedPlatformSkillRuntimeSnapshot({
      db: {} as never,
      flags: flags(true),
      identity,
      options: { catalogService, signProof: signer },
      pinnedSkills: [{ checksum, skillKey: 'research', version: '1.0.0' }],
    });

    // The model sees / activates the EXACT v1 historical content (resolved by the pinned ref).
    expect(result.skills).toEqual([
      {
        activated: true,
        content: '# research v1.0.0 content',
        description: 'research desc',
        identifier: 'research',
        name: 'research',
      },
    ]);
    expect(result.catalog).toMatchObject({
      mandatorySkillIds: ['research'],
      proof: 'pinned-proof',
      refs: [{ checksum, skillKey: 'research', version: '1.0.0' }],
    });
    // Resolved by the exact pinned ref; never read the moving catalog head.
    expect(catalogService.resolvePinnedForExecution).toHaveBeenCalledWith({
      checksum,
      skillKey: 'research',
      version: '1.0.0',
    });
    expect(catalogService.getPublishedCatalog).not.toHaveBeenCalled();
    expect(signer).toHaveBeenCalledWith(
      expect.objectContaining({ refs: [{ checksum, skillKey: 'research', version: '1.0.0' }] }),
    );
  });

  it('fails closed when a pinned Skill cannot be resolved (missing / checksum mismatch / tamper)', async () => {
    const catalogService = unresolvableCatalog();
    await expect(
      resolvePinnedPlatformSkillRuntimeSnapshot({
        db: {} as never,
        flags: flags(true),
        identity,
        options: { catalogService, signProof },
        // Tampered checksum → resolvePinnedForExecution returns undefined → throw.
        pinnedSkills: [{ checksum: 'f'.repeat(64), skillKey: 'research', version: '1.0.0' }],
      }),
    ).rejects.toThrow();
  });

  it('fails closed when the Agent pinned Skills but managed Skills are disabled', async () => {
    const catalogService = historicalCatalog();
    await expect(
      resolvePinnedPlatformSkillRuntimeSnapshot({
        db: {} as never,
        flags: flags(false),
        identity,
        options: { catalogService, signProof },
        pinnedSkills: [{ checksum, skillKey: 'research', version: '1.0.0' }],
      }),
    ).rejects.toThrow();
    // No catalog read when the feature is off.
    expect(catalogService.resolvePinnedForExecution).not.toHaveBeenCalled();
  });

  it('returns an empty pinned pool with zero catalog I/O when the Agent has no Skills', async () => {
    const catalogService = historicalCatalog();
    const signer = vi.fn().mockResolvedValue('empty-pinned-proof');
    const result = await resolvePinnedPlatformSkillRuntimeSnapshot({
      db: {} as never,
      flags: flags(true),
      identity,
      options: { catalogService, signProof: signer },
      pinnedSkills: [],
    });
    expect(result.skills).toEqual([]);
    expect(result.catalog).toMatchObject({ proof: 'empty-pinned-proof', refs: [] });
    expect(catalogService.resolvePinnedForExecution).not.toHaveBeenCalled();
    expect(catalogService.getPublishedCatalog).not.toHaveBeenCalled();
  });
});
