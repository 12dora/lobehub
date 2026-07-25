// @vitest-environment node

import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { checksumPayload, PlatformRevisionConflictError } from '@/database/models/platform';
import {
  platformAuditLogs,
  platformIdentityProviders,
  platformIdentityProviderSecrets,
  platformResourceRevisions,
} from '@/database/schemas/platform';

import { IdentityProviderPublicationService } from './publicationService';
import {
  admin,
  type AuditResponseMutation,
  createDraft,
  db,
  findTerminalAudit,
  observed,
  publication,
  publishEvents,
  recordSuccessfulTest,
  registerPublicationServiceTestHooks,
  requestId,
  secrets,
  selectFixtureAudits,
  selectFixtureRevisions,
  selectFixtureSecrets,
  tamperPublishedRevision,
  tamperTerminalAfterDiff,
  tamperTerminalResponse,
} from './publicationService.test.harness';
import { IdentityProviderSecretStore } from './secretStore';

describe('IdentityProviderPublicationService — rollback + idempotency', () => {
  registerPublicationServiceTestHooks();
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
    const [revision] = await selectFixtureRevisions();
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
    const [revision] = await selectFixtureRevisions();
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
    const revisions = await selectFixtureRevisions();
    expect(revisions).toHaveLength(1);
    const audits = await selectFixtureAudits();
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
    // Wait until wall clock is past the recorded gen-1 leaseExpiresAt (not a bare sleep).
    {
      const rows = await selectFixtureAudits();
      const lease = rows.find(
        (audit) => audit.action === 'admin.identityProviders.publish.requestReserved',
      );
      const expiresAt =
        lease?.afterDiff &&
        typeof lease.afterDiff === 'object' &&
        !Array.isArray(lease.afterDiff) &&
        typeof (lease.afterDiff as { leaseExpiresAt?: unknown }).leaseExpiresAt === 'string'
          ? Date.parse((lease.afterDiff as { leaseExpiresAt: string }).leaseExpiresAt)
          : Number.NaN;
      expect(Number.isNaN(expiresAt)).toBe(false);
      while (Date.now() <= expiresAt) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    const recovered = await fencedPublication.publish('admin-1', input);
    resumeOld();
    const old = await oldOutcome;

    expect(old).toMatchObject({
      error: { code: 'PLATFORM_IDENTITY_PROVIDER_REQUEST_PENDING' },
    });
    expect(recovered).toMatchObject({ revision: draft.revision + 1 });
    expect(await selectFixtureRevisions()).toHaveLength(1);
    const terminal = (await selectFixtureAudits()).filter(
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
    // Deterministic lease clock: advance past gen-1 expiry without wall-clock sleeps.
    // On PGlite's single connection recovery still serializes behind the owner tx;
    // multi-conn lease recovery is covered by the fenced-expired-owner test above.
    let clockMs = Date.now();
    const leaseMs = 20;
    const fencedPublication = new IdentityProviderPublicationService(db, {
      afterDraftLock: async (fence) => {
        if (fence.generation !== 1) return;
        pauseTransaction();
        await transactionResumed;
      },
      leaseMs,
      now: () => new Date(clockMs),
    });
    const input = {
      expectedRevision: draft.revision,
      id: draft.id,
      reason: 'transaction first publish',
      requestId: requestId(26),
    };
    const owner = fencedPublication.publish('admin-1', input);
    await transactionPaused;
    clockMs += leaseMs + 50;
    const recovery = fencedPublication.publish('admin-1', input);
    resumeTransaction();
    const [ownerResult, recoveryResult] = await Promise.all([owner, recovery]);

    expect(recoveryResult).toEqual(ownerResult);
    expect(await selectFixtureRevisions()).toHaveLength(1);
    const terminal = (await selectFixtureAudits()).filter(
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
    expect(await selectFixtureRevisions()).toHaveLength(1);
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

    const audits = await selectFixtureAudits();
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
    expect(await selectFixtureSecrets()).toHaveLength(1);
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
    const rollbackAudits = (await selectFixtureAudits()).filter(
      (audit) => audit.action === 'admin.identityProviders.rollback',
    );
    expect(rollbackAudits).toHaveLength(1);
    expect(rollbackAudits[0]?.requestId).toBe(input.requestId);
    const [revision] = await selectFixtureRevisions();
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
