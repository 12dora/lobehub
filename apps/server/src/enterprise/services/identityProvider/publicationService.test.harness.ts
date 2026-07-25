// Shared fixtures for IdentityProviderPublicationService test splits.
// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE } from '@lobechat/types';
import { eq, inArray, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterEach, beforeEach, vi } from 'vitest';

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

import type { EnterpriseObservabilityEvent } from '../../observability';
import { setEnterprisePlatformObserverForTest } from '../../observability';
import { AdminIdentityProviderService } from './adminService';
import type { IdentityProviderDiscoveryValidator } from './discoveryValidator';
import { IdentityProviderPublicationService } from './publicationService';
import { resetIdentityProviderStartupSnapshotForTest } from './startupSnapshot';
import { IdentityProviderTestAttemptStore } from './testAttemptStore';

export const db: LobeChatDatabase = await getTestDB();
export const runPostgres =
  process.env.TEST_SERVER_DB === '1' && Boolean(process.env.DATABASE_TEST_URL);
export const directories: string[] = [];
export const keyProvider: KeyProvider = {
  getKek: async () => ({ key: new Uint8Array(32).fill(73), keyId: 'test-key' }),
  providerId: 'test',
};
export const secrets = new PlatformSecretService({ keyProvider });
export const admin = new AdminIdentityProviderService(
  db,
  secrets,
  {} as IdentityProviderDiscoveryValidator,
  'https://app.example.test',
);
export const publication = new IdentityProviderPublicationService(db);
export const attempts = new IdentityProviderTestAttemptStore(db, secrets);
export const observed: EnterpriseObservabilityEvent[] = [];
export const publishEvents = () => observed.filter((event) => event.type === 'config_publish');
export const requestId = (index: number) =>
  `550e8400-e29b-41d4-a716-${index.toString().padStart(12, '0')}`;

/**
 * Provider ids created by this suite's fixtures. Cleanup is scoped to these ids so
 * concurrent publication* test files on a shared TEST_SERVER_DB pool cannot
 * cross-truncate each other (SG-07 pattern).
 */
const fixtureProviderIds = new Set<string>();

export const trackFixtureProviderId = (id: string): void => {
  fixtureProviderIds.add(id);
};

export const fixtureProviderIdList = (): string[] => [...fixtureProviderIds];

/** Fixture-scoped table reads — prefer these over unscoped selects under shared DB. */
export const selectFixtureProviders = () => {
  const ids = fixtureProviderIdList();
  if (ids.length === 0) return Promise.resolve([]);
  return db
    .select()
    .from(platformIdentityProviders)
    .where(inArray(platformIdentityProviders.id, ids));
};

export const selectFixtureRevisions = () => {
  const ids = fixtureProviderIdList();
  if (ids.length === 0) return Promise.resolve([]);
  return db
    .select()
    .from(platformResourceRevisions)
    .where(inArray(platformResourceRevisions.resourceId, ids));
};

export const selectFixtureAudits = () => {
  const ids = fixtureProviderIdList();
  if (ids.length === 0) return Promise.resolve([]);
  return db.select().from(platformAuditLogs).where(inArray(platformAuditLogs.targetId, ids));
};

export const selectFixtureSecrets = () => {
  const ids = fixtureProviderIdList();
  if (ids.length === 0) return Promise.resolve([]);
  return db
    .select()
    .from(platformIdentityProviderSecrets)
    .where(inArray(platformIdentityProviderSecrets.providerId, ids));
};

/**
 * Poll pg_locks until an *advisory* lock waiter is blocked (or deadline).
 * Uses a separate connection — the harness pool may be the blocked waiter.
 * Postgres-only; proves real contention without vacuous wall-clock polls.
 */
export const waitForUngrantedAdvisoryLock = async (timeoutMs = 5000): Promise<boolean> => {
  const connectionString = process.env.DATABASE_TEST_URL;
  if (!connectionString) return false;
  const observer = new Pool({ connectionString, max: 1 });
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const blocked = await observer.query(
        `SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted LIMIT 1`,
      );
      if ((blocked.rowCount ?? 0) > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
  } finally {
    await observer.end().catch(() => undefined);
  }
};

export type AuditResponseMutation = (response: Record<string, unknown>) => Record<string, unknown>;

export const findTerminalAudit = async (idempotencyRequestId: string) => {
  const terminal = (await selectFixtureAudits()).find(
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

export const tamperTerminalAfterDiff = async (
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

export const tamperPublishedRevision = async (
  resourceId: string,
  mutation: Record<string, unknown>,
) => {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    await tx
      .update(platformResourceRevisions)
      .set(mutation)
      .where(eq(platformResourceRevisions.resourceId, resourceId));
  });
};

export const tamperTerminalResponse = async (
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
  const ids = fixtureProviderIdList();
  fixtureProviderIds.clear();
  // Immutable published revisions + append-only audit require trigger bypass for fixtures.
  // Scope deletes to this suite's fixture provider ids only — never wipe shared tables
  // (three publication* files share one TEST_SERVER_DB pool under fileParallelism).
  if (ids.length > 0) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx
        .delete(platformIdentityProviderTestAttempts)
        .where(inArray(platformIdentityProviderTestAttempts.providerId, ids));
      await tx
        .delete(platformIdentityProviderSecrets)
        .where(inArray(platformIdentityProviderSecrets.providerId, ids));
      await tx.delete(platformIdentityProviders).where(inArray(platformIdentityProviders.id, ids));
      await tx
        .delete(platformResourceRevisions)
        .where(inArray(platformResourceRevisions.resourceId, ids));
      await tx.delete(platformAuditLogs).where(inArray(platformAuditLogs.targetId, ids));
    });
  }
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
};

/** Register shared beforeEach/afterEach inside each suite's describe block. */
export const registerPublicationServiceTestHooks = (): void => {
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
};

export const createDraft = async (providerKey?: string) => {
  // Default key is unique so parallel publication* files on a shared DB cannot
  // collide on provider_key; tests that assert a specific key pass it explicitly.
  const key = providerKey ?? `work-${randomUUID().slice(0, 8)}`;
  const draft = await admin.create('admin-1', {
    autoProvision: true,
    buttonLabel: 'Sign in with work',
    claimMapping: GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE.claimMapping,
    clientId: 'client-id',
    displayName: 'Work login',
    domainAllowlist: [],
    groupRoleMapping: {},
    icon: null,
    issuer: 'https://login.example.test',
    providerKey: key,
    reason: 'configure work login',
    scopes: [...GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE.scopes],
    secret: { operation: 'replace', value: 'fake-client-secret-for-test' },
    type: 'generic_oidc',
    usePkce: true,
  });
  trackFixtureProviderId(draft.id);
  return draft;
};

export const startupEnv = async () => {
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

export const discovery = {
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

export const recordSuccessfulTest = async (providerId: string) => {
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
