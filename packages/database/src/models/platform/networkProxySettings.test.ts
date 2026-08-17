// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDefaultNetworkProxyConfig } from '@/types/platform/networkProxy';

import { getTestDB } from '../../core/getTestDB';
import { platformNetworkProxySettings } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { PlatformRevisionConflictError } from './errors';
import {
  NetworkProxySettingsModel,
  PLATFORM_NETWORK_PROXY_SETTINGS_ID,
} from './networkProxySettings';

const db: LobeChatDatabase = await getTestDB();

const cleanup = async () => {
  await db.delete(platformNetworkProxySettings);
};

beforeEach(cleanup);
afterEach(cleanup);

describe('NetworkProxySettingsModel', () => {
  it('applies migration tables that match the drizzle schema', async () => {
    const rows = await db.select().from(platformNetworkProxySettings);
    expect(rows).toEqual([]);
    expect(PLATFORM_NETWORK_PROXY_SETTINGS_ID).toBe('default');
  });

  it('returns null when the singleton row is absent', async () => {
    const model = new NetworkProxySettingsModel(db);
    expect(await model.get()).toBeNull();
  });

  it('ensureDefault inserts the built-in off-mode config once', async () => {
    const model = new NetworkProxySettingsModel(db);
    const first = await model.ensureDefault();
    expect(first.id).toBe(PLATFORM_NETWORK_PROXY_SETTINGS_ID);
    expect(first.config.masterEnabled).toBe(false);
    expect(first.revision).toBe(0);
    expect(first.engineGeneration).toBe(0);
    expect(first.desiredArtifacts).toEqual({});

    const second = await model.ensureDefault();
    expect(second.revision).toBe(0);
    const rows = await db.select().from(platformNetworkProxySettings);
    expect(rows).toHaveLength(1);
  });

  it('inserts on first update and advances revision via CAS', async () => {
    const model = new NetworkProxySettingsModel(db);
    const config = createDefaultNetworkProxyConfig();
    config.masterEnabled = false;
    config.outlet.mode = 'manual';

    const next = await model.update({
      config,
      expectedRevision: 0,
      updatedBy: 'admin-user',
    });
    expect(next.revision).toBe(1);
    expect(next.config.outlet.mode).toBe('manual');
    expect(next.updatedBy).toBe('admin-user');

    const reread = await model.get();
    expect(reread).toEqual(next);
  });

  it('rejects stale expectedRevision (two-writer CAS)', async () => {
    const model = new NetworkProxySettingsModel(db);
    const config = createDefaultNetworkProxyConfig();
    await model.update({ config, expectedRevision: 0, updatedBy: 'admin-a' });

    const next = createDefaultNetworkProxyConfig();
    next.ruleMode = 'smart';
    await model.update({ config: next, expectedRevision: 1, updatedBy: 'admin-a' });

    await expect(
      model.update({
        config: createDefaultNetworkProxyConfig(),
        expectedRevision: 1,
        updatedBy: 'admin-b',
      }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);

    const current = await model.get();
    expect(current?.revision).toBe(2);
    expect(current?.config.ruleMode).toBe('smart');
  });

  it('bumpEngineGeneration increments generation and revision', async () => {
    const model = new NetworkProxySettingsModel(db);
    await model.ensureDefault();
    const bumped = await model.bumpEngineGeneration({
      expectedRevision: 0,
      updatedBy: 'admin-user',
    });
    expect(bumped.revision).toBe(1);
    expect(bumped.engineGeneration).toBe(1);

    const again = await model.bumpEngineGeneration({
      expectedRevision: 1,
      updatedBy: 'admin-user',
    });
    expect(again.revision).toBe(2);
    expect(again.engineGeneration).toBe(2);
  });

  it('rejects stale expectedRevision on bumpEngineGeneration', async () => {
    const model = new NetworkProxySettingsModel(db);
    await model.ensureDefault();
    await model.bumpEngineGeneration({ expectedRevision: 0, updatedBy: 'admin-a' });

    await expect(
      model.bumpEngineGeneration({ expectedRevision: 0, updatedBy: 'admin-b' }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);

    const current = await model.get();
    expect(current?.revision).toBe(1);
    expect(current?.engineGeneration).toBe(1);
  });

  it('rejects stale expectedRevision on setDesiredArtifacts', async () => {
    const model = new NetworkProxySettingsModel(db);
    await model.ensureDefault();
    await model.setDesiredArtifacts(
      { engine: { requestedAt: '2026-08-17T00:00:00.000Z', version: 'v1.19.30' } },
      { expectedRevision: 0, updatedBy: 'admin-a' },
    );

    await expect(
      model.setDesiredArtifacts(
        { engine: { requestedAt: '2026-08-17T00:00:01.000Z', version: 'v9.9.9' } },
        { expectedRevision: 0, updatedBy: 'admin-b' },
      ),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);

    const current = await model.get();
    expect(current?.revision).toBe(1);
    expect(current?.desiredArtifacts.engine?.version).toBe('v1.19.30');
  });

  it('setDesiredArtifacts merges the patch and bumps revision', async () => {
    const model = new NetworkProxySettingsModel(db);
    await model.ensureDefault();
    const first = await model.setDesiredArtifacts(
      { engine: { requestedAt: '2026-08-17T00:00:00.000Z', version: 'v1.19.30' } },
      { expectedRevision: 0, updatedBy: 'admin-user' },
    );
    expect(first.revision).toBe(1);
    expect(first.desiredArtifacts.engine?.version).toBe('v1.19.30');

    const second = await model.setDesiredArtifacts(
      { geoip: { commit: 'abc123', requestedAt: '2026-08-17T00:01:00.000Z' } },
      { expectedRevision: 1, updatedBy: 'admin-user' },
    );
    expect(second.revision).toBe(2);
    expect(second.desiredArtifacts.engine?.version).toBe('v1.19.30');
    expect(second.desiredArtifacts.geoip?.commit).toBe('abc123');
  });
});
