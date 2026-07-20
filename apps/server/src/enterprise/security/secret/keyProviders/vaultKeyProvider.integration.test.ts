// @vitest-environment node
import { randomBytes } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { platformConnectors, platformConnectorSecrets, platformJobs } from '@/database/schemas';
import { PlatformSecretRewrapCoordinator } from '@/server/enterprise/services/secretRewrap/coordinator';
import { processNextPlatformSecretRewrapBatch } from '@/server/enterprise/services/secretRewrap/worker';

import { PlatformSecretService } from '../platformSecretService';
import { VaultKeyProvider } from './vaultKeyProvider';

const enabled = process.env.AIHUB_TEST_VAULT_INTEGRATION === '1';
const rootToken = process.env.AIHUB_TEST_VAULT_ROOT_TOKEN;
const address = process.env.AIHUB_TEST_VAULT_ADDR ?? 'http://127.0.0.1:8200';
const suffix = randomBytes(6).toString('hex');
const mountPath = `aihub-test-${suffix}`;
const authMountPath = `approle-test-${suffix}`;
const policyName = `aihub-kek-read-${suffix}`;
const roleName = `aihub-app-${suffix}`;
const secretPath = 'platform/master-key';
const oldKey = Buffer.alloc(32, 0x31).toString('base64');
const newKey = Buffer.alloc(32, 0x32).toString('base64');

const rootRequest = async (path: string, init: RequestInit = {}) => {
  if (!rootToken) throw new Error('AIHUB_TEST_VAULT_ROOT_TOKEN is required for bootstrap');
  const response = await fetch(new URL(path, address), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Vault-Token': rootToken,
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`Vault bootstrap request failed with HTTP ${response.status}`);
  const text = await response.text();
  return text ? (JSON.parse(text) as unknown) : undefined;
};

const writeKeySet = async (active: { key: string; keyId: string }, historical: unknown[]) =>
  rootRequest(`v1/${mountPath}/data/${secretPath}`, {
    body: JSON.stringify({ data: { active, historical } }),
    method: 'POST',
  });

describe.skipIf(!enabled || !rootToken)('VaultKeyProvider real Vault integration', () => {
  let roleId = '';
  let secretId = '';

  beforeAll(async () => {
    await rootRequest(`v1/sys/mounts/${mountPath}`, {
      body: JSON.stringify({ options: { version: '2' }, type: 'kv' }),
      method: 'POST',
    });
    await rootRequest(`v1/sys/auth/${authMountPath}`, {
      body: JSON.stringify({ type: 'approle' }),
      method: 'POST',
    });
    await rootRequest(`v1/sys/policies/acl/${policyName}`, {
      body: JSON.stringify({
        policy: `path "${mountPath}/data/${secretPath}" { capabilities = ["read"] }`,
      }),
      method: 'PUT',
    });
    await rootRequest(`v1/auth/${authMountPath}/role/${roleName}`, {
      body: JSON.stringify({
        policies: [policyName],
        secret_id_ttl: '10m',
        token_max_ttl: '10m',
        token_ttl: '5m',
      }),
      method: 'POST',
    });
    const rolePayload = (await rootRequest(
      `v1/auth/${authMountPath}/role/${roleName}/role-id`,
    )) as { data: { role_id: string } };
    const secretPayload = (await rootRequest(
      `v1/auth/${authMountPath}/role/${roleName}/secret-id`,
      { method: 'POST' },
    )) as { data: { secret_id: string } };
    roleId = rolePayload.data.role_id;
    secretId = secretPayload.data.secret_id;
  }, 30_000);

  afterAll(async () => {
    const cleanup = [
      rootRequest(`v1/sys/auth/${authMountPath}`, { method: 'DELETE' }),
      rootRequest(`v1/sys/mounts/${mountPath}`, { method: 'DELETE' }),
      rootRequest(`v1/sys/policies/acl/${policyName}`, { method: 'DELETE' }),
    ];
    await Promise.allSettled(cleanup);
  });

  it('reads active/history and preserves old ciphertext across rotation', async () => {
    await writeKeySet({ key: oldKey, keyId: 'vault:old' }, []);
    const oldService = new PlatformSecretService({
      keyProvider: new VaultKeyProvider({
        address,
        auth: { authMountPath, method: 'approle', roleId, secretId },
        mountPath,
        secretPath,
      }),
    });
    const oldCiphertext = await oldService.encrypt('before-rotation');
    expect(oldService.peekKeyId(oldCiphertext)).toBe('vault:old');

    await writeKeySet({ key: newKey, keyId: 'vault:new' }, [{ key: oldKey, keyId: 'vault:old' }]);
    const rotatedService = new PlatformSecretService({
      keyProvider: new VaultKeyProvider({
        address,
        auth: { authMountPath, method: 'approle', roleId, secretId },
        mountPath,
        secretPath,
      }),
    });
    await expect(rotatedService.decrypt(oldCiphertext)).resolves.toBe('before-rotation');
    const newCiphertext = await rotatedService.encrypt('after-rotation');
    expect(rotatedService.peekKeyId(newCiphertext)).toBe('vault:new');
    await expect(rotatedService.decrypt(newCiphertext)).resolves.toBe('after-rotation');
  });

  it('runs the internal rewrap worker against the ephemeral Vault key set', async () => {
    await writeKeySet({ key: oldKey, keyId: 'vault:old' }, []);
    const oldService = new PlatformSecretService({
      keyProvider: new VaultKeyProvider({
        address,
        auth: { authMountPath, method: 'approle', roleId, secretId },
        mountPath,
        secretPath,
      }),
    });
    const oldCiphertext = await oldService.encrypt('worker-vault-secret');
    await writeKeySet({ key: newKey, keyId: 'vault:new' }, [{ key: oldKey, keyId: 'vault:old' }]);
    const rewrapService = new PlatformSecretService({
      keyProvider: new VaultKeyProvider({
        address,
        auth: { authMountPath, method: 'approle', roleId, secretId },
        mountPath,
        secretPath,
      }),
    });
    const db = await getTestDB();
    await db.delete(platformJobs);
    await db.delete(platformConnectorSecrets);
    await db.delete(platformConnectors);
    try {
      await db.insert(platformConnectors).values({
        connectorKey: 'vault-worker',
        displayName: 'Vault worker',
        id: 'vault-worker',
        legacyName: 'Vault worker',
        migrationRequired: true,
      });
      await db.insert(platformConnectorSecrets).values({
        ciphertext: oldCiphertext,
        connectorId: 'vault-worker',
        fingerprint: 'a'.repeat(64),
        id: 'vault-worker-secret',
        keyId: 'vault:old',
        ref: 'kms://platform-connectors/vault-worker/shared',
        revision: 1,
        slot: 'sharedSecret',
      });
      const coordinator = new PlatformSecretRewrapCoordinator(rewrapService);
      const job = await coordinator.enqueue(db, {
        reason: 'ephemeral real Vault worker evidence',
        requestId: '44444444-4444-4444-8444-444444444444',
        requestedBy: 'vault-integration',
        targetKeyId: 'vault:new',
      });
      await processNextPlatformSecretRewrapBatch(db, rewrapService, 'vault-integration-worker');
      const [stored] = await db
        .select()
        .from(platformConnectorSecrets)
        .where(eq(platformConnectorSecrets.id, 'vault-worker-secret'));
      expect(rewrapService.peekKeyId(stored.ciphertext)).toBe('vault:new');
      await expect(rewrapService.decrypt(stored.ciphertext)).resolves.toBe('worker-vault-secret');
      await expect(coordinator.get(db, job.jobId)).resolves.toMatchObject({
        status: 'succeeded',
      });
    } finally {
      await db.delete(platformJobs);
      await db.delete(platformConnectorSecrets);
      await db.delete(platformConnectors);
    }
  });
});
