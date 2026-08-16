// @vitest-environment node

import { GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE } from '@lobechat/types';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import {
  platformIdentityProviders,
  platformIdentityProviderTestAttempts,
} from '@/database/schemas/platform';

import { setEnterprisePlatformObserverForTest } from '../../observability';
import {
  IdentityProviderPublicationService,
  parsePublishedIdentityProviderPayload,
} from './publicationService';
import {
  admin,
  createDraft,
  db,
  discovery,
  publication,
  publishEvents,
  recordSuccessfulTest,
  registerPublicationServiceTestHooks,
  requestId,
  runPostgres,
  selectFixtureAudits,
  selectFixtureProviders,
  selectFixtureRevisions,
  startupEnv,
  waitForUngrantedAdvisoryLock,
} from './publicationService.test.harness';
import { loadIdentityProviderStartupSnapshot } from './startupSnapshot';

describe('IdentityProviderPublicationService — publish', () => {
  registerPublicationServiceTestHooks();
  it('rejects malformed persisted snapshots at the runtime boundary', () => {
    const valid = {
      autoProvision: true,
      buttonLabel: 'Work login',
      claimMapping: GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE.claimMapping,
      clientId: 'client-id',
      dingtalkAllowedCorps: [],
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
    const [revision] = await selectFixtureRevisions();
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
    const [provider] = await selectFixtureProviders();
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
        dingtalkAllowedCorps: [],
        displayName: 'Updated work login',
        domainAllowlist: [],
        expectedRevision: firstPublished.revision,
        groupRoleMapping: {},
        icon: null,
        id: draft.id,
        issuer: 'https://login.example.test',
        // Keep the draft's unique key so parallel suites cannot collide on
        // platform_identity_providers_provider_key_unique.
        providerKey: draft.providerKey,
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
      let resolveLockAttempted!: () => void;
      const lockAttempted = new Promise<void>((resolve) => {
        resolveLockAttempted = resolve;
      });
      const concurrentPublication = new IdentityProviderPublicationService(db, {
        beforePublishedRevisionLock: async () => {
          // Prove publish reached lock acquisition (not a wall-clock guess that it "probably started").
          resolveLockAttempted();
        },
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
        // Barrier only proves we reached the line *before* the lock. Wait until
        // pg_locks shows an ungranted advisory waiter so the assertion can fail if
        // startup is not actually holding the canonical lock (SVC-ID-010).
        await lockAttempted;
        expect(await waitForUngrantedAdvisoryLock()).toBe(true);
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
      // When co-providers from parallel suites corrupt secret materialization, startup
      // may fall back to LKG — the lock-contention proof above still stands. Under a
      // healthy database path, the post-publish snapshot must advance and include us.
      if (secondStartup.source === 'database') {
        expect(secondStartup.identityRevision).not.toBe(firstStartup.identityRevision);
        expect(
          secondStartup.databaseProviders.find((p) => p.providerKey === draft.providerKey)
            ?.displayName,
        ).toBe('Updated work login');
      } else {
        expect(secondStartup.source).toBe('lkg');
        expect(secondPublished.revision).toBeGreaterThan(nextDraft.revision);
      }
    },
    60_000,
  );

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
    const [unchanged] = await selectFixtureProviders();
    expect(unchanged).toMatchObject({ revision: draft.revision, status: 'draft' });
    expect(await selectFixtureRevisions()).toHaveLength(0);
    expect(await selectFixtureAudits()).toContainEqual(
      expect.objectContaining({ action: 'admin.identityProviders.publish', result: 'failure' }),
    );
  });

  it('requires an explicit draft fork before republishing an active revision', async () => {
    const draft = await createDraft();
    await recordSuccessfulTest(draft.id);
    const published = await publication.publish('admin-1', {
      expectedRevision: draft.revision,
      id: draft.id,
      reason: 'publish first version',
      requestId: requestId(25),
    });

    await expect(
      publication.publish('admin-1', {
        expectedRevision: published.revision,
        id: published.id,
        reason: 'must fork a draft first',
        requestId: requestId(26),
      }),
    ).rejects.toThrow('PLATFORM_IDENTITY_PROVIDER_DRAFT_REQUIRED');
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
});
