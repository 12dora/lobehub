// @vitest-environment node
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import type { SettingsDraftPolicyMap } from '@/database/models/platform';
import { PlatformSettingsModel } from '@/database/models/platform';
import { users } from '@/database/schemas';
import { platformSettingPolicies, platformSettingsBundle } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import { AdminSettingsService } from './adminSettingsService';
import { publishedRowsToPolicyMap } from './effectiveSettingsMaps';
import {
  EffectiveSettingsService,
  resetEffectiveSettingsCacheForTest,
} from './effectiveSettingsService';
import {
  canonicalizeLockVisiblePolicy,
  canonicalizeLockVisiblePolicyMap,
  isLockVisiblyPath,
  repairLockVisiblePublishedPolicies,
} from './lockVisiblePolicy';

vi.mock('../../featureFlags', async (importOriginal) => {
  const actual = (await importOriginal()) as {
    getDefaultEnterpriseFeatureFlags: () => Record<string, boolean>;
    getEnterpriseFeatureFlags: () => Record<string, boolean>;
  };
  return {
    ...actual,
    getEnterpriseFeatureFlags: () => ({
      ...actual.getDefaultEnterpriseFeatureFlags(),
      ENABLE_PLATFORM_SETTINGS_POLICY: true,
    }),
  };
});

const serverDB: LobeChatDatabase = await getTestDB();
const admin = new AdminSettingsService(serverDB);
const model = new PlatformSettingsModel(serverDB);

const TELEMETRY = 'general.telemetry';
const MEMORY = 'memory.enabled';

const lockedHidden = (value: unknown): SettingsDraftPolicyMap[string] => ({
  mode: 'locked',
  schemaVersion: 1,
  value,
  visibility: 'hidden',
});

const resetSettingsTables = async () => {
  await serverDB.execute(
    sql.raw(`
      TRUNCATE TABLE
        platform_audit_logs,
        platform_resource_revisions,
        user_setting_overrides,
        user_setting_override_revisions,
        platform_setting_policies,
        platform_settings_bundle
      CASCADE
    `),
  );
};

beforeEach(async () => {
  resetEffectiveSettingsCacheForTest();
  await resetSettingsTables();
  await serverDB
    .insert(users)
    .values([{ id: 'u1' }])
    .onConflictDoNothing();
});

afterEach(async () => {
  await resetSettingsTables();
});

const seedPublishedLockedHidden = async () => {
  const draft: SettingsDraftPolicyMap = {
    [MEMORY]: lockedHidden(true),
    [TELEMETRY]: lockedHidden(false),
  };
  await model.ensureBundle();
  await model.saveDraft({ draft, updatedBy: 'legacy-admin' });
  await model.replacePublishedPolicies({ draft, revision: 16, updatedBy: 'legacy-admin' });
  await serverDB
    .update(platformSettingsBundle)
    .set({ revision: 16 })
    .where(eq(platformSettingsBundle.id, 'global'));
};

describe('lock-visible policy canonicalization', () => {
  it('allow-lists telemetry and leaves other paths off the list', () => {
    expect(isLockVisiblyPath(TELEMETRY)).toBe(true);
    expect(isLockVisiblyPath(MEMORY)).toBe(false);
    expect(isLockVisiblyPath('general.fontSize')).toBe(false);
  });

  it('projects locked telemetry to visible and leaves non-allow-listed locked paths hidden', () => {
    expect(
      canonicalizeLockVisiblePolicy(TELEMETRY, {
        mode: 'locked',
        schemaVersion: 1,
        value: false,
        visibility: 'hidden',
      }),
    ).toMatchObject({ mode: 'locked', visibility: 'visible', value: false });

    const memory = {
      mode: 'locked' as const,
      schemaVersion: 1,
      value: true,
      visibility: 'hidden' as const,
    };
    expect(canonicalizeLockVisiblePolicy(MEMORY, memory)).toBe(memory);

    const alreadyVisible = {
      mode: 'locked' as const,
      schemaVersion: 1,
      value: false,
      visibility: 'visible' as const,
    };
    expect(canonicalizeLockVisiblePolicy(TELEMETRY, alreadyVisible)).toBe(alreadyVisible);

    const userHidden = {
      mode: 'user' as const,
      schemaVersion: 1,
      value: false,
      visibility: 'hidden' as const,
    };
    expect(canonicalizeLockVisiblePolicy(TELEMETRY, userHidden)).toBe(userHidden);
  });

  it('projects a published-row map used by the effective-settings cache fill', () => {
    const mapped = publishedRowsToPolicyMap([
      { mode: 'locked', path: TELEMETRY, schemaVersion: 1, value: false, visibility: 'hidden' },
      { mode: 'locked', path: MEMORY, schemaVersion: 1, value: true, visibility: 'hidden' },
    ]);
    expect(mapped[TELEMETRY]).toMatchObject({
      mode: 'locked',
      visibility: 'visible',
      value: false,
    });
    expect(mapped[MEMORY]).toMatchObject({ mode: 'locked', visibility: 'hidden', value: true });
  });

  it('returns the same map reference when nothing needs projection', () => {
    const policies: SettingsDraftPolicyMap = {
      [MEMORY]: lockedHidden(true),
    };
    expect(canonicalizeLockVisiblePolicyMap(policies)).toBe(policies);
  });
});

describe('lock-visible published policy read projection', () => {
  it('hydrates admin getDraft as locked+visible without mutating the DB row', async () => {
    await seedPublishedLockedHidden();

    const snapshot = await admin.getDraft();
    expect(snapshot.publishedPolicies[TELEMETRY]).toMatchObject({
      mode: 'locked',
      value: false,
      visibility: 'visible',
    });
    expect(snapshot.draft[TELEMETRY]).toMatchObject({
      mode: 'locked',
      value: false,
      visibility: 'visible',
    });
    expect(snapshot.publishedPolicies[MEMORY]).toMatchObject({
      mode: 'locked',
      visibility: 'hidden',
    });
    expect(snapshot.draft[MEMORY]).toMatchObject({ mode: 'locked', visibility: 'hidden' });
    expect(snapshot.registry.find((entry) => entry.path === TELEMETRY)?.lockVisibly).toBe(true);
    expect(snapshot.registry.find((entry) => entry.path === MEMORY)?.lockVisibly).toBeUndefined();

    const raw = await model.listPublishedPolicies();
    expect(raw.find((row) => row.path === TELEMETRY)?.visibility).toBe('hidden');
    expect(raw.find((row) => row.path === MEMORY)?.visibility).toBe('hidden');
  });

  it('projects locked telemetry to visible for user effective settings', async () => {
    await seedPublishedLockedHidden();

    const effective = await new EffectiveSettingsService(serverDB).getEffectiveSettings({
      userId: 'u1',
    });
    expect(effective.pathMeta[TELEMETRY]).toMatchObject({
      hidden: false,
      locked: true,
      mode: 'locked',
      visibility: 'visible',
    });
    expect(effective.pathMeta[MEMORY]).toMatchObject({
      hidden: true,
      locked: true,
      mode: 'locked',
      visibility: 'hidden',
    });
  });
});

describe('lock-visible published policy write canonicalization', () => {
  it('persists locked telemetry as visible and leaves other locked paths hidden', async () => {
    const base = await admin.getDraft();
    await admin.save({
      actorUserId: 'u1',
      expectedDraftToken: base.draftToken,
      expectedRevision: base.baseRevision,
      policies: {
        [MEMORY]: lockedHidden(true),
        [TELEMETRY]: lockedHidden(false),
      },
      reason: 'lock telemetry and memory',
    });

    const rows = await serverDB.select().from(platformSettingPolicies);
    expect(rows.find((row) => row.path === TELEMETRY)).toMatchObject({
      mode: 'locked',
      value: false,
      visibility: 'visible',
    });
    expect(rows.find((row) => row.path === MEMORY)).toMatchObject({
      mode: 'locked',
      value: true,
      visibility: 'hidden',
    });

    const after = await admin.getDraft();
    expect(after.publishedPolicies[TELEMETRY]?.visibility).toBe('visible');
    expect(after.draft[TELEMETRY]?.visibility).toBe('visible');
    expect(after.publishedPolicies[MEMORY]?.visibility).toBe('hidden');
  });
});

describe('lock-visible published policy bootstrap repair', () => {
  it('flips locked+hidden allow-listed rows to visible without bumping revision, and is idempotent', async () => {
    await seedPublishedLockedHidden();
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    const first = await repairLockVisiblePublishedPolicies(serverDB);
    expect(first.repairedPaths).toEqual([TELEMETRY]);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(String(infoSpy.mock.calls[0]?.[0])).toContain(
      'repaired lock-visible published policies',
    );

    const after = await model.listPublishedPolicies();
    expect(after.find((row) => row.path === TELEMETRY)).toMatchObject({
      mode: 'locked',
      revision: 16,
      value: false,
      visibility: 'visible',
    });
    expect(after.find((row) => row.path === MEMORY)).toMatchObject({
      mode: 'locked',
      revision: 16,
      visibility: 'hidden',
    });
    expect((await model.getBundle())?.revision).toBe(16);

    const second = await repairLockVisiblePublishedPolicies(serverDB);
    expect(second.repairedPaths).toEqual([]);
    expect(infoSpy).toHaveBeenCalledTimes(1);

    infoSpy.mockRestore();
  });
});
