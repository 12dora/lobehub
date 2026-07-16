// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ENTERPRISE_FEATURE_FLAGS } from '@/const/platform/featureFlags';
import { getTestDB } from '@/database/core/getTestDB';
import {
  createUnmanagedResourcePolicyMap,
  PlatformManagedResourcePolicyModel,
} from '@/database/models/platform';
import { platformManagedResourcePolicies } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import { resolvePublishedManagedResourcePolicies } from './managedResourceCapabilities';

const serverDB: LobeChatDatabase = await getTestDB();
const readiness = async () => ({
  agents: false,
  aiModels: true,
  aiProviders: true,
  connectors: true,
  skills: true,
});

beforeEach(async () => {
  await serverDB.delete(platformManagedResourcePolicies);
});

afterEach(async () => {
  await serverDB.delete(platformManagedResourcePolicies);
});

describe('resolvePublishedManagedResourcePolicies', () => {
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
