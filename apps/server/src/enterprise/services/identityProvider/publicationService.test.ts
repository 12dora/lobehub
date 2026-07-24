// @vitest-environment node
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE } from '@lobechat/types';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { checksumPayload, PlatformRevisionConflictError } from '@/database/models/platform';
import {
  platformAuditLogs,
  platformIdentityProviders,
  platformIdentityProviderSecrets,
  platformIdentityProviderTestAttempts,
  platformResourceRevisions,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';
import { type KeyProvider, PlatformSecretService } from '@/server/enterprise/security/secret';

import type { EnterpriseObservabilityEvent } from '../../observability';
import { setEnterprisePlatformObserverForTest } from '../../observability';
import { AdminIdentityProviderService } from './adminService';
import type { IdentityProviderDiscoveryValidator } from './discoveryValidator';
import {
  IdentityProviderPublicationService,
  parsePublishedIdentityProviderPayload,
} from './publicationService';
import { IdentityProviderSecretStore } from './secretStore';
import {
  loadIdentityProviderStartupSnapshot,
  resetIdentityProviderStartupSnapshotForTest,
} from './startupSnapshot';
import { IdentityProviderTestAttemptStore } from './testAttemptStore';

const db: LobeChatDatabase = await getTestDB();
const runPostgres = process.env.TEST_SERVER_DB === '1' && Boolean(process.env.DATABASE_TEST_URL);
const directories: string[] = [];
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
const observed: EnterpriseObservabilityEvent[] = [];
const publishEvents = () => observed.filter((event) => event.type === 'config_publish');
const requestId = (index: number) =>
  `550e8400-e29b-41d4-a716-${index.toString().padStart(12, '0')}`;

type AuditResponseMutation = (response: Record<string, unknown>) => Record<string, unknown>;

const findTerminalAudit = async (idempotencyRequestId: string) => {
  const terminal = (await db.select().from(platformAuditLogs)).find(
    (audit) =>
      audit.requestId === idempotencyRequestId &&
      audit.result === 'success' &&
      typeof (audit.afterDiff as Record<string, unknown> | null)?.response === 'object',
  );
  if (!terminal?.afterDiff || typeof terminal.afterDiff !== 'object') {
    throw new Error('terminal audit is required');
  }
  return terminal;
};

const tamperTerminalAfterDiff = async (
  idempotencyRequestId: string,
  mutation: (afterDiff: Record<string, unknown>) => Record<string, unknown>,
) => {
  const terminal = await findTerminalAudit(idempotencyRequestId);
  const afterDiff = terminal.afterDiff as Record<string, unknown>;
  // Append-only audit: tests deliberately corrupt terminal payloads to assert fail-closed replay.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    await tx
      .update(platformAuditLogs)
      .set({ afterDiff: mutation(afterDiff) })
      .where(eq(platformAuditLogs.id, terminal.id));
  });
};

const tamperPublishedRevision = async (resourceId: string, mutation: Record<string, unknown>) => {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    await tx
      .update(platformResourceRevisions)
      .set(mutation)
      .where(eq(platformResourceRevisions.resourceId, resourceId));
  });
};

const tamperTerminalResponse = async (
  idempotencyRequestId: string,
  mutation: AuditResponseMutation,
) =>
  tamperTerminalAfterDiff(idempotencyRequestId, (afterDiff) => {
    if (!afterDiff.response || typeof afterDiff.response !== 'object') {
      throw new Error('terminal response is required');
    }
    return {
      ...afterDiff,
      response: mutation(afterDiff.response as Record<string, unknown>),
    };
  });

const cleanup = async () => {
  resetIdentityProviderStartupSnapshotForTest();
  // Immutable published revisions + append-only audit require trigger bypass for fixtures.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    await tx.delete(platformIdentityProviderTestAttempts);
    await tx.delete(platformIdentityProviderSecrets);
    await tx.delete(platformIdentityProviders);
    await tx.delete(platformResourceRevisions);
    await tx.delete(platformAuditLogs);
  });
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
};

beforeEach(async () => {
  await cleanup();
  observed.length = 0;
  setEnterprisePlatformObserverForTest({ record: (event) => observed.push(event) });
});
afterEach(async () => {
  setEnterprisePlatformObserverForTest(null);
  vi.useRealTimers();
  await cleanup();
});

const createDraft = (providerKey = 'work') =>
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
    providerKey,
    reason: 'configure work login',
    scopes: [...GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE.scopes],
    secret: { operation: 'replace', value: 'fake-client-secret-for-test' },
    type: 'generic_oidc',
    usePkce: true,
  });

const startupEnv = async () => {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'aihub-oidc-publish-lock-'));
  directories.push(directory);
  return {
    AUTH_SSO_PROVIDERS: '',
    ENABLE_DATABASE_OIDC: '1',
    PLATFORM_MASTER_KEY: Buffer.from(new Uint8Array(32).fill(73)).toString('base64'),
    PLATFORM_MASTER_KEY_ID: 'test-key',
    PLATFORM_OIDC_LKG_PATH: path.join(directory, 'snapshot.json'),
  };
};

const discovery = {
  discover: async (issuer: string) => ({
    authorizationEndpoint: 'https://login.example.test/authorize',
    authorizationResponseIssParameterSupported: false,
    codeChallengeMethodsSupported: ['S256'],
    idTokenSigningAlgValuesSupported: ['RS256'],
    issuer,
    jwksUri: 'https://login.example.test/jwks',
    responseTypesSupported: ['code'],
    scopesSupported: ['openid', 'profile', 'email'],
    subjectTypesSupported: ['public'],
    tokenEndpoint: 'https://login.example.test/token',
    tokenEndpointAuthMethodsSupported: ['client_secret_basic'],
    userinfoEndpoint: 'https://login.example.test/userinfo',
  }),
};

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
      secretUpdatedAt: '2026-07-19T00:00:00.000Z',
      type: 'generic_oidc',
      usePkce: true,
    };
    expect(parsePublishedIdentityProviderPayload(valid)).toEqual(valid);
    const { secretUpdatedAt: _secretUpdatedAt, ...legacy } = valid;
    expect(parsePublishedIdentityProviderPayload(legacy)).toEqual({
      ...legacy,
      secretUpdatedAt: undefined,
    });
    expect(
      parsePublishedIdentityProviderPayload({
        ...valid,
        secretUpdatedAt: '2026-07-19T00:00:00Z',
      }),
    ).toBeNull();
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

  it('publishes a signed tombstone and excludes the provider from startup selection', async () => {
    const draft = await createDraft();
    await recordSuccessfulTest(draft.id);
    const published = await publication.publish('admin-1', {
      expectedRevision: draft.revision,
      id: draft.id,
      reason: 'activate before revoke',
      requestId: requestId(90),
    });
    const disabled = await publication.disable('admin-1', {
      expectedRevision: published.revision,
      id: draft.id,
      reason: 'compromise revoke',
    });
    // Tombstone is a pending activation until every fresh instance reloads.
    expect(disabled).toMatchObject({
      activationRevision: published.revision + 1,
      enabled: false,
      status: 'pending_restart',
    });
    const revisions = await db.select().from(platformResourceRevisions);
    expect(revisions.some((row) => (row.payload as { enabled?: boolean }).enabled === false)).toBe(
      true,
    );
    const selection = await (
      await import('./startupSnapshot')
    ).loadPublishedIdentityProviderSelection({
      db,
      environmentProviderIds: new Set(),
    });
    expect(selection.selected).toHaveLength(0);
    expect(selection.tombstoneGenerations.length).toBeGreaterThan(0);
  });

  it('tombstones after edit even when head is draft with activationRevision=null', async () => {
    const draft = await createDraft();
    await recordSuccessfulTest(draft.id);
    const published = await publication.publish('admin-1', {
      expectedRevision: draft.revision,
      id: draft.id,
      reason: 'activate before edit-then-revoke',
      requestId: requestId(91),
    });
    const edited = await admin.update('admin-1', {
      autoProvision: true,
      buttonLabel: 'Sign in with work',
      claimMapping: GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE.claimMapping,
      clientId: 'client-id',
      displayName: 'Work login (edited)',
      domainAllowlist: [],
      expectedRevision: published.revision,
      groupRoleMapping: {},
      icon: null,
      id: draft.id,
      issuer: 'https://login.example.test',
      providerKey: 'work',
      reason: 'edit after publish forks to draft',
      scopes: [...GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE.scopes],
      secret: { operation: 'keep' },
      type: 'generic_oidc',
      usePkce: true,
    });
    expect(edited).toMatchObject({
      activationRevision: null,
      status: 'draft',
    });
    // Critical C3: disable must use published revision history, not draft head state.
    const disabled = await publication.disable('admin-1', {
      expectedRevision: edited.revision,
      id: draft.id,
      reason: 'revoke after edit',
    });
    expect(disabled).toMatchObject({
      activationRevision: edited.revision + 1,
      enabled: false,
      status: 'pending_restart',
    });
    const selection = await (
      await import('./startupSnapshot')
    ).loadPublishedIdentityProviderSelection({
      db,
      environmentProviderIds: new Set(),
    });
    expect(selection.selected).toHaveLength(0);
    expect(selection.tombstoneGenerations.length).toBeGreaterThan(0);
  });

  it('tombstones after secret-clear without requiring a current draft secret', async () => {
    const draft = await createDraft();
    await recordSuccessfulTest(draft.id);
    const published = await publication.publish('admin-1', {
      expectedRevision: draft.revision,
      id: draft.id,
      reason: 'activate before secret-clear revoke',
      requestId: requestId(92),
    });
    const cleared = await admin.update('admin-1', {
      autoProvision: true,
      buttonLabel: 'Sign in with work',
      claimMapping: GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE.claimMapping,
      clientId: 'client-id',
      displayName: 'Work login',
      domainAllowlist: [],
      expectedRevision: published.revision,
      groupRoleMapping: {},
      icon: null,
      id: draft.id,
      issuer: 'https://login.example.test',
      providerKey: 'work',
      reason: 'clear secret after publish',
      scopes: [...GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE.scopes],
      secret: { operation: 'clear' },
      type: 'generic_oidc',
      usePkce: true,
    });
    expect(cleared).toMatchObject({
      activationRevision: null,
      secret: { configured: false, updatedAt: null },
      status: 'draft',
    });
    const disabled = await publication.disable('admin-1', {
      expectedRevision: cleared.revision,
      id: draft.id,
      reason: 'revoke after secret clear',
    });
    expect(disabled).toMatchObject({
      activationRevision: cleared.revision + 1,
      enabled: false,
      status: 'pending_restart',
    });
    const tombstones = (await db.select().from(platformResourceRevisions)).filter(
      (row) => (row.payload as { enabled?: boolean }).enabled === false,
    );
    expect(tombstones.length).toBeGreaterThan(0);
    // Tombstone reuses published secret fingerprint, not the cleared draft.
    expect(tombstones.at(-1)?.secretFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('outage LKG does not resurrect a provider tombstoned after edit', async () => {
    // Mixed-provider case: A is tombstoned, B's secret is missing so live
    // materialization fails. LKG still has A+B; validated tombstones from the
    // DB selection must strip A even though the healthy path never re-wrote LKG.
    const draftA = await createDraft('work');
    await recordSuccessfulTest(draftA.id);
    const publishedA = await publication.publish('admin-1', {
      expectedRevision: draftA.revision,
      id: draftA.id,
      reason: 'activate A for lkg outage tombstone',
      requestId: requestId(93),
    });
    const draftB = await createDraft('partner');
    await recordSuccessfulTest(draftB.id);
    await publication.publish('admin-1', {
      expectedRevision: draftB.revision,
      id: draftB.id,
      reason: 'activate B for lkg outage tombstone',
      requestId: requestId(94),
    });
    const env = await startupEnv();
    const liveStartup = await loadIdentityProviderStartupSnapshot({
      cache: false,
      db,
      discovery,
      env,
    });
    expect(liveStartup.source).toBe('database');
    expect(liveStartup.databaseProviders.map((p) => p.providerKey).sort()).toEqual([
      'partner',
      'work',
    ]);

    // Tombstone A without a post-disable healthy load (immediate-outage window).
    await publication.disable('admin-1', {
      expectedRevision: publishedA.revision,
      id: draftA.id,
      reason: 'signed revoke of A',
    });
    // Corrupt B so live materialization fails after selection sees A's tombstone.
    await db
      .delete(platformIdentityProviderSecrets)
      .where(eq(platformIdentityProviderSecrets.providerId, draftB.id));

    const outageStartup = await loadIdentityProviderStartupSnapshot({
      cache: false,
      db,
      discovery,
      env,
    });
    expect(outageStartup.source).toBe('lkg');
    // A must not be resurrected from pre-tombstone LKG; B may be absent because
    // its secret is gone (LKG still holds B's ciphertext — it remains loadable).
    expect(outageStartup.databaseProviders.map((p) => p.providerKey)).not.toContain('work');
    expect(outageStartup.providerIds).not.toContain('work');
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
    const [provider] = await db
      .select({ fingerprint: platformIdentityProviders.secretFingerprint })
      .from(platformIdentityProviders)
      .where(eq(platformIdentityProviders.id, draft.id));
    expect(revision).toMatchObject({
      resourceId: draft.id,
      resourceType: 'oidc',
      secretFingerprint: provider.fingerprint,
      status: 'published',
    });
    const serialized = JSON.stringify(revision);
    expect(serialized).not.toContain('fake-client-secret-for-test');
    expect(serialized).not.toContain('kms://');
    expect(serialized).not.toContain('ciphertext');
    expect(publishEvents()).toEqual([
      {
        domain: 'identity',
        durationMs: expect.any(Number),
        operation: 'publish',
        outcome: 'success',
        type: 'config_publish',
      },
    ]);
    expect(Object.keys(publishEvents()[0]!).sort()).toEqual([
      'domain',
      'durationMs',
      'operation',
      'outcome',
      'type',
    ]);
    expect(JSON.stringify(publishEvents())).not.toContain(draft.id);
    expect(JSON.stringify(publishEvents())).not.toContain(requestId(1));
    expect(JSON.stringify(publishEvents())).not.toContain('activate verified work login');
  });

  it('keeps a committed pending-restart publication successful when the observer throws', async () => {
    const draft = await createDraft();
    await recordSuccessfulTest(draft.id);
    const input = {
      expectedRevision: draft.revision,
      id: draft.id,
      reason: 'observer isolation publication',
      requestId: requestId(58),
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setEnterprisePlatformObserverForTest({
      record: () => {
        throw new Error('observer unavailable');
      },
    });

    const published = await publication.publish('admin-1', input);

    expect(published).toMatchObject({ status: 'pending_restart' });
    await expect(publication.publish('admin-1', input)).resolves.toEqual(published);
    const [provider] = await db.select().from(platformIdentityProviders);
    expect(provider).toMatchObject({ revision: published.revision, status: 'pending_restart' });
    expect(consoleError).toHaveBeenCalledWith(
      '[enterprise-observability] metric sink failed',
      expect.objectContaining({ errorClass: 'UnexpectedError' }),
    );
  });

  it('acquires the OIDC published-revision lock before the provider row lock', async () => {
    const draft = await createDraft();
    await recordSuccessfulTest(draft.id);
    const order: string[] = [];
    const lockedPublication = new IdentityProviderPublicationService(db, {
      afterDraftLock: async () => {
        order.push('draft');
      },
      afterPublishedRevisionLock: async () => {
        order.push('published-revision');
      },
    });

    await lockedPublication.publish('admin-1', {
      expectedRevision: draft.revision,
      id: draft.id,
      reason: 'verify canonical lock order',
      requestId: requestId(56),
    });

    expect(order).toEqual(['published-revision', 'draft']);
  });

  it.runIf(runPostgres)(
    'blocks a real concurrent publish between startup recheck and LKG write',
    async () => {
      const draft = await createDraft();
      await recordSuccessfulTest(draft.id);
      const firstPublished = await publication.publish('admin-1', {
        expectedRevision: draft.revision,
        id: draft.id,
        reason: 'publish baseline for startup race',
        requestId: requestId(57),
      });
      const nextDraft = await admin.update('admin-1', {
        autoProvision: true,
        buttonLabel: 'Sign in with updated work',
        claimMapping: GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE.claimMapping,
        clientId: 'client-id',
        displayName: 'Updated work login',
        domainAllowlist: [],
        expectedRevision: firstPublished.revision,
        groupRoleMapping: {},
        icon: null,
        id: draft.id,
        issuer: 'https://login.example.test',
        providerKey: 'work',
        reason: 'prepare second publication',
        scopes: [...GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE.scopes],
        secret: { operation: 'keep' },
        type: 'generic_oidc',
        usePkce: true,
      });
      await recordSuccessfulTest(nextDraft.id);
      const env = await startupEnv();
      let signalStartupLocked = (): void => undefined;
      const startupLocked = new Promise<void>((resolve) => {
        signalStartupLocked = resolve;
      });
      let releaseStartup = (): void => undefined;
      const startupReleased = new Promise<void>((resolve) => {
        releaseStartup = resolve;
      });
      const startup = loadIdentityProviderStartupSnapshot({
        cache: false,
        db,
        discovery,
        env,
        testHooks: {
          afterCanonicalRecheck: async () => {
            signalStartupLocked();
            await startupReleased;
          },
        },
      });
      await startupLocked;

      let publishEnteredLockedTransaction = false;
      let publishSettled = false;
      const concurrentPublication = new IdentityProviderPublicationService(db, {
        afterPublishedRevisionLock: async () => {
          publishEnteredLockedTransaction = true;
        },
      });
      const publish = concurrentPublication
        .publish('admin-1', {
          expectedRevision: nextDraft.revision,
          id: nextDraft.id,
          reason: 'publish only after startup releases canonical lock',
          requestId: requestId(58),
        })
        .finally(() => {
          publishSettled = true;
        });
      try {
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(publishEnteredLockedTransaction).toBe(false);
        expect(publishSettled).toBe(false);
      } finally {
        releaseStartup();
      }
      const firstStartup = await startup;
      const secondPublished = await publish;
      expect(publishEnteredLockedTransaction).toBe(true);
      expect(firstStartup).toMatchObject({ source: 'database' });
      expect(secondPublished.revision).toBe(nextDraft.revision + 1);

      const secondStartup = await loadIdentityProviderStartupSnapshot({
        cache: false,
        db,
        discovery,
        env,
      });
      expect(secondStartup).toMatchObject({ source: 'database' });
      expect(secondStartup.identityRevision).not.toBe(firstStartup.identityRevision);
      expect(secondStartup.databaseProviders[0]?.displayName).toBe('Updated work login');
    },
    15_000,
  );

  it('replays publish and rollback with the immutable timestamp after storing the same secret again', async () => {
    const draft = await createDraft();
    const [initialSecret] = await db
      .select()
      .from(platformIdentityProviderSecrets)
      .where(eq(platformIdentityProviderSecrets.providerId, draft.id));
    const [initialProvider] = await db
      .select()
      .from(platformIdentityProviders)
      .where(eq(platformIdentityProviders.id, draft.id));
    const secondUpdatedAt = new Date(initialProvider.secretUpdatedAt!.getTime() + 5000);
    vi.useFakeTimers();
    vi.setSystemTime(secondUpdatedAt);
    const stored = await new IdentityProviderSecretStore(db, secrets).persistClientSecret({
      expectedRevision: draft.revision,
      providerId: draft.id,
      value: 'fake-client-secret-for-test',
    });
    vi.useRealTimers();
    const [sameSecret] = await db
      .select()
      .from(platformIdentityProviderSecrets)
      .where(eq(platformIdentityProviderSecrets.providerId, draft.id));
    const [updatedProvider] = await db
      .select()
      .from(platformIdentityProviders)
      .where(eq(platformIdentityProviders.id, draft.id));
    expect(sameSecret.id).toBe(initialSecret.id);
    expect(sameSecret.createdAt).toEqual(initialSecret.createdAt);
    expect(updatedProvider.secretUpdatedAt).toEqual(secondUpdatedAt);
    expect(stored.updatedAt).toEqual(secondUpdatedAt);

    await recordSuccessfulTest(draft.id);
    const publishInput = {
      expectedRevision: stored.revision,
      id: draft.id,
      reason: 'publish same-secret timestamp',
      requestId: requestId(52),
    };
    const published = await publication.publish('admin-1', publishInput);
    const [revision] = await db.select().from(platformResourceRevisions);
    expect((revision.payload as Record<string, unknown>).secretUpdatedAt).toBe(
      secondUpdatedAt.toISOString(),
    );
    await tamperTerminalResponse(publishInput.requestId, (response) => {
      const { secretUpdatedAt, ...legacy } = response;
      return {
        ...legacy,
        fingerprint: sameSecret.fingerprint,
        fingerprintUpdatedAt: secretUpdatedAt,
      };
    });
    await db
      .update(platformIdentityProviders)
      .set({ displayName: 'Mutable after publish' })
      .where(eq(platformIdentityProviders.id, draft.id));
    const publishReplay = await publication.publish('admin-1', publishInput);
    expect(publishReplay).toEqual(published);
    expect(publishReplay.secret.updatedAt).toEqual(secondUpdatedAt);

    const rollbackInput = {
      expectedRevision: published.revision,
      id: draft.id,
      reason: 'rollback same-secret timestamp',
      requestId: requestId(53),
      targetRevision: published.revision,
    };
    const restored = await publication.rollback('admin-1', rollbackInput);
    expect(restored.secret.updatedAt).toEqual(secondUpdatedAt);
    await tamperTerminalResponse(rollbackInput.requestId, (response) => {
      const { secretUpdatedAt, ...legacy } = response;
      return {
        ...legacy,
        fingerprint: sameSecret.fingerprint,
        fingerprintUpdatedAt: secretUpdatedAt,
      };
    });
    await db
      .update(platformIdentityProviders)
      .set({ displayName: 'Mutable after rollback', revision: restored.revision + 1 })
      .where(eq(platformIdentityProviders.id, draft.id));
    const rollbackReplay = await publication.rollback('admin-1', rollbackInput);
    expect(rollbackReplay).toEqual(restored);
    expect(rollbackReplay.secret.updatedAt).toEqual(secondUpdatedAt);
  });

  it('rolls back and replays a legacy revision using private secret creation time', async () => {
    const draft = await createDraft();
    await recordSuccessfulTest(draft.id);
    const published = await publication.publish('admin-1', {
      expectedRevision: draft.revision,
      id: draft.id,
      reason: 'publish before legacy upgrade',
      requestId: requestId(54),
    });
    const [revision] = await db.select().from(platformResourceRevisions);
    const { secretUpdatedAt: _secretUpdatedAt, ...legacyPayload } = revision.payload as Record<
      string,
      unknown
    >;
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx
        .update(platformResourceRevisions)
        .set({ checksum: checksumPayload(legacyPayload), payload: legacyPayload })
        .where(eq(platformResourceRevisions.id, revision.id));
    });
    const [secret] = await db
      .select()
      .from(platformIdentityProviderSecrets)
      .where(eq(platformIdentityProviderSecrets.providerId, draft.id));
    const input = {
      expectedRevision: published.revision,
      id: draft.id,
      reason: 'rollback legacy revision',
      requestId: requestId(55),
      targetRevision: published.revision,
    };
    const restored = await publication.rollback('admin-1', input);
    expect(restored.secret.updatedAt).toEqual(secret.createdAt);
    await tamperTerminalResponse(input.requestId, (response) => {
      const { secretUpdatedAt, ...legacy } = response;
      return {
        ...legacy,
        fingerprint: secret.fingerprint,
        fingerprintUpdatedAt: secretUpdatedAt,
      };
    });
    await db
      .update(platformIdentityProviders)
      .set({ displayName: 'Mutable legacy rollback', revision: restored.revision + 1 })
      .where(eq(platformIdentityProviders.id, draft.id));

    const replay = await publication.rollback('admin-1', input);
    expect(replay).toEqual(restored);
    expect(replay.secret.updatedAt).toEqual(secret.createdAt);
  });

  it('returns one exact result for concurrent requests with a single revision and terminal', async () => {
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
    const fulfilled = concurrent.filter((result) => result.status === 'fulfilled');
    const rejected = concurrent.filter((result) => result.status === 'rejected');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    expect(fulfilled).toHaveLength(2 - rejected.length);
    for (const result of rejected) {
      expect(result.reason).toMatchObject({
        code: 'PLATFORM_IDENTITY_PROVIDER_REQUEST_PENDING',
      });
    }
    const first = fulfilled[0]!;
    for (const result of fulfilled) expect(result.value).toEqual(first.value);
    await db
      .update(platformIdentityProviders)
      .set({ displayName: 'Later mutable draft', revision: draft.revision + 2, status: 'draft' })
      .where(eq(platformIdentityProviders.id, draft.id));
    const laterReplay = await publication.publish('admin-1', input);

    expect(laterReplay).toEqual(first.value);
    const revisions = await db.select().from(platformResourceRevisions);
    expect(revisions).toHaveLength(1);
    const audits = await db.select().from(platformAuditLogs);
    const publishAudits = audits.filter(
      (audit) => audit.action === 'admin.identityProviders.publish',
    );
    expect(publishAudits.filter((audit) => audit.result === 'success')).toHaveLength(1);
    expect(publishAudits.filter((audit) => audit.result === 'failure')).toHaveLength(0);
    expect(publishAudits[0]?.requestId).toBe(input.requestId);
    expect(JSON.stringify(publishAudits[0])).not.toContain(revisions[0]!.secretFingerprint!);
    expect(JSON.stringify(publishAudits[0])).not.toMatch(/fingerprint/i);
    expect(publishEvents()).toEqual([
      {
        domain: 'identity',
        durationMs: expect.any(Number),
        operation: 'publish',
        outcome: 'success',
        type: 'config_publish',
      },
    ]);
  });

  it('observes a revision conflict once and not its failed replay', async () => {
    const draft = await createDraft();
    await recordSuccessfulTest(draft.id);
    const input = {
      expectedRevision: draft.revision + 1,
      id: draft.id,
      reason: 'stale publication revision',
      requestId: requestId(59),
    };

    await expect(publication.publish('admin-1', input)).rejects.toBeInstanceOf(
      PlatformRevisionConflictError,
    );
    await expect(publication.publish('admin-1', input)).rejects.toBeInstanceOf(
      PlatformRevisionConflictError,
    );

    expect(publishEvents()).toEqual([
      {
        domain: 'identity',
        durationMs: expect.any(Number),
        errorClass: 'ConflictError',
        operation: 'publish',
        outcome: 'conflict',
        type: 'config_publish',
      },
    ]);
  });

  it.each<[string, AuditResponseMutation]>([
    ['id', (response) => ({ ...response, id: 'provider-tampered' })],
    ['displayName', (response) => ({ ...response, displayName: 'Tampered login' })],
    ['revision', (response) => ({ ...response, revision: Number(response.revision) + 1 })],
    ['status', (response) => ({ ...response, status: 'draft' })],
    ['isConfigured', (response) => ({ ...response, isConfigured: false })],
    [
      'secretUpdatedAt',
      (response) => ({ ...response, secretUpdatedAt: new Date(0).toISOString() }),
    ],
    ['legacy fingerprint', (response) => ({ ...response, fingerprint: 'f'.repeat(64) })],
    ['providerKey', (response) => ({ ...response, providerKey: 'tampered' })],
  ])('fails closed when a publish replay response tampers %s', async (_field, mutation) => {
    const draft = await createDraft();
    await recordSuccessfulTest(draft.id);
    const input = {
      expectedRevision: draft.revision,
      id: draft.id,
      reason: 'publish adversarial replay',
      requestId: requestId(40),
    };
    await publication.publish('admin-1', input);
    await tamperTerminalResponse(input.requestId, mutation);

    await expect(publication.publish('admin-1', input)).rejects.toMatchObject({
      code: 'PLATFORM_IDENTITY_PROVIDER_IDEMPOTENCY_CONFLICT',
    });
  });

  it('binds publish replay result revision to the original expected revision', async () => {
    const draft = await createDraft();
    await recordSuccessfulTest(draft.id);
    const firstInput = {
      expectedRevision: draft.revision,
      id: draft.id,
      reason: 'publish request-bound result',
      requestId: requestId(47),
    };
    const firstPublished = await publication.publish('admin-1', firstInput);
    const restored = await publication.rollback('admin-1', {
      expectedRevision: firstPublished.revision,
      id: draft.id,
      reason: 'prepare another legitimate publication',
      requestId: requestId(48),
      targetRevision: firstPublished.revision,
    });
    const secondDraftRevision = restored.revision + 1;
    await db
      .update(platformIdentityProviders)
      .set({ displayName: 'Another published source', revision: secondDraftRevision })
      .where(eq(platformIdentityProviders.id, draft.id));
    await recordSuccessfulTest(draft.id);
    await publication.publish('admin-1', {
      expectedRevision: secondDraftRevision,
      id: draft.id,
      reason: 'publish another legitimate source',
      requestId: requestId(49),
    });
    const firstTerminal = await findTerminalAudit(firstInput.requestId);
    const secondTerminal = await findTerminalAudit(requestId(49));
    const firstAfterDiff = firstTerminal.afterDiff as Record<string, unknown>;
    const secondAfterDiff = secondTerminal.afterDiff as Record<string, unknown>;
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx
        .update(platformAuditLogs)
        .set({
          afterDiff: {
            ...firstAfterDiff,
            activation: secondAfterDiff.activation,
            checksum: secondAfterDiff.checksum,
            providerKey: secondAfterDiff.providerKey,
            response: secondAfterDiff.response,
            revision: secondAfterDiff.revision,
          },
          configRevision: secondTerminal.configRevision,
        })
        .where(eq(platformAuditLogs.id, firstTerminal.id));
    });

    await expect(publication.publish('admin-1', firstInput)).rejects.toMatchObject({
      code: 'PLATFORM_IDENTITY_PROVIDER_IDEMPOTENCY_CONFLICT',
    });
  });

  it('fences a paused expired owner after a recovery owner completes', async () => {
    const draft = await createDraft();
    await recordSuccessfulTest(draft.id);
    let pauseOld = (): void => undefined;
    const oldPaused = new Promise<void>((resolve) => {
      pauseOld = resolve;
    });
    let resumeOld = (): void => undefined;
    const oldResumed = new Promise<void>((resolve) => {
      resumeOld = resolve;
    });
    const fencedPublication = new IdentityProviderPublicationService(db, {
      afterReservation: async (fence) => {
        if (fence.generation !== 1) return;
        pauseOld();
        await oldResumed;
      },
      leaseMs: 20,
    });
    const input = {
      expectedRevision: draft.revision,
      id: draft.id,
      reason: 'fenced recovery publish',
      requestId: requestId(25),
    };
    const oldOutcome = fencedPublication.publish('admin-1', input).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await oldPaused;
    await new Promise((resolve) => setTimeout(resolve, 30));
    const recovered = await fencedPublication.publish('admin-1', input);
    resumeOld();
    const old = await oldOutcome;

    expect(old).toMatchObject({
      error: { code: 'PLATFORM_IDENTITY_PROVIDER_REQUEST_PENDING' },
    });
    expect(recovered).toMatchObject({ revision: draft.revision + 1 });
    expect(await db.select().from(platformResourceRevisions)).toHaveLength(1);
    const terminal = (await db.select().from(platformAuditLogs)).filter(
      (audit) => audit.action === 'admin.identityProviders.publish',
    );
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ result: 'success' });
  });

  it('lets the transaction-first owner finish while recovery waits and replays terminal', async () => {
    const draft = await createDraft();
    await recordSuccessfulTest(draft.id);
    let pauseTransaction = (): void => undefined;
    const transactionPaused = new Promise<void>((resolve) => {
      pauseTransaction = resolve;
    });
    let resumeTransaction = (): void => undefined;
    const transactionResumed = new Promise<void>((resolve) => {
      resumeTransaction = resolve;
    });
    const fencedPublication = new IdentityProviderPublicationService(db, {
      afterDraftLock: async (fence) => {
        if (fence.generation !== 1) return;
        pauseTransaction();
        await transactionResumed;
      },
      leaseMs: 20,
    });
    const input = {
      expectedRevision: draft.revision,
      id: draft.id,
      reason: 'transaction first publish',
      requestId: requestId(26),
    };
    const owner = fencedPublication.publish('admin-1', input);
    await transactionPaused;
    await new Promise((resolve) => setTimeout(resolve, 30));
    const recovery = fencedPublication.publish('admin-1', input);
    await new Promise((resolve) => setTimeout(resolve, 20));
    resumeTransaction();
    const [ownerResult, recoveryResult] = await Promise.all([owner, recovery]);

    expect(recoveryResult).toEqual(ownerResult);
    expect(await db.select().from(platformResourceRevisions)).toHaveLength(1);
    const terminal = (await db.select().from(platformAuditLogs)).filter(
      (audit) => audit.action === 'admin.identityProviders.publish',
    );
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ result: 'success' });
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
    expect(publishEvents()).toEqual([
      {
        domain: 'identity',
        durationMs: expect.any(Number),
        errorClass: 'UnexpectedError',
        operation: 'publish',
        outcome: 'failure',
        type: 'config_publish',
      },
    ]);
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

    await expect(publication.listPublishedRevisions(draft.id)).resolves.toEqual([
      { publishedAt: expect.any(Date), revision: published.revision },
    ]);

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
    const [restoredRow] = await db
      .select({ fingerprint: platformIdentityProviders.secretFingerprint })
      .from(platformIdentityProviders)
      .where(eq(platformIdentityProviders.id, draft.id));
    expect(restored.secret.fingerprint).toBe(restoredRow.fingerprint);
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
    observed.length = 0;
    const first = await publication.rollback('admin-1', input);
    await db
      .update(platformIdentityProviders)
      .set({ displayName: 'Later rollback draft', revision: first.revision + 1 })
      .where(eq(platformIdentityProviders.id, draft.id));
    const replay = await publication.rollback('admin-1', input);

    expect(replay).toEqual(first);
    const rollbackAudits = (await db.select().from(platformAuditLogs)).filter(
      (audit) => audit.action === 'admin.identityProviders.rollback',
    );
    expect(rollbackAudits).toHaveLength(1);
    expect(rollbackAudits[0]?.requestId).toBe(input.requestId);
    const [revision] = await db.select().from(platformResourceRevisions);
    expect(JSON.stringify(rollbackAudits[0])).not.toContain(revision!.secretFingerprint!);
    expect(JSON.stringify(rollbackAudits[0])).not.toMatch(/fingerprint/i);
    expect(observed).toEqual([]);
  });

  it.each<[string, AuditResponseMutation]>([
    ['id', (response) => ({ ...response, id: 'provider-tampered' })],
    ['displayName', (response) => ({ ...response, displayName: 'Tampered login' })],
    ['revision', (response) => ({ ...response, revision: Number(response.revision) + 1 })],
    ['status', (response) => ({ ...response, status: 'pending_restart' })],
    ['isConfigured', (response) => ({ ...response, isConfigured: false })],
    [
      'secretUpdatedAt',
      (response) => ({ ...response, secretUpdatedAt: new Date(0).toISOString() }),
    ],
    ['legacy fingerprint', (response) => ({ ...response, fingerprint: 'f'.repeat(64) })],
    ['providerKey', (response) => ({ ...response, providerKey: 'tampered' })],
  ])('fails closed when a rollback replay response tampers %s', async (_field, mutation) => {
    const draft = await createDraft();
    await recordSuccessfulTest(draft.id);
    const published = await publication.publish('admin-1', {
      expectedRevision: draft.revision,
      id: draft.id,
      reason: 'publish for adversarial rollback',
      requestId: requestId(41),
    });
    const input = {
      expectedRevision: published.revision,
      id: draft.id,
      reason: 'rollback adversarial replay',
      requestId: requestId(42),
      targetRevision: published.revision,
    };
    await publication.rollback('admin-1', input);
    await tamperTerminalResponse(input.requestId, mutation);

    await expect(publication.rollback('admin-1', input)).rejects.toMatchObject({
      code: 'PLATFORM_IDENTITY_PROVIDER_IDEMPOTENCY_CONFLICT',
    });
  });

  it('binds rollback replay to the request target when audit source and response are changed together', async () => {
    const draft = await createDraft();
    await recordSuccessfulTest(draft.id);
    const firstPublished = await publication.publish('admin-1', {
      expectedRevision: draft.revision,
      id: draft.id,
      reason: 'publish first canonical source',
      requestId: requestId(43),
    });
    const firstRollback = await publication.rollback('admin-1', {
      expectedRevision: firstPublished.revision,
      id: draft.id,
      reason: 'restore first source for a second draft',
      requestId: requestId(44),
      targetRevision: firstPublished.revision,
    });
    const secondDraftRevision = firstRollback.revision + 1;
    await db
      .update(platformIdentityProviders)
      .set({ displayName: 'Second canonical source', revision: secondDraftRevision })
      .where(eq(platformIdentityProviders.id, draft.id));
    await recordSuccessfulTest(draft.id);
    const secondPublished = await publication.publish('admin-1', {
      expectedRevision: secondDraftRevision,
      id: draft.id,
      reason: 'publish second canonical source',
      requestId: requestId(45),
    });
    const input = {
      expectedRevision: secondPublished.revision,
      id: draft.id,
      reason: 'rollback with request-bound source',
      requestId: requestId(46),
      targetRevision: firstPublished.revision,
    };
    await publication.rollback('admin-1', input);
    await tamperTerminalAfterDiff(input.requestId, (afterDiff) => ({
      ...afterDiff,
      restoredFromRevision: secondPublished.revision,
      response: {
        ...(afterDiff.response as Record<string, unknown>),
        displayName: 'Second canonical source',
      },
    }));

    await expect(publication.rollback('admin-1', input)).rejects.toMatchObject({
      code: 'PLATFORM_IDENTITY_PROVIDER_IDEMPOTENCY_CONFLICT',
    });
  });

  it('binds rollback replay result revision to the original expected revision', async () => {
    const draft = await createDraft();
    await recordSuccessfulTest(draft.id);
    const published = await publication.publish('admin-1', {
      expectedRevision: draft.revision,
      id: draft.id,
      reason: 'publish for request-bound rollback result',
      requestId: requestId(50),
    });
    const input = {
      expectedRevision: published.revision,
      id: draft.id,
      reason: 'rollback with request-bound result',
      requestId: requestId(51),
      targetRevision: published.revision,
    };
    const result = await publication.rollback('admin-1', input);
    const terminal = await findTerminalAudit(input.requestId);
    const afterDiff = terminal.afterDiff as Record<string, unknown>;
    const response = afterDiff.response as Record<string, unknown>;
    const tamperedResultRevision = result.revision + 10;
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx
        .update(platformAuditLogs)
        .set({
          afterDiff: {
            ...afterDiff,
            response: { ...response, revision: tamperedResultRevision },
            revision: tamperedResultRevision,
          },
          configRevision: tamperedResultRevision,
        })
        .where(eq(platformAuditLogs.id, terminal.id));
    });

    await expect(publication.rollback('admin-1', input)).rejects.toMatchObject({
      code: 'PLATFORM_IDENTITY_PROVIDER_IDEMPOTENCY_CONFLICT',
    });
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
    await tamperPublishedRevision(draft.id, mutation);

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
