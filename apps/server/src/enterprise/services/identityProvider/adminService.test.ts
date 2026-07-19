// @vitest-environment node
import { GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE } from '@lobechat/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import {
  platformAuditLogs,
  platformIdentityProviders,
  platformIdentityProviderSecrets,
  platformIdentityProviderTestAttempts,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';
import { type KeyProvider, PlatformSecretService } from '@/server/enterprise/security/secret';

import { AdminIdentityProviderService } from './adminService';
import type { IdentityProviderDiscoveryValidator } from './discoveryValidator';

const db: LobeChatDatabase = await getTestDB();
const keyProvider: KeyProvider = {
  getKek: async () => ({ key: new Uint8Array(32).fill(41), keyId: 'test-key' }),
  providerId: 'test',
};
const discover = vi.fn();
const validateNetwork = vi.fn();
const service = new AdminIdentityProviderService(
  db,
  new PlatformSecretService({ keyProvider }),
  { discover, validateNetwork } as unknown as IdentityProviderDiscoveryValidator,
  'https://app.example.test/base',
);

const cleanup = async () => {
  await db.delete(platformIdentityProviderTestAttempts);
  await db.delete(platformIdentityProviderSecrets);
  await db.delete(platformIdentityProviders);
  await db.delete(platformAuditLogs);
};

beforeEach(cleanup);
afterEach(cleanup);

const draftInput = (secret: { operation: 'clear' } | { operation: 'replace'; value: string }) => ({
  autoProvision: true,
  buttonLabel: 'Sign in with work',
  claimMapping: GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE.claimMapping,
  clientId: 'client-id',
  displayName: 'Work login',
  domainAllowlist: [],
  groupRoleMapping: {},
  icon: null,
  issuer: 'https://login.example.test',
  providerKey: 'work',
  reason: 'configure work login',
  scopes: [...GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE.scopes],
  secret,
  type: 'generic_oidc' as const,
  usePkce: true as const,
});

describe('AdminIdentityProviderService', () => {
  it('creates and lists a secret-safe draft with transactional audit', async () => {
    const plaintext = 'client-secret-value';
    const created = await service.create(
      'admin-1',
      draftInput({ operation: 'replace', value: plaintext }),
    );
    expect(created).toMatchObject({
      providerKey: 'work',
      revision: 1,
      secret: { configured: true, updatedAt: expect.any(Date) },
    });
    expect(JSON.stringify(created)).not.toMatch(new RegExp(`${plaintext}|fingerprint|digest`));
    const [secret] = await db.select().from(platformIdentityProviderSecrets);
    expect(secret.ciphertext).toMatch(/^aihub\.secret\.v1\./);
    expect(secret.ciphertext).not.toContain(plaintext);
    const listed = await service.list({ limit: 50 });
    expect(listed).toMatchObject({
      items: [{ id: created.id, providerKey: 'work' }],
      nextCursor: null,
    });
    expect(JSON.stringify(listed)).not.toMatch(/fingerprint|digest|[a-f0-9]{64}/i);
    expect(JSON.stringify(await service.get(created.id))).not.toMatch(/fingerprint|digest/i);
    expect(await db.select().from(platformAuditLogs)).toContainEqual(
      expect.objectContaining({ action: 'admin.identityProviders.create', result: 'success' }),
    );
  });

  it('uses revision CAS for public and secret updates, then deletes draft-only data', async () => {
    const created = await service.create('admin-1', draftInput({ operation: 'clear' }));
    expect(created.secret).toEqual({ configured: false, updatedAt: null });
    const updated = await service.update('admin-2', {
      ...draftInput({ operation: 'clear' }),
      displayName: 'Updated work login',
      expectedRevision: created.revision,
      id: created.id,
      secret: { operation: 'keep' },
    });
    expect(updated).toMatchObject({ displayName: 'Updated work login', revision: 1 });
    expect(JSON.stringify(updated)).not.toMatch(/fingerprint|digest/i);
    await expect(
      service.update('admin-2', {
        ...draftInput({ operation: 'clear' }),
        expectedRevision: 0,
        id: created.id,
        secret: { operation: 'keep' },
      }),
    ).rejects.toThrow('PLATFORM_REVISION_CONFLICT');
    await expect(
      service.delete('admin-2', {
        expectedRevision: updated.revision,
        id: created.id,
        reason: 'remove unused draft',
      }),
    ).resolves.toEqual({ deleted: true });
    await expect(service.get(created.id)).rejects.toThrow('PLATFORM_IDENTITY_PROVIDER_NOT_FOUND');
    const failureAudits = (await db.select().from(platformAuditLogs)).filter(
      ({ action, result }) => action === 'admin.identityProviders.update' && result === 'failure',
    );
    expect(failureAudits).toContainEqual(
      expect.objectContaining({
        afterDiff: { category: 'revision_conflict' },
        reason: 'configure work login',
      }),
    );
    expect(JSON.stringify(failureAudits)).not.toMatch(/client-secret|not-returned|ciphertext/);
  });

  it('lists 100 safe drafts with one query and stable cursor pagination', async () => {
    await db.insert(platformIdentityProviders).values(
      Array.from({ length: 101 }, (_, index) => ({
        displayName: `Provider ${index.toString().padStart(3, '0')}`,
        providerKey: `provider-${index.toString().padStart(3, '0')}`,
      })),
    );
    const select = vi.spyOn(db, 'select');
    const first = await service.list({ limit: 100 });
    expect(select).toHaveBeenCalledTimes(1);
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).toBe('provider-099');
    select.mockClear();
    await expect(service.list({ cursor: first.nextCursor!, limit: 100 })).resolves.toMatchObject({
      items: [{ providerKey: 'provider-100' }],
      nextCursor: null,
    });
    expect(select).toHaveBeenCalledTimes(1);
    select.mockRestore();
  });

  it('exposes canonical callback URLs and delegates public-only discovery checks', async () => {
    discover.mockResolvedValueOnce({ issuer: 'https://login.example.test' });
    await expect(service.discoverIssuer('https://login.example.test')).resolves.toEqual({
      issuer: 'https://login.example.test',
    });
    await expect(service.validateNetwork('https://login.example.test')).resolves.toEqual({
      valid: true,
    });
    expect(validateNetwork).toHaveBeenCalledWith('https://login.example.test');
    expect(service.getCallbackUrls()).toEqual({
      production: 'https://app.example.test/api/auth/oauth2/callback/{providerKey}',
      test: 'https://app.example.test/oauth/identity-provider/test/callback',
    });
  });
});
