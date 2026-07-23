// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { platformAuthSettings } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { PLATFORM_AUTH_SETTINGS_ID, PlatformAuthSettingsModel } from './authSettings';

const db: LobeChatDatabase = await getTestDB();

const cleanup = async () => {
  await db.delete(platformAuthSettings);
};

beforeEach(cleanup);
afterEach(cleanup);

describe('PlatformAuthSettingsModel', () => {
  it('returns built-in defaults (open registration, no restriction) when the row is absent', async () => {
    const model = new PlatformAuthSettingsModel(db);
    expect(await model.get()).toEqual({
      emailDomainAllowlist: [],
      emailDomainAllowlistEnabled: false,
      openRegistration: true,
    });
  });

  it('inserts the singleton row on first update and normalizes the domain list', async () => {
    const model = new PlatformAuthSettingsModel(db);
    const next = await model.update('admin-user', {
      emailDomainAllowlist: ['@Example.com', 'example.com', '*.acme.io'],
      emailDomainAllowlistEnabled: true,
      openRegistration: false,
    });

    expect(next).toEqual({
      emailDomainAllowlist: ['example.com', '*.acme.io'],
      emailDomainAllowlistEnabled: true,
      openRegistration: false,
    });

    // Persisted under the fixed singleton id and re-readable.
    const [row] = await db.select().from(platformAuthSettings);
    expect(row?.id).toBe(PLATFORM_AUTH_SETTINGS_ID);
    expect(await model.get()).toEqual(next);
  });

  it('merges a partial patch onto the existing row (upsert, single row only)', async () => {
    const model = new PlatformAuthSettingsModel(db);
    await model.update('admin-user', {
      emailDomainAllowlist: ['example.com'],
      emailDomainAllowlistEnabled: true,
      openRegistration: false,
    });

    // Patch only openRegistration; allowlist fields are preserved.
    const merged = await model.update('other-admin', { openRegistration: true });
    expect(merged).toEqual({
      emailDomainAllowlist: ['example.com'],
      emailDomainAllowlistEnabled: true,
      openRegistration: true,
    });

    const rows = await db.select().from(platformAuthSettings);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.updatedBy).toBe('other-admin');
  });
});
