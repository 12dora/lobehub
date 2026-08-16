// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DISABLED_ENTERPRISE_FEATURE_FLAGS } from '@/const/platform/featureFlags';
import { getTestDB } from '@/database/core/getTestDB';
import {
  createUnmanagedResourcePolicyMap,
  PlatformManagedResourcePolicyModel,
} from '@/database/models/platform';
import { platformManagedResourcePolicies } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import {
  getManagedSkillRuntimeModeSnapshot,
  MANAGED_RESOURCE_READINESS_CACHE_TTL_MS,
  resetManagedResourceReadinessCacheForTest,
  resetManagedSkillRuntimeModeCacheForTest,
  resolveManagedResourceReadinessCached,
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
  resetManagedResourceReadinessCacheForTest();
  resetManagedSkillRuntimeModeCacheForTest();
  await serverDB.delete(platformManagedResourcePolicies);
});

afterEach(async () => {
  resetManagedResourceReadinessCacheForTest();
  resetManagedSkillRuntimeModeCacheForTest();
  await serverDB.delete(platformManagedResourcePolicies);
});

describe('resolvePublishedManagedResourcePolicies', () => {
  it('injects the trusted published Skill mode for synchronous operation reads', async () => {
    const model = new PlatformManagedResourcePolicyModel(serverDB);
    await model.ensureRows();
    const policies = createUnmanagedResourcePolicyMap();
    policies.skills = { enforcementMode: 'observe', managed: true };
    await model.materializePublished({ policies, revision: 1 });
    const flags = {
      ...DISABLED_ENTERPRISE_FEATURE_FLAGS,
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
      flags: { ...DISABLED_ENTERPRISE_FEATURE_FLAGS, ENABLE_PLATFORM_MANAGED_AI: true },
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
        ...DISABLED_ENTERPRISE_FEATURE_FLAGS,
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
      flags: { ...DISABLED_ENTERPRISE_FEATURE_FLAGS },
      readiness,
    });
    expect(Object.values(flagsOff.publicCapabilities).every((managed) => !managed)).toBe(true);
    expect(Object.values(flagsOff.effectiveModes).every((mode) => mode === 'unmanaged')).toBe(true);
  });

  it('never downgrades enforced aiProviders/aiModels on readiness=false', async () => {
    const model = new PlatformManagedResourcePolicyModel(serverDB);
    await model.ensureRows();
    const policies = createUnmanagedResourcePolicyMap();
    policies.aiProviders = { enforcementMode: 'enforced', managed: true };
    policies.aiModels = { enforcementMode: 'enforced', managed: true };
    policies.connectors = { enforcementMode: 'enforced', managed: true };
    await model.materializePublished({ policies, revision: 1 });

    const result = await resolvePublishedManagedResourcePolicies({
      db: serverDB,
      flags: {
        ...DISABLED_ENTERPRISE_FEATURE_FLAGS,
        ENABLE_PLATFORM_MANAGED_AI: true,
        ENABLE_PLATFORM_MANAGED_CONNECTORS: true,
      },
      readiness: async () => ({
        agents: false,
        aiModels: false,
        aiProviders: false,
        connectors: false,
        skills: false,
      }),
    });

    // The server takeover predicate reads the published policy, so the client must keep
    // blocking the UI even while the catalog probe is unhappy — otherwise the settings page
    // un-hides while the runtime is still platform-governed.
    expect(result.effectiveModes).toMatchObject({
      aiModels: 'enforced',
      aiProviders: 'enforced',
    });
    expect(result.publicCapabilities).toMatchObject({ aiModels: true, aiProviders: true });
    // Readiness is still reported separately for the admin page …
    expect(result.readiness).toMatchObject({ aiModels: false, aiProviders: false });
    // … and resources without their own fail-closed runtime keep the readiness downgrade.
    expect(result.effectiveModes.connectors).toBe('unmanaged');
  });
});

describe('resolveManagedResourceReadinessCached', () => {
  const readinessMap = {
    agents: true,
    aiModels: true,
    aiProviders: true,
    connectors: true,
    skills: true,
  };

  it('runs the secret-decrypting probe at most once per window, however many clients poll', async () => {
    // `platform.getCapabilities` is polled by every mounted client; the AI readiness probe
    // loads the whole catalog and decrypts every published provider secret (and is registered
    // for BOTH aiProviders and aiModels), so it must not run per request.
    const probe = vi.fn().mockResolvedValue(readinessMap);
    const now = vi.fn<() => number>().mockReturnValue(1000);

    expect(await resolveManagedResourceReadinessCached({ now, probe })).toEqual(readinessMap);
    for (let i = 0; i < 25; i += 1) {
      expect(await resolveManagedResourceReadinessCached({ now, probe })).toEqual(readinessMap);
    }
    expect(probe).toHaveBeenCalledOnce();

    now.mockReturnValue(1000 + MANAGED_RESOURCE_READINESS_CACHE_TTL_MS + 1);
    await resolveManagedResourceReadinessCached({ now, probe });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('collapses concurrent polls into a single probe', async () => {
    let release: (value: typeof readinessMap) => void = () => {};
    const probe = vi.fn(
      () =>
        new Promise<typeof readinessMap>((resolve) => {
          release = resolve;
        }),
    );
    const inFlight = [
      resolveManagedResourceReadinessCached({ probe }),
      resolveManagedResourceReadinessCached({ probe }),
      resolveManagedResourceReadinessCached({ probe }),
    ];
    release(readinessMap);

    expect(await Promise.all(inFlight)).toEqual([readinessMap, readinessMap, readinessMap]);
    expect(probe).toHaveBeenCalledOnce();
  });

  it('does not cache a failed probe', async () => {
    const probe = vi
      .fn()
      .mockRejectedValueOnce(new Error('catalog unavailable'))
      .mockResolvedValue(readinessMap);

    await expect(resolveManagedResourceReadinessCached({ probe })).rejects.toThrow(
      'catalog unavailable',
    );
    expect(await resolveManagedResourceReadinessCached({ probe })).toEqual(readinessMap);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('is not used by the default resolver, so admin/publish reads stay fresh', async () => {
    const probe = vi.fn().mockResolvedValue(readinessMap);
    const model = new PlatformManagedResourcePolicyModel(serverDB);
    await model.ensureRows();

    await resolvePublishedManagedResourcePolicies({
      db: serverDB,
      flags: { ...DISABLED_ENTERPRISE_FEATURE_FLAGS },
      readiness: probe,
    });
    await resolvePublishedManagedResourcePolicies({
      db: serverDB,
      flags: { ...DISABLED_ENTERPRISE_FEATURE_FLAGS },
      readiness: probe,
    });

    expect(probe).toHaveBeenCalledTimes(2);
  });
});
