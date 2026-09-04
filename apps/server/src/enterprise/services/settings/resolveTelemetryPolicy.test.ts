// @vitest-environment node
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { PlatformSettingsModel } from '@/database/models/platform';
import { users, userSettings } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { appEnv } from '@/envs/app';

import { AdminSettingsService } from './adminSettingsService';
import { resetEffectiveSettingsCacheForTest } from './effectiveSettingsService';
import { resolveEffectiveTelemetry, TELEMETRY_SETTING_PATH } from './resolveTelemetryPolicy';

const { isModuleEnabled } = vi.hoisted(() => ({
  isModuleEnabled: vi.fn(async (_id: string) => true),
}));

vi.mock('../../featureFlags', async (importOriginal) => {
  const actual = (await importOriginal()) as {
    getDefaultEnterpriseFeatureFlags: () => Record<string, boolean>;
  };
  return {
    ...actual,
    getEnterpriseFeatureFlags: () => ({
      ...actual.getDefaultEnterpriseFeatureFlags(),
      ENABLE_PLATFORM_SETTINGS_POLICY: true,
    }),
  };
});

vi.mock('../moduleSettings', () => ({
  isModuleEnabled: (id: string) => isModuleEnabled(id),
}));

vi.mock('@/envs/app', () => ({
  appEnv: {
    TELEMETRY_DISABLED: false,
  },
}));

const serverDB: LobeChatDatabase = await getTestDB();
const admin = new AdminSettingsService(serverDB);
const settingsModel = new PlatformSettingsModel(serverDB);

const USER_ID = 'telemetry-user';

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

const ensureUser = async (id: string) => {
  await serverDB.insert(users).values({ id }).onConflictDoNothing();
};

const publishTelemetryPolicy = async (policy: {
  mode: 'user' | 'default' | 'locked';
  value: boolean;
}) => {
  const base = await admin.getDraft();
  await admin.save({
    actorUserId: 'admin',
    expectedDraftToken: base.draftToken,
    expectedRevision: base.baseRevision,
    policies: {
      [TELEMETRY_SETTING_PATH]: {
        mode: policy.mode,
        schemaVersion: 1,
        value: policy.value,
        visibility: 'visible',
      },
    },
    reason: 'seed telemetry policy',
  });
};

beforeEach(async () => {
  isModuleEnabled.mockReset().mockResolvedValue(true);
  vi.mocked(appEnv).TELEMETRY_DISABLED = false;
  resetEffectiveSettingsCacheForTest();
  await resetSettingsTables();
  await serverDB.delete(userSettings).where(eq(userSettings.id, USER_ID));
  await ensureUser(USER_ID);
  await serverDB.update(users).set({ preference: {} }).where(eq(users.id, USER_ID));
});

afterEach(async () => {
  resetEffectiveSettingsCacheForTest();
  await resetSettingsTables();
  await serverDB.delete(userSettings).where(eq(userSettings.id, USER_ID));
});

describe('resolveEffectiveTelemetry', () => {
  it('lets an override row beat both a legacy leaf and a default-mode policy', async () => {
    await publishTelemetryPolicy({ mode: 'default', value: true });
    await serverDB.insert(userSettings).values({
      general: { telemetry: true },
      id: USER_ID,
    });
    await settingsModel.upsertUserOverride({
      path: TELEMETRY_SETTING_PATH,
      userId: USER_ID,
      value: false,
    });

    await expect(resolveEffectiveTelemetry({ db: serverDB, userId: USER_ID })).resolves.toBe(false);
  });

  it('ignores published policies when the settingsPolicy module is off', async () => {
    isModuleEnabled.mockResolvedValue(false);
    await publishTelemetryPolicy({ mode: 'locked', value: true });
    await settingsModel.upsertUserOverride({
      path: TELEMETRY_SETTING_PATH,
      userId: USER_ID,
      value: false,
    });

    await expect(resolveEffectiveTelemetry({ db: serverDB, userId: USER_ID })).resolves.toBe(false);

    await settingsModel.upsertUserOverride({
      path: TELEMETRY_SETTING_PATH,
      userId: USER_ID,
      value: true,
    });
    await expect(resolveEffectiveTelemetry({ db: serverDB, userId: USER_ID })).resolves.toBe(true);
  });

  it('lets a locked false policy beat an override true', async () => {
    await publishTelemetryPolicy({ mode: 'locked', value: false });
    await settingsModel.upsertUserOverride({
      path: TELEMETRY_SETTING_PATH,
      userId: USER_ID,
      value: true,
    });

    await expect(resolveEffectiveTelemetry({ db: serverDB, userId: USER_ID })).resolves.toBe(false);
  });

  it('does not let a default true policy beat an override false', async () => {
    await publishTelemetryPolicy({ mode: 'default', value: true });
    await settingsModel.upsertUserOverride({
      path: TELEMETRY_SETTING_PATH,
      userId: USER_ID,
      value: false,
    });

    await expect(resolveEffectiveTelemetry({ db: serverDB, userId: USER_ID })).resolves.toBe(false);
  });

  it('returns false for a missing user before applying a platform default', async () => {
    await publishTelemetryPolicy({ mode: 'default', value: true });

    await expect(
      resolveEffectiveTelemetry({ db: serverDB, userId: 'missing-telemetry-user' }),
    ).resolves.toBe(false);
  });

  it('returns false when TELEMETRY_DISABLED is set even if the user opted in', async () => {
    vi.mocked(appEnv).TELEMETRY_DISABLED = true;
    await settingsModel.upsertUserOverride({
      path: TELEMETRY_SETTING_PATH,
      userId: USER_ID,
      value: true,
    });
    await publishTelemetryPolicy({ mode: 'locked', value: true });

    await expect(resolveEffectiveTelemetry({ db: serverDB, userId: USER_ID })).resolves.toBe(false);
    expect(isModuleEnabled).not.toHaveBeenCalled();
  });

  it('falls back to the legacy setting then preference when no override row exists', async () => {
    await publishTelemetryPolicy({ mode: 'default', value: false });
    await serverDB.insert(userSettings).values({
      general: { telemetry: true },
      id: USER_ID,
    });

    await expect(resolveEffectiveTelemetry({ db: serverDB, userId: USER_ID })).resolves.toBe(true);

    await serverDB.delete(userSettings).where(eq(userSettings.id, USER_ID));
    await serverDB
      .update(users)
      .set({ preference: { telemetry: true } })
      .where(eq(users.id, USER_ID));

    await expect(resolveEffectiveTelemetry({ db: serverDB, userId: USER_ID })).resolves.toBe(true);
  });
});
