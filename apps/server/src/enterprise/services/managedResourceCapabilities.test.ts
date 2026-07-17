// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_ENTERPRISE_FEATURE_FLAGS } from '@/const/platform/featureFlags';
import { getTestDB } from '@/database/core/getTestDB';
import {
  createUnmanagedResourcePolicyMap,
  PlatformManagedResourcePolicyModel,
} from '@/database/models/platform';
import { platformManagedResourcePolicies } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import {
  getManagedSkillRuntimeModeSnapshot,
  resetManagedSkillRuntimeModeCacheForTest,
  resolveManagedSkillRuntimeMode,
  resolvePublishedManagedResourcePolicies,
} from './managedResourceCapabilities';

const serverDB: LobeChatDatabase = await getTestDB();
const readiness = async () => ({
  agents: false,
  aiModels: true,
  aiProviders: true,
  connectors: true,
  skills: true,
});

beforeEach(async () => {
  resetManagedSkillRuntimeModeCacheForTest();
  await serverDB.delete(platformManagedResourcePolicies);
});

afterEach(async () => {
  resetManagedSkillRuntimeModeCacheForTest();
  await serverDB.delete(platformManagedResourcePolicies);
});

describe('resolveManagedSkillRuntimeMode', () => {
  const flags = {
    ...DEFAULT_ENTERPRISE_FEATURE_FLAGS,
    ENABLE_PLATFORM_MANAGED_SKILLS: true,
  };

  it('performs zero epoch and policy I/O when the feature is off', async () => {
    const getCacheEpoch = vi.fn();
    const getSnapshot = vi.fn();
    await expect(
      resolveManagedSkillRuntimeMode({
        db: serverDB,
        flags: DEFAULT_ENTERPRISE_FEATURE_FLAGS,
        options: { getCacheEpoch, model: { getSnapshot } },
      }),
    ).resolves.toBe('unmanaged');
    expect(getCacheEpoch).not.toHaveBeenCalled();
    expect(getSnapshot).not.toHaveBeenCalled();
  });

  it.each(['observe', 'ui-only'] as const)(
    'injects trusted %s mode into the synchronous hot-path snapshot',
    async (enforcementMode) => {
      const getSnapshot = vi.fn().mockResolvedValue({
        published: { skills: { enforcementMode, managed: true } },
        status: 'published',
      });
      const model = { getSnapshot };
      const getCacheEpoch = vi.fn(async () => 'epoch-1');
      const options = { getCacheEpoch, model };

      await expect(resolveManagedSkillRuntimeMode({ db: serverDB, flags, options })).resolves.toBe(
        enforcementMode,
      );
      expect(getManagedSkillRuntimeModeSnapshot({ db: serverDB, flags })).toBe(enforcementMode);
      expect(getSnapshot).toHaveBeenCalledTimes(1);
      expect(getCacheEpoch).toHaveBeenCalledTimes(1);
    },
  );

  it('performs zero managed policy I/O on feature-off hot paths', () => {
    expect(
      getManagedSkillRuntimeModeSnapshot({ db: serverDB, flags: DEFAULT_ENTERPRISE_FEATURE_FLAGS }),
    ).toBe('unmanaged');
  });

  it('fails closed on missing or expired trusted hot-path snapshots', async () => {
    let now = 1_000;
    expect(getManagedSkillRuntimeModeSnapshot({ db: serverDB, flags, now: () => now })).toBe(
      'enforced',
    );
    await resolveManagedSkillRuntimeMode({
      db: serverDB,
      flags,
      options: {
        cacheTtlMs: 100,
        getCacheEpoch: async () => 'epoch-1',
        model: {
          getSnapshot: async () => {
            const published = createUnmanagedResourcePolicyMap();
            published.skills = { enforcementMode: 'observe', managed: true };
            return {
              draft: published,
              published,
              revision: 1,
              status: 'published' as const,
            };
          },
        },
        now: () => now,
      },
    });
    expect(getManagedSkillRuntimeModeSnapshot({ db: serverDB, flags, now: () => now })).toBe(
      'observe',
    );
    now += 101;
    expect(getManagedSkillRuntimeModeSnapshot({ db: serverDB, flags, now: () => now })).toBe(
      'enforced',
    );
  });

  it('refreshes the trusted mode when another instance bumps the epoch', async () => {
    let epoch = 'epoch-1';
    const getSnapshot = vi
      .fn()
      .mockResolvedValueOnce({
        published: { skills: { enforcementMode: 'ui-only', managed: true } },
        status: 'published',
      })
      .mockResolvedValueOnce({
        published: { skills: { enforcementMode: 'enforced', managed: true } },
        status: 'published',
      });
    const options = { getCacheEpoch: async () => epoch, model: { getSnapshot } };
    await expect(resolveManagedSkillRuntimeMode({ db: serverDB, flags, options })).resolves.toBe(
      'ui-only',
    );
    epoch = 'epoch-2';
    await expect(resolveManagedSkillRuntimeMode({ db: serverDB, flags, options })).resolves.toBe(
      'enforced',
    );
    expect(getSnapshot).toHaveBeenCalledTimes(2);
  });
});

describe('resolvePublishedManagedResourcePolicies', () => {
  it('injects the trusted published Skill mode for synchronous operation reads', async () => {
    const model = new PlatformManagedResourcePolicyModel(serverDB);
    await model.ensureRows();
    const policies = createUnmanagedResourcePolicyMap();
    policies.skills = { enforcementMode: 'observe', managed: true };
    await model.materializePublished({ policies, revision: 1 });
    const flags = {
      ...DEFAULT_ENTERPRISE_FEATURE_FLAGS,
      ENABLE_PLATFORM_MANAGED_SKILLS: true,
    };

    await resolvePublishedManagedResourcePolicies({ db: serverDB, flags, readiness });

    expect(getManagedSkillRuntimeModeSnapshot({ db: serverDB, flags })).toBe('observe');
  });

  it('reads published only: an unpublished draft never changes public capabilities', async () => {
    const model = new PlatformManagedResourcePolicyModel(serverDB);
    await model.ensureRows();
    const draft = createUnmanagedResourcePolicyMap();
    draft.aiProviders = { enforcementMode: 'ui-only', managed: true };
    await model.replaceDraft({ draft });

    const result = await resolvePublishedManagedResourcePolicies({
      db: serverDB,
      flags: { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_PLATFORM_MANAGED_AI: true },
      readiness,
    });
    expect(result.publicCapabilities.aiProviders).toBe(false);
  });

  it('requires flag + managed + non-observe published policy', async () => {
    const model = new PlatformManagedResourcePolicyModel(serverDB);
    await model.ensureRows();
    const policies = createUnmanagedResourcePolicyMap();
    policies.aiProviders = { enforcementMode: 'ui-only', managed: true };
    policies.aiModels = { enforcementMode: 'observe', managed: true };
    policies.agents = { enforcementMode: 'enforced', managed: true };
    await model.materializePublished({ policies, revision: 1 });

    const flagsOn = await resolvePublishedManagedResourcePolicies({
      db: serverDB,
      flags: {
        ...DEFAULT_ENTERPRISE_FEATURE_FLAGS,
        ENABLE_PLATFORM_MANAGED_AGENTS: true,
        ENABLE_PLATFORM_MANAGED_AI: true,
      },
      readiness,
    });
    expect(flagsOn.publicCapabilities).toMatchObject({
      agents: false,
      aiModels: false,
      aiProviders: true,
    });
    expect(flagsOn.effectiveModes).toMatchObject({
      agents: 'unmanaged',
      aiModels: 'observe',
      aiProviders: 'ui-only',
    });

    const flagsOff = await resolvePublishedManagedResourcePolicies({
      db: serverDB,
      flags: { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS },
      readiness,
    });
    expect(Object.values(flagsOff.publicCapabilities).every((managed) => !managed)).toBe(true);
    expect(Object.values(flagsOff.effectiveModes).every((mode) => mode === 'unmanaged')).toBe(true);
  });
});
