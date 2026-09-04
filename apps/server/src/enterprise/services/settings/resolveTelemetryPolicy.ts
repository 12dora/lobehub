/**
 * Cheap effective `general.telemetry` for server-side analytics gates.
 *
 * One round trip on a published-policy cache hit: user existence, override row,
 * legacy `user_settings`, preference, and the platform revision share a single
 * SELECT. Policies come from `readPublishedPoliciesCache` (same map and
 * revision-keyed invalidation as effective-settings materialization).
 *
 * Precedence: TELEMETRY_DISABLED → locked policy → explicit user value
 * (override row, then legacy setting, then legacy preference) → default-mode
 * policy → false. A missing user row fails closed before any platform default.
 */

import { DEFAULT_COMMON_SETTINGS } from '@lobechat/const';
import { isRecord } from '@lobechat/utils/object';
import { and, eq, sql } from 'drizzle-orm';

import { PLATFORM_SETTINGS_BUNDLE_ID, PlatformSettingsModel } from '@/database/models/platform';
import { users, userSettingOverrides, userSettings } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { appEnv } from '@/envs/app';

import { resolvePathUserOverride } from './effectiveResolveAll';
import { resolveSettingPath } from './effectiveResolvePath';
import { readPublishedPoliciesCache, writePublishedPoliciesCache } from './effectiveSettingsCache';
import { publishedRowsToPolicyMap } from './effectiveSettingsMaps';
import { settingsRegistry } from './registry';
import { isSettingsPolicyEnabled } from './runtimeSettingsAdapter';

export const TELEMETRY_SETTING_PATH = 'general.telemetry';

export interface ResolveEffectiveTelemetryParams {
  db: LobeChatDatabase;
  userId: string;
}

interface TelemetryUserLayers {
  general: Record<string, unknown> | null;
  hasOverrideRow: boolean;
  overrideValue: unknown;
  platformRevision: number;
  preferenceTelemetry: unknown;
}

const loadTelemetryUserLayers = async (
  db: LobeChatDatabase,
  userId: string,
): Promise<TelemetryUserLayers | null> => {
  const rows = await db
    .select({
      general: userSettings.general,
      overridePath: userSettingOverrides.path,
      overrideValue: userSettingOverrides.value,
      platformRevision: sql<number>`COALESCE(
        (
          SELECT "revision"
          FROM "platform_settings_bundle"
          WHERE "id" = ${PLATFORM_SETTINGS_BUNDLE_ID}
        ),
        0
      )`,
      preference: users.preference,
      userId: users.id,
    })
    .from(users)
    .leftJoin(userSettings, eq(userSettings.id, users.id))
    .leftJoin(
      userSettingOverrides,
      and(
        eq(userSettingOverrides.userId, users.id),
        eq(userSettingOverrides.path, TELEMETRY_SETTING_PATH),
      ),
    )
    .where(eq(users.id, userId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const preference = isRecord(row.preference) ? row.preference : null;

  return {
    general: isRecord(row.general) ? row.general : null,
    hasOverrideRow: row.overridePath != null,
    overrideValue: row.overrideValue,
    platformRevision: Number(row.platformRevision ?? 0),
    preferenceTelemetry: preference?.telemetry,
  };
};

const resolveTelemetryUserOverride = (layers: TelemetryUserLayers) => {
  const override = layers.hasOverrideRow ? { value: layers.overrideValue } : undefined;
  const fromSettings = resolvePathUserOverride(
    override,
    { general: layers.general ?? {} },
    TELEMETRY_SETTING_PATH,
  );
  if (fromSettings) return fromSettings;
  if (typeof layers.preferenceTelemetry === 'boolean') {
    return { value: layers.preferenceTelemetry };
  }
  return null;
};

const loadPublishedTelemetryPolicy = async (db: LobeChatDatabase, platformRevision: number) => {
  let policies = readPublishedPoliciesCache(platformRevision);
  if (!policies) {
    const model = new PlatformSettingsModel(db);
    policies = publishedRowsToPolicyMap(await model.listPublishedPolicies());
    writePublishedPoliciesCache(platformRevision, policies);
  }
  return policies[TELEMETRY_SETTING_PATH] ?? null;
};

/**
 * Resolve effective `general.telemetry` for a user.
 *
 * - `locked` wins outright (override retained but ignored by the resolver)
 * - `default` supplies the platform value only when the user has no explicit value
 * - module / flag off → ignore published policies; still honor override + legacy
 * - missing user / kill switch / read errors → false
 */
export async function resolveEffectiveTelemetry(
  params: ResolveEffectiveTelemetryParams,
): Promise<boolean> {
  if (appEnv.TELEMETRY_DISABLED) return false;

  try {
    const layers = await loadTelemetryUserLayers(params.db, params.userId);
    // Fail closed before any platform default can apply.
    if (!layers) return false;

    const userOverride = resolveTelemetryUserOverride(layers);
    const platformPolicyEnabled = await isSettingsPolicyEnabled();
    const policy = platformPolicyEnabled
      ? await loadPublishedTelemetryPolicy(params.db, layers.platformRevision)
      : null;

    const resolved = resolveSettingPath({
      builtInDefault:
        settingsRegistry.get(TELEMETRY_SETTING_PATH)?.builtInDefault ??
        DEFAULT_COMMON_SETTINGS.telemetry,
      path: TELEMETRY_SETTING_PATH,
      platformPolicyEnabled,
      policy,
      userOverride,
    });

    return resolved.effectiveValue === true;
  } catch {
    return false;
  }
}
