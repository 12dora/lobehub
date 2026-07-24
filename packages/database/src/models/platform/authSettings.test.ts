// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { platformAuthSettings } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { PLATFORM_AUTH_SETTINGS_ID, PlatformAuthSettingsModel } from './authSettings';
import { PlatformRevisionConflictError } from './errors';

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
      revision: 0,
    });
  });

  it('inserts the singleton row on first update and normalizes the domain list', async () => {
    const model = new PlatformAuthSettingsModel(db);
    const next = await model.update('admin-user', {
      emailDomainAllowlist: ['@Example.com', 'example.com', '*.acme.io'],
      emailDomainAllowlistEnabled: true,
      expectedRevision: 0,
      openRegistration: false,
    });

    expect(next).toEqual({
      emailDomainAllowlist: ['example.com', '*.acme.io'],
      emailDomainAllowlistEnabled: true,
      openRegistration: false,
      revision: 1,
    });

    // Persisted under the fixed singleton id and re-readable.
    const [row] = await db.select().from(platformAuthSettings);
    expect(row?.id).toBe(PLATFORM_AUTH_SETTINGS_ID);
    expect(await model.get()).toEqual(next);
  });

  it('merges a partial patch onto the existing row with CAS revision advance', async () => {
    const model = new PlatformAuthSettingsModel(db);
    await model.update('admin-user', {
      emailDomainAllowlist: ['example.com'],
      emailDomainAllowlistEnabled: true,
      expectedRevision: 0,
      openRegistration: false,
    });

    // Patch only openRegistration; allowlist fields are preserved.
    const merged = await model.update('other-admin', {
      expectedRevision: 1,
      openRegistration: true,
    });
    expect(merged).toEqual({
      emailDomainAllowlist: ['example.com'],
      emailDomainAllowlistEnabled: true,
      openRegistration: true,
      revision: 2,
    });

    const rows = await db.select().from(platformAuthSettings);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.updatedBy).toBe('other-admin');
  });

  it('rejects stale expectedRevision (two-writer CAS)', async () => {
    const model = new PlatformAuthSettingsModel(db);
    await model.update('admin-a', {
      expectedRevision: 0,
      openRegistration: true,
    });
    // Writer A closes registration.
    await model.update('admin-a', {
      expectedRevision: 1,
      openRegistration: false,
    });
    // Writer B still holds revision 1 and would reopen — must conflict.
    await expect(
      model.update('admin-b', {
        emailDomainAllowlist: ['corp.example'],
        emailDomainAllowlistEnabled: true,
        expectedRevision: 1,
        openRegistration: true,
      }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);

    const current = await model.get();
    expect(current.openRegistration).toBe(false);
    expect(current.revision).toBe(2);
  });

  it('rejects emailDomainAllowlistEnabled with an empty list', async () => {
    const model = new PlatformAuthSettingsModel(db);
    await expect(
      model.update('admin-user', {
        emailDomainAllowlist: [],
        emailDomainAllowlistEnabled: true,
        expectedRevision: 0,
        openRegistration: true,
      }),
    ).rejects.toThrow(/PLATFORM_AUTH_SETTINGS_ALLOWLIST_EMPTY/);
  });
});
