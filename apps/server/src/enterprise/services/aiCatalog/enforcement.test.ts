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
import type { ManagedResourcePolicyItem } from '@/types/platform/managedResources';

import type * as ManagedResourceReadinessModule from '../managedResourceReadiness';
import {
  isPlatformAiTakeoverActive,
  PLATFORM_AI_TAKEOVER_MEMO_TTL_MS,
  resetPlatformAiTakeoverCache,
  resetPlatformAiTakeoverCacheForTest,
} from './enforcement';

// The readiness probe for `aiProviders` loads the whole catalog and decrypts every provider
// secret; it must never sit on the takeover hot path.
const readinessMocks = vi.hoisted(() => ({ resolveManagedResourceReadiness: vi.fn() }));
vi.mock('../managedResourceReadiness', async (importOriginal) => ({
  ...(await importOriginal<typeof ManagedResourceReadinessModule>()),
  resolveManagedResourceReadiness: readinessMocks.resolveManagedResourceReadiness,
}));

const db: LobeChatDatabase = await getTestDB();
const flagsOn = { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_PLATFORM_MANAGED_AI: true };

const publish = async (aiProviders: ManagedResourcePolicyItem) => {
  const model = new PlatformManagedResourcePolicyModel(db);
  await model.ensureRows();
  const policies = createUnmanagedResourcePolicyMap();
  policies.aiProviders = aiProviders;
  await model.materializePublished({ policies, revision: 1 });
  resetPlatformAiTakeoverCacheForTest();
};

const saveDraftOnly = async (aiProviders: ManagedResourcePolicyItem) => {
  const model = new PlatformManagedResourcePolicyModel(db);
  await model.ensureRows();
  const draft = createUnmanagedResourcePolicyMap();
  draft.aiProviders = aiProviders;
  await model.replaceDraft({ draft });
  resetPlatformAiTakeoverCacheForTest();
};

beforeEach(async () => {
  resetPlatformAiTakeoverCacheForTest();
  await db.delete(platformManagedResourcePolicies);
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetPlatformAiTakeoverCacheForTest();
  await db.delete(platformManagedResourcePolicies);
});

describe('isPlatformAiTakeoverActive', () => {
  it('is false without the feature flag, and never reads the policy table', async () => {
    await publish({ enforcementMode: 'enforced', managed: true });
    const failOnRead = new Proxy(
      {},
      {
        get() {
          throw new Error('policy table must not be read while the flag is off');
        },
      },
    ) as LobeChatDatabase;

    expect(await isPlatformAiTakeoverActive(failOnRead, DEFAULT_ENTERPRISE_FEATURE_FLAGS)).toBe(
      false,
    );
  });

  it('is false while the enforced policy is only a draft', async () => {
    await saveDraftOnly({ enforcementMode: 'enforced', managed: true });

    expect(await isPlatformAiTakeoverActive(db, flagsOn)).toBe(false);
  });

  it('is false for the 用户自配 (observe) published policy', async () => {
    await publish({ enforcementMode: 'observe', managed: false });

    expect(await isPlatformAiTakeoverActive(db, flagsOn)).toBe(false);
  });

  it('is false for observe-with-managed and for ui-only (UI hiding is not a runtime takeover)', async () => {
    await publish({ enforcementMode: 'observe', managed: true });
    expect(await isPlatformAiTakeoverActive(db, flagsOn)).toBe(false);

    await publish({ enforcementMode: 'ui-only', managed: true });
    expect(await isPlatformAiTakeoverActive(db, flagsOn)).toBe(false);
  });

  it('is false for enforced-but-not-managed', async () => {
    await publish({ enforcementMode: 'enforced', managed: false });

    expect(await isPlatformAiTakeoverActive(db, flagsOn)).toBe(false);
  });

  it('is true only for a published managed+enforced policy', async () => {
    await publish({ enforcementMode: 'enforced', managed: true });

    expect(await isPlatformAiTakeoverActive(db, flagsOn)).toBe(true);
  });

  it('never consults managed-resource readiness (that probe decrypts every secret)', async () => {
    await publish({ enforcementMode: 'enforced', managed: true });

    expect(await isPlatformAiTakeoverActive(db, flagsOn)).toBe(true);
    expect(readinessMocks.resolveManagedResourceReadiness).not.toHaveBeenCalled();
  });

  it('memoizes per db for a bounded window and re-reads once it expires', async () => {
    // The window only bounds staleness on instances that did NOT process the publish; the
    // publishing instance drops the memo synchronously (see the reset test below).
    expect(PLATFORM_AI_TAKEOVER_MEMO_TTL_MS).toBeLessThanOrEqual(2000);
    await publish({ enforcementMode: 'enforced', managed: true });
    const now = vi.fn<() => number>().mockReturnValue(1000);

    expect(await isPlatformAiTakeoverActive(db, flagsOn, now)).toBe(true);

    // Policy flipped underneath (as if by another instance): memoized answer inside the TTL …
    const model = new PlatformManagedResourcePolicyModel(db);
    await model.materializePublished({
      policies: createUnmanagedResourcePolicyMap(),
      revision: 2,
    });
    expect(await isPlatformAiTakeoverActive(db, flagsOn, now)).toBe(true);

    // … and re-read once it expires, so ending enforcement is not delayed.
    now.mockReturnValue(1000 + PLATFORM_AI_TAKEOVER_MEMO_TTL_MS + 1);
    expect(await isPlatformAiTakeoverActive(db, flagsOn, now)).toBe(false);
  });

  it('resetPlatformAiTakeoverCache makes the very next read observe the new policy', async () => {
    await publish({ enforcementMode: 'enforced', managed: true });
    const now = vi.fn<() => number>().mockReturnValue(1000);
    expect(await isPlatformAiTakeoverActive(db, flagsOn, now)).toBe(true);

    await new PlatformManagedResourcePolicyModel(db).materializePublished({
      policies: createUnmanagedResourcePolicyMap(),
      revision: 2,
    });
    // Publication calls this after the transaction commits — no TTL wait on this instance.
    resetPlatformAiTakeoverCache();

    expect(await isPlatformAiTakeoverActive(db, flagsOn, now)).toBe(false);
  });

  it('fails closed: a policy read failure propagates instead of degrading to unmanaged', async () => {
    const brokenDb = {
      select: () => {
        throw new Error('policy table unavailable');
      },
    } as unknown as LobeChatDatabase;

    await expect(isPlatformAiTakeoverActive(brokenDb, flagsOn)).rejects.toThrow(
      'policy table unavailable',
    );
  });
});
