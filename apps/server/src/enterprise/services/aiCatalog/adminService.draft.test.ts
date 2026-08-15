// @vitest-environment node
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { PlatformRevisionConflictError } from '@/database/models/platform';
import {
  platformAiModels,
  platformAiProviders,
  platformAiProviderSecrets,
  platformAuditLogs,
  platformResourceRevisions,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { type KeyProvider, PlatformSecretService } from '@/server/enterprise/security/secret';

import { AiCatalogAdminService } from './adminService';

const db: LobeChatDatabase = await getTestDB();
const keyProvider: KeyProvider = {
  getKek: async () => ({ key: new Uint8Array(32).fill(23), keyId: 'draft-test' }),
  providerId: 'test',
};
const service = new AiCatalogAdminService(db, new PlatformSecretService({ keyProvider }));

/** Append-only audit/revision rows cannot be DELETE'd (0145); TRUNCATE bypasses the row trigger. */
const cleanup = async () => {
  await db.execute(sql`
    TRUNCATE TABLE
      ${platformAuditLogs},
      ${platformResourceRevisions},
      ${platformAiModels},
      ${platformAiProviderSecrets},
      ${platformAiProviders}
    RESTART IDENTITY CASCADE
  `);
};

beforeEach(cleanup);
afterEach(cleanup);

describe('AiCatalogAdminService provider draft mutations', () => {
  it('rejects copying replacement or kept credential leaves into public provider fields', async () => {
    const credential = 'arbitrary-provider-credential-leaf';
    await expect(
      service.createProviderDraft('admin', {
        description: `leak:${credential}`,
        displayName: 'Rejected',
        providerKey: 'rejected',
        reason: 'create',
        secret: { operation: 'replace', value: { apiKey: credential } },
        source: 'custom',
      }),
    ).rejects.toMatchObject({
      issues: ['Provider credentials must not appear in public catalog fields'],
    });
    expect(await db.select().from(platformAiProviders)).toEqual([]);

    const created = await service.createProviderDraft('admin', {
      displayName: 'Safe',
      providerKey: 'safe',
      reason: 'create',
      secret: { operation: 'replace', value: { apiKey: credential } },
      source: 'custom',
    });
    const detail = await service.getDetail(created.id);
    await expect(
      service.updateProviderDraft('admin', {
        displayName: credential,
        expectedDraftToken: detail.draftToken,
        expectedRevision: 0,
        id: created.id,
        reason: 'copy kept secret',
        secret: { operation: 'keep' },
      }),
    ).rejects.toMatchObject({
      issues: ['Provider credentials must not appear in public catalog fields'],
    });
    expect((await service.getDetail(created.id)).draft.displayName).toBe('Safe');

    const fresh = await service.getDetail(created.id);
    await expect(
      service.updateProviderDraft('admin', {
        expectedDraftToken: fresh.draftToken,
        expectedRevision: 0,
        id: created.id,
        logo: 'https://cdn.example.test/logo?X-Amz-Signature=unrelated-signed-value',
        reason: 'reject unrelated credential URL',
        secret: { operation: 'keep' },
      }),
    ).rejects.toMatchObject({
      issues: ['Provider credentials must not appear in public catalog fields'],
    });
  });

  it('rejects credential-shaped strings even when no platform secret exists', async () => {
    await expect(
      service.createProviderDraft('admin', {
        description: 'Bearer unrelated-public-token-value',
        displayName: 'Rejected without secret',
        providerKey: 'no-secret-rejected',
        reason: 'create',
        source: 'custom',
      }),
    ).rejects.toMatchObject({
      issues: ['Provider credentials must not appear in public catalog fields'],
    });
    expect(await db.select().from(platformAiProviders)).toEqual([]);
  });

  it('persists sanitized connection state and marks it stale after any draft mutation', async () => {
    const testedService = new AiCatalogAdminService(
      db,
      new PlatformSecretService({ keyProvider }),
      {
        connectionProbe: async () => {},
      },
    );
    const created = await testedService.createProviderDraft('admin', {
      checkModel: 'chat',
      config: { endpoint: 'https://private-test-state.example.test/v1' },
      displayName: 'Tested',
      enabled: true,
      providerKey: 'tested',
      reason: 'create',
      secret: { operation: 'replace', value: 'connection-state-secret' },
      source: 'custom',
    });
    await testedService.createModel('admin', {
      enabled: true,
      expectedDraftToken: (await testedService.getDetail(created.id)).draftToken,
      modelKey: 'chat',
      providerId: created.id,
      reason: 'add check model',
      type: 'chat',
    });

    const result = await testedService.testProvider('admin', {
      id: created.id,
      reason: 'test current draft',
    });
    expect(result.status).toBe('success');
    let detail = await testedService.getDetail(created.id);
    expect(detail.draft.connectionTest).toMatchObject({
      stale: false,
      status: 'success',
      testedRevision: 0,
    });
    const stateJson = JSON.stringify(detail.draft.connectionTest);
    expect(stateJson).not.toContain('connection-state-secret');
    expect(stateJson).not.toContain('private-test-state.example.test');
    // Client-facing draft must never project secret fingerprint.
    expect(detail.draft.secret).toEqual(
      expect.objectContaining({ configured: true, updatedAt: expect.anything() }),
    );
    expect(detail.draft.secret).not.toHaveProperty('fingerprint');
    const [rowWithFp] = await db.select().from(platformAiProviders);
    if (rowWithFp.secretFingerprint) {
      expect(JSON.stringify(detail.draft)).not.toContain(rowWithFp.secretFingerprint);
    }

    await testedService.updateProviderDraft('admin', {
      displayName: 'Mutated after test',
      expectedDraftToken: detail.draftToken,
      expectedRevision: 0,
      id: created.id,
      reason: 'mutate',
    });
    detail = await testedService.getDetail(created.id);
    expect(detail.draft.connectionTest).toMatchObject({ stale: true, status: 'success' });
  });

  it('uses an attempt CAS so a slower old probe cannot overwrite a newer result', async () => {
    const probes: Array<{
      entered: () => void;
      enteredPromise: Promise<void>;
      promise: Promise<void>;
      reject: (error: Error) => void;
      resolve: () => void;
    }> = [];
    const createProbe = () => {
      let entered!: () => void;
      let reject!: (error: Error) => void;
      let resolve!: () => void;
      const enteredPromise = new Promise<void>((done) => {
        entered = done;
      });
      const promise = new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      return { entered, enteredPromise, promise, reject, resolve };
    };
    const first = createProbe();
    const second = createProbe();
    probes.push(first, second);
    let probeIndex = 0;
    const testedService = new AiCatalogAdminService(
      db,
      new PlatformSecretService({ keyProvider }),
      {
        connectionProbe: async () => {
          const probe = probes[probeIndex++];
          probe.entered();
          await probe.promise;
        },
      },
    );
    const created = await testedService.createProviderDraft('admin', {
      checkModel: 'chat',
      displayName: 'Concurrent',
      enabled: true,
      providerKey: 'concurrent',
      reason: 'create',
      secret: { operation: 'replace', value: 'concurrent-secret' },
      source: 'custom',
    });
    await testedService.createModel('admin', {
      enabled: true,
      expectedDraftToken: (await testedService.getDetail(created.id)).draftToken,
      modelKey: 'chat',
      providerId: created.id,
      reason: 'add check model',
      type: 'chat',
    });

    const oldAttempt = testedService.testProvider('admin', { id: created.id, reason: 'old' });
    await first.enteredPromise;
    const newAttempt = testedService.testProvider('admin', { id: created.id, reason: 'new' });
    await second.enteredPromise;
    second.resolve();
    await expect(newAttempt).resolves.toMatchObject({ status: 'success' });
    first.reject(new Error('older probe failed'));
    // Superseded older attempt must return authoritative persisted success (not the discarded failure).
    await expect(oldAttempt).resolves.toMatchObject({ status: 'success' });

    expect((await testedService.getDetail(created.id)).draft.connectionTest).toMatchObject({
      stale: false,
      status: 'success',
    });
    // Exactly one authoritative test audit (the winning attempt) — discarded probe must not
    // append a misleading failure audit via the outer catch.
    const testAudits = (await db.select().from(platformAuditLogs)).filter(
      (row) => row.action === 'admin.aiProviders.test',
    );
    expect(testAudits).toHaveLength(1);
    expect(testAudits[0]).toMatchObject({ result: 'success' });
  });

  it('does not failure-audit a superseded attempt while the newer probe is still pending', async () => {
    const probes: Array<{
      entered: () => void;
      enteredPromise: Promise<void>;
      promise: Promise<void>;
      resolve: () => void;
    }> = [];
    const createProbe = () => {
      let entered!: () => void;
      let resolve!: () => void;
      const enteredPromise = new Promise<void>((done) => {
        entered = done;
      });
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { entered, enteredPromise, promise, resolve };
    };
    const first = createProbe();
    const second = createProbe();
    probes.push(first, second);
    let probeIndex = 0;
    const testedService = new AiCatalogAdminService(
      db,
      new PlatformSecretService({ keyProvider }),
      {
        connectionProbe: async () => {
          const probe = probes[probeIndex++];
          probe.entered();
          await probe.promise;
        },
      },
    );
    const created = await testedService.createProviderDraft('admin', {
      checkModel: 'chat',
      displayName: 'Pending Supersede',
      enabled: true,
      providerKey: 'pending-supersede',
      reason: 'create',
      secret: { operation: 'replace', value: 'pending-secret' },
      source: 'custom',
    });
    await testedService.createModel('admin', {
      enabled: true,
      expectedDraftToken: (await testedService.getDetail(created.id)).draftToken,
      modelKey: 'chat',
      providerId: created.id,
      reason: 'add check model',
      type: 'chat',
    });

    const oldAttempt = testedService.testProvider('admin', { id: created.id, reason: 'old' });
    await first.enteredPromise;
    const newAttempt = testedService.testProvider('admin', { id: created.id, reason: 'new' });
    await second.enteredPromise;

    // Finish the older probe while the newer attempt is still pending.
    first.resolve();
    await expect(oldAttempt).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.stringMatching(/superseded by a newer attempt/i)]),
    });
    const midAudits = (await db.select().from(platformAuditLogs)).filter(
      (row) => row.action === 'admin.aiProviders.test',
    );
    expect(midAudits).toHaveLength(0);

    second.resolve();
    await expect(newAttempt).resolves.toMatchObject({ status: 'success' });
    const finalAudits = (await db.select().from(platformAuditLogs)).filter(
      (row) => row.action === 'admin.aiProviders.test',
    );
    expect(finalAudits).toHaveLength(1);
    expect(finalAudits[0]).toMatchObject({ result: 'success' });
  });

  it('persists only sanitized failure metadata', async () => {
    const failingService = new AiCatalogAdminService(
      db,
      new PlatformSecretService({ keyProvider }),
      {
        connectionProbe: async () => {
          throw new Error(
            'Unauthorized sk-private-connection-value at https://private-failure.example/v1',
          );
        },
      },
    );
    const created = await failingService.createProviderDraft('admin', {
      checkModel: 'chat',
      displayName: 'Failure',
      enabled: true,
      providerKey: 'failure',
      reason: 'create',
      secret: { operation: 'replace', value: 'failure-secret' },
      source: 'custom',
    });
    await failingService.createModel('admin', {
      enabled: true,
      expectedDraftToken: (await failingService.getDetail(created.id)).draftToken,
      modelKey: 'chat',
      providerId: created.id,
      reason: 'add check model',
      type: 'chat',
    });
    await expect(
      failingService.testProvider('admin', { id: created.id, reason: 'test failure' }),
    ).resolves.toMatchObject({ status: 'failure' });
    const connectionTest = (await failingService.getDetail(created.id)).draft.connectionTest;
    expect(connectionTest).toMatchObject({
      errorCategory: 'auth',
      stale: false,
      status: 'failure',
    });
    const json = JSON.stringify(connectionTest);
    expect(json).not.toContain('private-failure.example');
    expect(json).not.toContain('sk-private-connection-value');
    expect(json).not.toContain('failure-secret');
  });

  it('records the refined category for the plain-object error the model runtime really throws', async () => {
    // `AgentRuntimeError.chat` returns a plain object with the status NESTED. Classifying it as
    // an `Error` collapsed a dead OAuth grant, a 429 and a timeout into one "provider rejected
    // the request" audit + toast, which is what made the shared-account check undiagnosable.
    const runtimeService = new AiCatalogAdminService(
      db,
      new PlatformSecretService({ keyProvider }),
      {
        connectionProbe: async () => {
          throw {
            endpoint: 'https://chatgpt.com/backend-api/codex',
            error: { message: 'Your authentication token has expired', status: 401 },
            errorType: 'OAuthAuthorizationExpired',
            provider: 'chatgpt',
          };
        },
      },
    );
    const created = await runtimeService.createProviderDraft('admin', {
      checkModel: 'chat',
      displayName: 'Runtime shape',
      enabled: true,
      providerKey: 'runtime-shape',
      reason: 'create',
      secret: { operation: 'replace', value: 'runtime-shape-secret' },
      source: 'custom',
    });
    await runtimeService.createModel('admin', {
      enabled: true,
      expectedDraftToken: (await runtimeService.getDetail(created.id)).draftToken,
      modelKey: 'chat',
      providerId: created.id,
      reason: 'add check model',
      type: 'chat',
    });

    await expect(
      runtimeService.testProvider('admin', { id: created.id, reason: 'test runtime shape' }),
    ).resolves.toMatchObject({
      errorCategory: 'auth',
      errorType: 'OAuthAuthorizationExpired',
      sanitizedMessage: 'connection_failed_shared_account_expired',
      status: 'failure',
    });

    const connectionTest = (await runtimeService.getDetail(created.id)).draft.connectionTest;
    expect(connectionTest).toMatchObject({ errorCategory: 'auth', status: 'failure' });
    // Provider prose never reaches storage, whatever the runtime put in the payload.
    expect(JSON.stringify(connectionTest)).not.toContain('authentication token has expired');

    const audits = (await db.select().from(platformAuditLogs)).filter(
      (row) => row.action === 'admin.aiProviders.test' && row.targetId === created.id,
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ result: 'failure' });
  });

  it('reports distinct, actionable reasons for each check-model configuration gap', async () => {
    const probe = vi.fn(async () => {});
    const service = new AiCatalogAdminService(db, new PlatformSecretService({ keyProvider }), {
      connectionProbe: probe,
    });
    const created = await service.createProviderDraft('admin', {
      displayName: 'Reasons',
      enabled: true,
      providerKey: 'check-model-reasons',
      reason: 'create',
      secret: { operation: 'replace', value: 'reasons-secret' },
      source: 'custom',
    });

    // 1. Nothing configured to probe.
    await expect(
      service.testProvider('admin', { id: created.id, reason: 'no check model' }),
    ).resolves.toMatchObject({
      errorCategory: 'invalid_config',
      sanitizedMessage: 'Check model not configured',
      status: 'failure',
    });

    // 2. Configured, but not a model of this provider yet (the OAuth first-connect case).
    await service.updateProviderDraft('admin', {
      checkModel: 'chat',
      expectedDraftToken: (await service.getDetail(created.id)).draftToken,
      expectedRevision: 0,
      id: created.id,
      reason: 'set check model',
    });
    await expect(
      service.testProvider('admin', { id: created.id, reason: 'not materialized' }),
    ).resolves.toMatchObject({ sanitizedMessage: 'Check model not enabled' });

    // 3. Materialized but disabled — same fix for the operator, same code.
    const model = await service.createModel('admin', {
      enabled: false,
      expectedDraftToken: (await service.getDetail(created.id)).draftToken,
      modelKey: 'chat',
      providerId: created.id,
      reason: 'add disabled model',
      type: 'chat',
    });
    await expect(
      service.testProvider('admin', { id: created.id, reason: 'disabled model' }),
    ).resolves.toMatchObject({ sanitizedMessage: 'Check model not enabled' });
    expect(probe).not.toHaveBeenCalled();

    // 4. Enabled but not a chat model.
    await service.updateModel('admin', {
      enabled: true,
      expectedDraftToken: (await service.getDetail(created.id)).draftToken,
      expectedRevision: 0,
      id: model.id,
      providerId: created.id,
      reason: 'enable as embedding',
      type: 'embedding',
    });
    await expect(
      service.testProvider('admin', { id: created.id, reason: 'not chat' }),
    ).resolves.toMatchObject({ sanitizedMessage: 'Check model is not a chat model' });
    expect(probe).not.toHaveBeenCalled();

    // 5. Everything in place — the probe finally runs.
    await service.updateModel('admin', {
      expectedDraftToken: (await service.getDetail(created.id)).draftToken,
      expectedRevision: 0,
      id: model.id,
      providerId: created.id,
      reason: 'back to chat',
      type: 'chat',
    });
    await expect(
      service.testProvider('admin', { id: created.id, reason: 'ready' }),
    ).resolves.toMatchObject({ status: 'success' });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('still probes when the proactive shared-OAuth refresh fails transiently', async () => {
    // Refresh fires ~2min BEFORE expiry, so the stored access token is normally still valid.
    // A token-endpoint blip must not be reported as a provider configuration error.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('token endpoint unreachable');
    }) as typeof fetch;
    try {
      const probe = vi.fn(async (_params: { keyVaults: Record<string, unknown> }) => {});
      const service = new AiCatalogAdminService(db, new PlatformSecretService({ keyProvider }), {
        connectionProbe: probe,
      });
      const created = await service.createProviderDraft('admin', {
        checkModel: 'grok-chat',
        displayName: 'Shared grok',
        enabled: true,
        providerKey: 'supergrok',
        reason: 'create',
        secret: {
          operation: 'replace',
          value: {
            oauthAccessToken: 'at-expiring',
            oauthRefreshToken: 'rt-expiring',
            // Inside the 120s proactive window: a refresh is attempted and will fail.
            oauthTokenExpiresAt: String(Date.now() + 30_000),
          },
        },
        source: 'builtin',
      });
      await service.createModel('admin', {
        enabled: true,
        expectedDraftToken: (await service.getDetail(created.id)).draftToken,
        modelKey: 'grok-chat',
        providerId: created.id,
        reason: 'add model',
        type: 'chat',
      });

      await expect(
        service.testProvider('admin', { id: created.id, reason: 'probe despite refresh blip' }),
      ).resolves.toMatchObject({ errorCategory: null, status: 'success' });
      // The probe really ran, on the stored (still valid) access token.
      expect(probe).toHaveBeenCalledTimes(1);
      expect(probe.mock.calls[0]?.[0]).toMatchObject({
        keyVaults: expect.objectContaining({ oauthAccessToken: 'at-expiring' }),
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('reports a dead shared grant with the stable reconnect code, never English prose', async () => {
    // The pre-probe refresh is the ONLY path that can prove the shared account is dead before
    // a request is even attempted. It used to mint an English sentence that every locale
    // rendered verbatim, and carried no runtime code for the UI to key reconnect guidance off.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), {
        headers: { 'content-type': 'application/json' },
        status: 400,
      })) as typeof fetch;
    try {
      const probe = vi.fn(async () => {});
      const service = new AiCatalogAdminService(db, new PlatformSecretService({ keyProvider }), {
        connectionProbe: probe,
      });
      const created = await service.createProviderDraft('admin', {
        checkModel: 'grok-chat',
        displayName: 'Dead shared grok',
        enabled: true,
        providerKey: 'supergrok',
        reason: 'create',
        secret: {
          operation: 'replace',
          value: {
            oauthAccessToken: 'at-dead',
            oauthRefreshToken: 'rt-dead',
            // Inside the proactive refresh window, so the token endpoint is really called.
            oauthTokenExpiresAt: String(Date.now() + 30_000),
          },
        },
        source: 'builtin',
      });
      await service.createModel('admin', {
        enabled: true,
        expectedDraftToken: (await service.getDetail(created.id)).draftToken,
        modelKey: 'grok-chat',
        providerId: created.id,
        reason: 'add model',
        type: 'chat',
      });

      await expect(
        service.testProvider('admin', { id: created.id, reason: 'probe a dead grant' }),
      ).resolves.toMatchObject({
        errorCategory: 'auth',
        errorType: 'OAuthAuthorizationExpired',
        sanitizedMessage: 'connection_failed_shared_account_expired',
        status: 'failure',
      });
      // Terminal: a dead grant is never handed to the probe as if it might work.
      expect(probe).not.toHaveBeenCalled();

      const connectionTest = (await service.getDetail(created.id)).draft.connectionTest;
      expect(connectionTest).toMatchObject({
        errorCategory: 'auth',
        sanitizedMessage: 'connection_failed_shared_account_expired',
        status: 'failure',
      });
      expect(JSON.stringify(connectionTest)).not.toContain('rt-dead');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('replays the shared-account reconnect code to a superseded concurrent attempt', async () => {
    // Two admin tabs. `errorType` is deliberately NOT persisted, so the losing attempt can only
    // replay the stored code — which is exactly why the dead grant has its own code instead of
    // the generic `auth` one.
    const createProbe = () => {
      let entered!: () => void;
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const enteredPromise = new Promise<void>((done) => {
        entered = done;
      });
      const promise = new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      return { entered, enteredPromise, promise, reject, resolve };
    };
    const first = createProbe();
    const second = createProbe();
    const probes = [first, second];
    let probeIndex = 0;
    const service = new AiCatalogAdminService(db, new PlatformSecretService({ keyProvider }), {
      connectionProbe: async () => {
        const probe = probes[probeIndex++];
        probe.entered();
        await probe.promise;
      },
    });
    const created = await service.createProviderDraft('admin', {
      checkModel: 'chat',
      displayName: 'Concurrent shared',
      enabled: true,
      providerKey: 'concurrent-shared',
      reason: 'create',
      secret: { operation: 'replace', value: 'concurrent-shared-secret' },
      source: 'custom',
    });
    await service.createModel('admin', {
      enabled: true,
      expectedDraftToken: (await service.getDetail(created.id)).draftToken,
      modelKey: 'chat',
      providerId: created.id,
      reason: 'add check model',
      type: 'chat',
    });

    const oldAttempt = service.testProvider('admin', { id: created.id, reason: 'old' });
    await first.enteredPromise;
    const newAttempt = service.testProvider('admin', { id: created.id, reason: 'new' });
    await second.enteredPromise;
    // The winner finds the shared grant dead.
    second.reject({
      error: { message: 'The shared provider connection has expired' },
      errorType: 'OAuthAuthorizationExpired',
    });
    await expect(newAttempt).resolves.toMatchObject({
      errorCategory: 'auth',
      errorType: 'OAuthAuthorizationExpired',
      sanitizedMessage: 'connection_failed_shared_account_expired',
      status: 'failure',
    });

    first.resolve();
    // The superseded attempt returns authoritative persisted state — still actionable.
    await expect(oldAttempt).resolves.toMatchObject({
      errorCategory: 'auth',
      sanitizedMessage: 'connection_failed_shared_account_expired',
      status: 'failure',
    });
  });

  it('probes an operator-selected model override without persisting it as checkModel', async () => {
    const probed: string[] = [];
    const service = new AiCatalogAdminService(db, new PlatformSecretService({ keyProvider }), {
      connectionProbe: async () => {},
    });
    const created = await service.createProviderDraft('admin', {
      checkModel: 'chat-a',
      displayName: 'Override',
      enabled: true,
      providerKey: 'check-model-override',
      reason: 'create',
      secret: { operation: 'replace', value: 'override-secret' },
      source: 'custom',
    });
    for (const modelKey of ['chat-a', 'chat-b']) {
      await service.createModel('admin', {
        enabled: true,
        expectedDraftToken: (await service.getDetail(created.id)).draftToken,
        modelKey,
        providerId: created.id,
        reason: `add ${modelKey}`,
        type: 'chat',
      });
    }

    const probeService = new AiCatalogAdminService(db, new PlatformSecretService({ keyProvider }), {
      connectionProbe: async () => {},
    });
    // The service passes the resolved model to the probe; capture it through the seam.
    (probeService as unknown as { connectionTests: { test: unknown } }).connectionTests = {
      test: async ({ model }: { model: string }) => {
        probed.push(model);
        return {
          errorCategory: null,
          latencyMs: 1,
          sanitizedMessage: 'ok',
          status: 'success' as const,
          testedAt: new Date(),
        };
      },
    };

    await expect(
      probeService.testProvider('admin', {
        id: created.id,
        model: 'chat-b',
        reason: 'probe the selected model',
      }),
    ).resolves.toMatchObject({ status: 'success' });
    expect(probed).toEqual(['chat-b']);
    // Override is probe-only: the stored check model is untouched.
    expect((await service.getDetail(created.id)).draft.checkModel).toBe('chat-a');

    // An override that is not an enabled model of this provider is refused, not probed.
    await expect(
      probeService.testProvider('admin', {
        id: created.id,
        model: 'chat-missing',
        reason: 'probe an unknown model',
      }),
    ).resolves.toMatchObject({ sanitizedMessage: 'Check model not enabled' });
    expect(probed).toEqual(['chat-b']);
  });

  it('creates and reads a secret-safe draft with a CAS token and success audit', async () => {
    const credential = 'plaincredentialvalue-without-known-prefix';
    const created = await service.createProviderDraft('admin', {
      displayName: 'Alpha',
      enabled: true,
      providerKey: 'alpha',
      reason: `create provider ${credential}`,
      secret: { operation: 'replace', value: credential },
      source: 'custom',
    });
    expect(created.secret).toMatchObject({ configured: true });
    expect(created.secret).not.toHaveProperty('fingerprint');
    expect(JSON.stringify(created)).not.toContain(credential);

    const [stored] = await db.select().from(platformAiProviders);
    const [immutable] = await db.select().from(platformAiProviderSecrets);
    expect(stored.encryptedKeyVaults).toMatch(/^aihub\.secret\.v1\./);
    expect(stored.encryptedKeyVaults).not.toContain(credential);
    expect(stored.secretKeyId).toBe('draft-test');
    expect(immutable.keyId).toBe('draft-test');
    expect(stored.secretFingerprint).not.toBe(stored.secretKeyId);

    const detail = await service.getDetail(created.id);
    expect(detail.baseRevision).toBe(0);
    expect(detail.draftToken).toHaveLength(64);
    expect(detail.published).toBeNull();
    const audits = await db.select().from(platformAuditLogs);
    expect(audits).toContainEqual(
      expect.objectContaining({ action: 'admin.aiProviders.createDraft', result: 'success' }),
    );
    expect(JSON.stringify(audits)).not.toContain(credential);
  });

  it('fails the connection probe for a non-chat check model without blocking publish', async () => {
    const probe = vi.fn(async () => {});
    const unsupportedService = new AiCatalogAdminService(
      db,
      new PlatformSecretService({ keyProvider }),
      { connectionProbe: probe },
    );
    const created = await unsupportedService.createProviderDraft('admin', {
      checkModel: 'embed-only',
      displayName: 'Embedding only',
      enabled: true,
      providerKey: 'embedding-only',
      reason: 'create',
      secret: { operation: 'replace', value: 'embedding-secret' },
      source: 'custom',
    });
    await unsupportedService.createModel('admin', {
      enabled: true,
      expectedDraftToken: (await unsupportedService.getDetail(created.id)).draftToken,
      modelKey: 'embed-only',
      providerId: created.id,
      reason: 'embedding model',
      type: 'embedding',
    });

    await expect(
      unsupportedService.testProvider('admin', { id: created.id, reason: 'test unsupported' }),
    ).resolves.toMatchObject({ errorCategory: 'invalid_config', status: 'failure' });
    expect(probe).not.toHaveBeenCalled();
    const detail = await unsupportedService.getDetail(created.id);
    // The manual health check is advisory only — it never gates publish any more.
    await expect(
      unsupportedService.publishProvider('admin', {
        expectedDraftToken: detail.draftToken,
        expectedRevision: 0,
        id: created.id,
        reason: 'publishes despite a failed probe',
      }),
    ).resolves.toMatchObject({ revision: 1 });
  });

  it('enforces draft token/revision CAS and preserves or clears secrets explicitly', async () => {
    const created = await service.createProviderDraft('admin', {
      displayName: 'Alpha',
      providerKey: 'alpha',
      reason: 'create provider',
      secret: { operation: 'replace', value: 'fake-api-key' },
      source: 'custom',
    });
    const before = await service.getDetail(created.id);
    const kept = await service.updateProviderDraft('admin', {
      displayName: 'Alpha 2',
      expectedDraftToken: before.draftToken,
      expectedRevision: 0,
      id: created.id,
      reason: 'rename',
      secret: { operation: 'keep' },
    });
    // Client DTO keeps secret configured; fingerprint is server-internal and must be absent.
    expect(kept.secret).toEqual(
      expect.objectContaining({ configured: true, updatedAt: expect.anything() }),
    );
    expect(kept.secret).not.toHaveProperty('fingerprint');
    expect(before.draft.secret).not.toHaveProperty('fingerprint');

    await expect(
      service.updateProviderDraft('admin', {
        displayName: 'stale overwrite',
        expectedDraftToken: before.draftToken,
        expectedRevision: 0,
        id: created.id,
        reason: 'stale',
      }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);
    expect((await service.getDetail(created.id)).draft.displayName).toBe('Alpha 2');

    const fresh = await service.getDetail(created.id);
    const cleared = await service.updateProviderDraft('admin', {
      expectedDraftToken: fresh.draftToken,
      expectedRevision: 0,
      id: created.id,
      reason: 'clear secret',
      secret: { operation: 'clear' },
    });
    expect(cleared.secret).toEqual({ configured: false, updatedAt: null });
    expect(cleared.secret).not.toHaveProperty('fingerprint');
    const [clearedRow] = await db.select().from(platformAiProviders);
    expect(clearedRow.encryptedKeyVaults).toBeNull();
    expect(clearedRow.secretKeyId).toBeNull();
    expect(await db.select().from(platformAuditLogs)).toContainEqual(
      expect.objectContaining({ action: 'admin.aiProviders.updateDraft', result: 'failure' }),
    );
  });
});
