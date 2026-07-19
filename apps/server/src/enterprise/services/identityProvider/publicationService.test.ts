// @vitest-environment node
import { GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE } from '@lobechat/types';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import {
  platformAuditLogs,
  platformIdentityProviders,
  platformIdentityProviderSecrets,
  platformIdentityProviderTestAttempts,
  platformResourceRevisions,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';
import { type KeyProvider, PlatformSecretService } from '@/server/enterprise/security/secret';

import { AdminIdentityProviderService } from './adminService';
import type { IdentityProviderDiscoveryValidator } from './discoveryValidator';
import {
  IdentityProviderPublicationService,
  parsePublishedIdentityProviderPayload,
} from './publicationService';
import { IdentityProviderTestAttemptStore } from './testAttemptStore';

const db: LobeChatDatabase = await getTestDB();
const keyProvider: KeyProvider = {
  getKek: async () => ({ key: new Uint8Array(32).fill(73), keyId: 'test-key' }),
  providerId: 'test',
};
const secrets = new PlatformSecretService({ keyProvider });
const admin = new AdminIdentityProviderService(
  db,
  secrets,
  {} as IdentityProviderDiscoveryValidator,
  'https://app.example.test',
);
const publication = new IdentityProviderPublicationService(db);
const attempts = new IdentityProviderTestAttemptStore(db, secrets);
const requestId = (index: number) =>
  `550e8400-e29b-41d4-a716-${index.toString().padStart(12, '0')}`;

const cleanup = async () => {
  await db.delete(platformIdentityProviderTestAttempts);
  await db.delete(platformIdentityProviderSecrets);
  await db.delete(platformIdentityProviders);
  await db.delete(platformResourceRevisions);
  await db.delete(platformAuditLogs);
};

beforeEach(cleanup);
afterEach(cleanup);

const createDraft = () =>
  admin.create('admin-1', {
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
    secret: { operation: 'replace', value: 'fake-client-secret-for-test' },
    type: 'generic_oidc',
    usePkce: true,
  });

const recordSuccessfulTest = async (providerId: string) => {
  const [provider] = await db
    .select()
    .from(platformIdentityProviders)
    .where(eq(platformIdentityProviders.id, providerId));
  const issued = await attempts.issue({
    auditReason: 'verify exact draft',
    providerId,
    providerRevision: provider.revision,
    providerSecretFingerprint: provider.secretFingerprint!,
    providerSecretRef: provider.secretRef!,
    redirectUri: 'https://app.example.test/oauth/identity-provider/test/callback',
    sessionId: 'session-1',
    userId: 'admin-1',
  });
  await db
    .update(platformIdentityProviderTestAttempts)
    .set({
      completedAt: new Date(),
      result: { claims: { name: 'Ada', sub: 'subject-1' }, issues: [], valid: true },
      status: 'succeeded',
    })
    .where(eq(platformIdentityProviderTestAttempts.id, issued.attemptId));
  return issued.attemptId;
};

describe('IdentityProviderPublicationService', () => {
  it('rejects malformed persisted snapshots at the runtime boundary', () => {
    const valid = {
      autoProvision: true,
      buttonLabel: 'Work login',
      claimMapping: GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE.claimMapping,
      clientId: 'client-id',
      displayName: 'Work login',
      domainAllowlist: [],
      enabled: true,
      groupRoleMapping: {},
      icon: null,
      issuer: 'https://login.example.test',
      providerKey: 'work',
      scopes: [...GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE.scopes],
      secretFingerprint: 'a'.repeat(64),
      type: 'generic_oidc',
      usePkce: true,
    };
    expect(parsePublishedIdentityProviderPayload(valid)).toEqual(valid);
    expect(
      parsePublishedIdentityProviderPayload({ ...valid, domainAllowlist: ['example.test', 42] }),
    ).toBeNull();
    expect(
      parsePublishedIdentityProviderPayload({
        ...valid,
        issuer: 'https://login.example.test:8443',
      }),
    ).toBeNull();
    expect(
      parsePublishedIdentityProviderPayload({ ...valid, scopes: ['openid', 'openid'] }),
    ).toBeNull();
  });

  it('publishes only an exact recently-tested draft and persists no secret material', async () => {
    const draft = await createDraft();
    await recordSuccessfulTest(draft.id);

    const published = await publication.publish('admin-1', {
      expectedRevision: draft.revision,
      id: draft.id,
      reason: 'activate verified work login',
      requestId: requestId(1),
    });
    expect(published).toMatchObject({
      activationRevision: draft.revision + 1,
      enabled: true,
      status: 'pending_restart',
    });
    const [revision] = await db.select().from(platformResourceRevisions);
    expect(revision).toMatchObject({
      resourceId: draft.id,
      resourceType: 'oidc',
      secretFingerprint: draft.secret.fingerprint,
      status: 'published',
    });
    const serialized = JSON.stringify(revision);
    expect(serialized).not.toContain('fake-client-secret-for-test');
    expect(serialized).not.toContain('kms://');
    expect(serialized).not.toContain('ciphertext');
  });

  it('reserves concurrent requests and returns the exact result after completion', async () => {
    const draft = await createDraft();
    await recordSuccessfulTest(draft.id);
    const input = {
      expectedRevision: draft.revision,
      id: draft.id,
      reason: 'idempotent publish',
      requestId: requestId(20),
    };
    const concurrent = await Promise.allSettled([
      publication.publish('admin-1', input),
      publication.publish('admin-1', input),
    ]);
    const first = concurrent.find((result) => result.status === 'fulfilled');
    const pending = concurrent.find((result) => result.status === 'rejected');
    expect(first?.status).toBe('fulfilled');
    expect(pending?.status).toBe('rejected');
    if (first?.status !== 'fulfilled' || pending?.status !== 'rejected') {
      throw new Error('expected one owner and one pending request');
    }
    expect(pending.reason).toMatchObject({
      code: 'PLATFORM_IDENTITY_PROVIDER_REQUEST_PENDING',
    });
    const laterReplay = await publication.publish('admin-1', input);

    expect(laterReplay).toEqual(first.value);
    expect(await db.select().from(platformResourceRevisions)).toHaveLength(1);
    const audits = await db.select().from(platformAuditLogs);
    const publishAudits = audits.filter(
      (audit) => audit.action === 'admin.identityProviders.publish',
    );
    expect(publishAudits.filter((audit) => audit.result === 'success')).toHaveLength(1);
    expect(publishAudits.filter((audit) => audit.result === 'failure')).toHaveLength(0);
    expect(publishAudits[0]?.requestId).toBe(input.requestId);
  });

  it('fails closed when the same publish request ID is reused for a different payload', async () => {
    const draft = await createDraft();
    await recordSuccessfulTest(draft.id);
    const request = requestId(21);
    await publication.publish('admin-1', {
      expectedRevision: draft.revision,
      id: draft.id,
      reason: 'first payload',
      requestId: request,
    });

    await expect(
      publication.publish('admin-1', {
        expectedRevision: draft.revision,
        id: draft.id,
        reason: 'different payload',
        requestId: request,
      }),
    ).rejects.toThrow('PLATFORM_IDENTITY_PROVIDER_IDEMPOTENCY_CONFLICT');
    expect(await db.select().from(platformResourceRevisions)).toHaveLength(1);
  });

  it('durably replays the same failure and rejects a different failed payload', async () => {
    const draft = await createDraft();
    const request = requestId(24);
    const input = {
      expectedRevision: draft.revision,
      id: draft.id,
      reason: 'failure payload A',
      requestId: request,
    };

    await expect(publication.publish('admin-1', input)).rejects.toThrow(
      'PLATFORM_IDENTITY_PROVIDER_NOT_TESTED',
    );
    await expect(publication.publish('admin-1', input)).rejects.toThrow(
      'PLATFORM_IDENTITY_PROVIDER_NOT_TESTED',
    );
    await expect(
      publication.publish('admin-1', { ...input, reason: 'failure payload B' }),
    ).rejects.toThrow('PLATFORM_IDENTITY_PROVIDER_IDEMPOTENCY_CONFLICT');

    const audits = await db.select().from(platformAuditLogs);
    expect(
      audits.filter(
        (audit) => audit.action === 'admin.identityProviders.publish' && audit.result === 'failure',
      ),
    ).toHaveLength(1);
    expect(
      audits.filter((audit) => audit.action === 'admin.identityProviders.publish.requestReserved'),
    ).toHaveLength(1);
  });

  it('rejects missing, stale, or mismatched tests without changing the provider pointer', async () => {
    const draft = await createDraft();
    await expect(
      publication.publish('admin-1', {
        expectedRevision: draft.revision,
        id: draft.id,
        reason: 'must have exact test',
        requestId: requestId(2),
      }),
    ).rejects.toThrow('PLATFORM_IDENTITY_PROVIDER_NOT_TESTED');
    const [unchanged] = await db.select().from(platformIdentityProviders);
    expect(unchanged).toMatchObject({ revision: draft.revision, status: 'draft' });
    expect(await db.select().from(platformResourceRevisions)).toHaveLength(0);
    expect(await db.select().from(platformAuditLogs)).toContainEqual(
      expect.objectContaining({ action: 'admin.identityProviders.publish', result: 'failure' }),
    );
  });

  it.each([
    ['an invalid preview', { result: { claims: {}, issues: [], valid: false } }],
    [
      'an expired attempt',
      {
        createdAt: new Date(Date.now() - 10 * 60_000),
        expiresAt: new Date(Date.now() - 5 * 60_000),
      },
    ],
    ['a future completion', { completedAt: new Date(Date.now() + 60_000) }],
    ['an old completion', { completedAt: new Date(Date.now() - 11 * 60_000) }],
  ])('rejects %s even when the attempt row says succeeded', async (_label, mutation) => {
    const draft = await createDraft();
    const attemptId = await recordSuccessfulTest(draft.id);
    await db
      .update(platformIdentityProviderTestAttempts)
      .set(mutation)
      .where(eq(platformIdentityProviderTestAttempts.id, attemptId));

    await expect(
      publication.publish('admin-1', {
        expectedRevision: draft.revision,
        id: draft.id,
        reason: 'reject invalid test evidence',
        requestId: requestId(3),
      }),
    ).rejects.toThrow('PLATFORM_IDENTITY_PROVIDER_NOT_TESTED');
  });

  it('restores a historical version as a new draft and forces a fresh test before republish', async () => {
    const draft = await createDraft();
    await recordSuccessfulTest(draft.id);
    const published = await publication.publish('admin-1', {
      expectedRevision: draft.revision,
      id: draft.id,
      reason: 'publish first version',
      requestId: requestId(4),
    });

    const restored = await publication.rollback('admin-1', {
      expectedRevision: published.revision,
      id: draft.id,
      reason: 'restore first version for verification',
      requestId: requestId(5),
      targetRevision: published.revision,
    });
    expect(restored).toMatchObject({
      activationRevision: null,
      revision: published.revision + 1,
      status: 'draft',
    });
    expect(restored.secret.fingerprint).toBe(draft.secret.fingerprint);
    await expect(
      admin.delete('admin-1', {
        expectedRevision: restored.revision,
        id: restored.id,
        reason: 'must not remove the published login path',
      }),
    ).rejects.toThrow('PLATFORM_IDENTITY_PROVIDER_HAS_PUBLISHED_REVISION');
    expect(await db.select().from(platformIdentityProviderSecrets)).toHaveLength(1);
    await expect(
      publication.publish('admin-1', {
        expectedRevision: restored.revision,
        id: restored.id,
        reason: 'cannot skip retest after rollback',
        requestId: requestId(6),
      }),
    ).rejects.toThrow('PLATFORM_IDENTITY_PROVIDER_NOT_TESTED');
  });

  it('returns the original rollback result for an exact request retry', async () => {
    const draft = await createDraft();
    await recordSuccessfulTest(draft.id);
    const published = await publication.publish('admin-1', {
      expectedRevision: draft.revision,
      id: draft.id,
      reason: 'publish for rollback replay',
      requestId: requestId(22),
    });
    const input = {
      expectedRevision: published.revision,
      id: draft.id,
      reason: 'idempotent rollback',
      requestId: requestId(23),
      targetRevision: published.revision,
    };
    const first = await publication.rollback('admin-1', input);
    const replay = await publication.rollback('admin-1', input);

    expect(replay).toEqual(first);
    const rollbackAudits = (await db.select().from(platformAuditLogs)).filter(
      (audit) => audit.action === 'admin.identityProviders.rollback',
    );
    expect(rollbackAudits).toHaveLength(1);
    expect(rollbackAudits[0]?.requestId).toBe(input.requestId);
  });

  it.each([
    ['checksum', { checksum: 'f'.repeat(64) }],
    ['revision secret fingerprint', { secretFingerprint: 'f'.repeat(64) }],
  ])('rejects rollback from a revision with a tampered %s', async (_label, mutation) => {
    const draft = await createDraft();
    await recordSuccessfulTest(draft.id);
    const published = await publication.publish('admin-1', {
      expectedRevision: draft.revision,
      id: draft.id,
      reason: 'publish first version',
      requestId: requestId(7),
    });
    await db
      .update(platformResourceRevisions)
      .set(mutation)
      .where(eq(platformResourceRevisions.resourceId, draft.id));

    await expect(
      publication.rollback('admin-1', {
        expectedRevision: published.revision,
        id: draft.id,
        reason: 'must verify historical integrity',
        requestId: requestId(8),
        targetRevision: published.revision,
      }),
    ).rejects.toThrow('PLATFORM_IDENTITY_PROVIDER_INVALID_SNAPSHOT');
  });
});
