// @vitest-environment node

import { randomUUID } from 'node:crypto';

import { GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE } from '@lobechat/types';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  platformIdentityProviders,
  platformIdentityProviderSecrets,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import {
  admin,
  createDraft,
  db,
  discovery,
  publication,
  recordSuccessfulTest,
  registerPublicationServiceTestHooks,
  requestId,
  selectFixtureRevisions,
  startupEnv,
} from './publicationService.test.harness';
import { loadIdentityProviderStartupSnapshot } from './startupSnapshot';

describe('IdentityProviderPublicationService — disable + revocation', () => {
  registerPublicationServiceTestHooks();
  let previousEnvironment: Record<string, string | undefined> = {};

  beforeEach(async () => {
    const environment = await startupEnv();
    previousEnvironment = Object.fromEntries(
      Object.keys(environment).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, environment);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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
    const revisions = await selectFixtureRevisions();
    expect(revisions.some((row) => (row.payload as { enabled?: boolean }).enabled === false)).toBe(
      true,
    );
    const selection = await (
      await import('./startupSnapshot')
    ).loadPublishedIdentityProviderSelection({
      db,
      environmentProviderIds: new Set(),
    });
    // Fixture-scoped: other parallel suites may still have live published providers.
    expect(selection.selected.map((row) => row.providerId)).not.toContain(draft.id);
    expect(selection.tombstones.some((row) => row.providerId === draft.id)).toBe(true);
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
      dingtalkAllowedCorps: [],
      displayName: 'Work login (edited)',
      domainAllowlist: [],
      expectedRevision: published.revision,
      groupRoleMapping: {},
      icon: null,
      id: draft.id,
      issuer: 'https://login.example.test',
      providerKey: draft.providerKey,
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
    // Fixture-scoped: other parallel suites may still have live published providers.
    expect(selection.selected.map((row) => row.providerId)).not.toContain(draft.id);
    expect(selection.tombstones.some((row) => row.providerId === draft.id)).toBe(true);
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
      dingtalkAllowedCorps: [],
      displayName: 'Work login',
      domainAllowlist: [],
      expectedRevision: published.revision,
      groupRoleMapping: {},
      icon: null,
      id: draft.id,
      issuer: 'https://login.example.test',
      providerKey: draft.providerKey,
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
    const tombstones = (await selectFixtureRevisions()).filter(
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
    // Suffixed keys avoid platform_identity_providers_provider_key_unique collisions
    // when this file runs in parallel with other publication suites on one DB.
    const keyA = `work-${randomUUID().slice(0, 8)}`;
    const keyB = `partner-${randomUUID().slice(0, 8)}`;
    const draftA = await createDraft(keyA);
    await recordSuccessfulTest(draftA.id);
    const publishedA = await publication.publish('admin-1', {
      expectedRevision: draftA.revision,
      id: draftA.id,
      reason: 'activate A for lkg outage tombstone',
      requestId: requestId(93),
    });
    const draftB = await createDraft(keyB);
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
    // Assert our keys are present (not exclusive equality) — other parallel
    // publication suites may leave published providers visible on a shared DB.
    const liveKeys = liveStartup.databaseProviders.map((p) => p.providerKey);
    expect(liveKeys).toEqual(expect.arrayContaining([keyA, keyB]));

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
    expect(outageStartup.databaseProviders.map((p) => p.providerKey)).not.toContain(keyA);
    expect(outageStartup.providerIds).not.toContain(keyA);
  });

  it('total DB outage immediately after Disable does not resurrect via pre-tombstone LKG (identity/F10)', async () => {
    // Disable advances the local LKG file so a total DB failure (selection throws)
    // cannot fall back to a pre-revoke snapshot that still contains the provider.
    const draft = await createDraft('revoked-immediate');
    await recordSuccessfulTest(draft.id);
    const published = await publication.publish('admin-1', {
      expectedRevision: draft.revision,
      id: draft.id,
      reason: 'activate for immediate outage revoke',
      requestId: requestId(95),
    });
    const env = await startupEnv();
    // Seed LKG with the live provider (healthy startup before disable).
    const liveStartup = await loadIdentityProviderStartupSnapshot({
      cache: false,
      db,
      discovery,
      env,
    });
    expect(liveStartup.source).toBe('database');
    expect(liveStartup.databaseProviders.map((p) => p.providerKey)).toContain('revoked-immediate');

    // Point process env at the same LKG path so disable's best-effort advance hits it.
    const previousLkg = process.env.PLATFORM_OIDC_LKG_PATH;
    const previousMaster = process.env.PLATFORM_MASTER_KEY;
    const previousMasterId = process.env.PLATFORM_MASTER_KEY_ID;
    process.env.PLATFORM_OIDC_LKG_PATH = env.PLATFORM_OIDC_LKG_PATH;
    process.env.PLATFORM_MASTER_KEY = env.PLATFORM_MASTER_KEY;
    process.env.PLATFORM_MASTER_KEY_ID = env.PLATFORM_MASTER_KEY_ID;
    try {
      await publication.disable('admin-1', {
        expectedRevision: published.revision,
        id: draft.id,
        reason: 'immediate revoke before total outage',
      });
    } finally {
      if (previousLkg === undefined) delete process.env.PLATFORM_OIDC_LKG_PATH;
      else process.env.PLATFORM_OIDC_LKG_PATH = previousLkg;
      if (previousMaster === undefined) delete process.env.PLATFORM_MASTER_KEY;
      else process.env.PLATFORM_MASTER_KEY = previousMaster;
      if (previousMasterId === undefined) delete process.env.PLATFORM_MASTER_KEY_ID;
      else process.env.PLATFORM_MASTER_KEY_ID = previousMasterId;
    }

    // Total DB outage: selection cannot read tombstones; only advanced LKG remains.
    const outageDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'select' || prop === 'transaction' || prop === 'execute') {
          return () => {
            throw new Error('simulated total database outage');
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as LobeChatDatabase;

    const outageStartup = await loadIdentityProviderStartupSnapshot({
      cache: false,
      db: outageDb,
      discovery,
      env,
    });
    expect(outageStartup.source).toBe('lkg');
    expect(outageStartup.databaseProviders.map((p) => p.providerKey)).not.toContain(
      'revoked-immediate',
    );
    expect(outageStartup.providerIds).not.toContain('revoked-immediate');
  });

  it('refuses disable before commit when the durable revocation journal cannot be signed', async () => {
    const draft = await createDraft('lkg-audit-failure');
    await recordSuccessfulTest(draft.id);
    const published = await publication.publish('admin-1', {
      expectedRevision: draft.revision,
      id: draft.id,
      reason: 'activate for lkg advance audit failure',
      requestId: requestId(96),
    });
    // Ensure PlatformSecretService.tryFromEnv returns null so advance is skipped.
    const previousMaster = process.env.PLATFORM_MASTER_KEY;
    const previousMasterId = process.env.PLATFORM_MASTER_KEY_ID;
    const previousLkg = process.env.PLATFORM_OIDC_LKG_PATH;
    delete process.env.PLATFORM_MASTER_KEY;
    delete process.env.PLATFORM_MASTER_KEY_ID;
    delete process.env.PLATFORM_OIDC_LKG_PATH;
    try {
      await expect(
        publication.disable('admin-1', {
          expectedRevision: published.revision,
          id: draft.id,
          reason: 'revoke without lkg secrets',
        }),
      ).rejects.toThrow('PLATFORM_IDENTITY_PROVIDER_REVOCATION_JOURNAL_SECRET_UNAVAILABLE');
    } finally {
      if (previousMaster === undefined) delete process.env.PLATFORM_MASTER_KEY;
      else process.env.PLATFORM_MASTER_KEY = previousMaster;
      if (previousMasterId === undefined) delete process.env.PLATFORM_MASTER_KEY_ID;
      else process.env.PLATFORM_MASTER_KEY_ID = previousMasterId;
      if (previousLkg === undefined) delete process.env.PLATFORM_OIDC_LKG_PATH;
      else process.env.PLATFORM_OIDC_LKG_PATH = previousLkg;
    }
    expect(
      await db
        .select({
          enabled: platformIdentityProviders.enabled,
          revision: platformIdentityProviders.revision,
        })
        .from(platformIdentityProviders)
        .where(eq(platformIdentityProviders.id, draft.id)),
    ).toEqual([{ enabled: true, revision: published.revision }]);
  });
});
