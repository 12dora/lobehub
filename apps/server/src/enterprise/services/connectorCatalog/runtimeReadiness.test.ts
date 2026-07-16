// @vitest-environment node
import { randomUUID } from 'node:crypto';

import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { checksumPayload } from '@/database/models/platform';
import {
  PlatformConnectorCatalogRepository,
  type PlatformConnectorRevisionPayload,
} from '@/database/repositories/platformConnectorCatalog';
import {
  platformConnectors,
  platformConnectorSecrets,
  platformResourceRevisions,
} from '@/database/schemas/platform';
import type { PlatformConnectorCredentialMode } from '@/database/schemas/platform/connectors';
import type { LobeChatDatabase } from '@/database/type';

import { PlatformSecretService } from '../../security/secret';
import { ConnectorCatalogReadService } from './catalogSnapshot';
import { ensurePendingM09ServiceSchema } from './catalogTestUtils';
import type { ConnectorOAuthRuntimeEnv } from './oauthRuntime';
import { getConnectorOAuthRuntime } from './oauthRuntime';
import { resolveConnectorCatalogRuntimeReadiness } from './runtimeReadiness';

const masterKey = Buffer.alloc(32, 8).toString('base64');
const wrongMasterKey = Buffer.alloc(32, 9).toString('base64');
const env = {
  APP_URL: 'https://aihub.example.test',
  ENABLE_PLATFORM_MANAGED_CONNECTORS: '1',
  PLATFORM_MASTER_KEY: masterKey,
} satisfies ConnectorOAuthRuntimeEnv;

let db: LobeChatDatabase;
const connectorIds: string[] = [];

beforeAll(async () => {
  db = await getTestDB();
  await ensurePendingM09ServiceSchema(db);
});

afterAll(async () => {
  if (connectorIds.length === 0) return;
  await db
    .delete(platformConnectorSecrets)
    .where(inArray(platformConnectorSecrets.connectorId, connectorIds));
  await db.delete(platformConnectors).where(inArray(platformConnectors.id, connectorIds));
  await db
    .delete(platformResourceRevisions)
    .where(inArray(platformResourceRevisions.resourceId, connectorIds));
});

const publish = async (
  mode: PlatformConnectorCredentialMode,
  options: { persistSecret?: boolean } = {},
) => {
  const id = `m09-readiness-${randomUUID()}`;
  connectorIds.push(id);
  const repository = new PlatformConnectorCatalogRepository(db);
  const oauthConfig =
    mode === 'per_user_oauth'
      ? {
          authorizationEndpoint: 'https://identity.example.test/authorize',
          clientId: 'readiness-client',
          issuer: 'https://identity.example.test',
          redirectUri: 'https://aihub.example.test/oauth/connector/callback',
          scopes: ['read'],
          tokenEndpoint: 'https://identity.example.test/token',
        }
      : null;
  await repository.createConnector({
    connectorKey: id.slice(0, 64),
    credentialMode: mode,
    displayName: id,
    enabled: true,
    endpoint: 'https://connector.example.test/mcp',
    id,
    oauthConfig,
  });

  const slot = mode === 'shared_service_account' ? 'sharedSecret' : 'oauthClientSecret';
  const shouldConfigureSecret = mode !== 'none';
  const stored =
    shouldConfigureSecret && options.persistSecret !== false
      ? await getConnectorOAuthRuntime(db, env).secrets.persistSecret({
          connectorId: id,
          slot,
          value:
            mode === 'shared_service_account' ? { apiKey: 'shared-readiness-key' } : 'client-key',
        })
      : shouldConfigureSecret
        ? {
            fingerprint: 'a'.repeat(64),
            ref: `kms://platform-connectors/${id}/${slot}/missing`,
            updatedAt: new Date(),
          }
        : null;
  if (stored) {
    await db
      .update(platformConnectors)
      .set(
        mode === 'shared_service_account'
          ? {
              sharedSecretFingerprint: stored.fingerprint,
              sharedSecretRef: stored.ref,
              sharedSecretUpdatedAt: stored.updatedAt,
            }
          : {
              oauthClientSecretFingerprint: stored.fingerprint,
              oauthClientSecretRef: stored.ref,
              oauthClientSecretUpdatedAt: stored.updatedAt,
            },
      )
      .where(eq(platformConnectors.id, id));
  }
  const payload: PlatformConnectorRevisionPayload = {
    connector: {
      credentialMode: mode,
      description: null,
      displayName: id,
      enabled: true,
      endpoint: 'https://connector.example.test/mcp',
      id,
      key: id.slice(0, 64),
      oauthClientSecretConfigured: mode === 'per_user_oauth' && stored !== null,
      oauthClientSecretFingerprint:
        mode === 'per_user_oauth' ? (stored?.fingerprint ?? null) : null,
      oauthConfig,
      sharedSecretConfigured: mode === 'shared_service_account',
      sharedSecretFingerprint:
        mode === 'shared_service_account' ? (stored?.fingerprint ?? null) : null,
      sort: 0,
      transport: 'http',
    },
    schemaVersion: 'm09-v1',
    tools: [],
  };
  const checksum = checksumPayload(payload);
  await repository.createPublishedRevision({
    checksum,
    connectorId: id,
    payload,
    publishedAt: new Date(),
    publishedBy: 'readiness-admin',
    revision: 1,
  });
  await repository.setPublishedPointerCas({
    checksum,
    connectorId: id,
    expectedRevision: 0,
    publishedAt: new Date(),
    publishedRevision: 1,
  });
  const connector = await repository.getConnector(id);
  if (!connector) throw new Error('connector fixture missing');
  return { connector, stored };
};

const listedRepository = (items: Awaited<ReturnType<typeof publish>>['connector'][]) => ({
  listConnectors: vi.fn().mockResolvedValue({ items, nextCursor: null }),
});

describe('resolveConnectorCatalogRuntimeReadiness', () => {
  it('accepts a published none-mode connector after table and envelope probes', async () => {
    const fixture = await publish('none');
    await expect(
      resolveConnectorCatalogRuntimeReadiness({
        db,
        env,
        repository: listedRepository([fixture.connector]),
      }),
    ).resolves.toBe(true);
  });

  it('resolves exact shared and configured OAuth secret fingerprints without outbound I/O', async () => {
    const shared = await publish('shared_service_account');
    const oauth = await publish('per_user_oauth');
    await expect(
      resolveConnectorCatalogRuntimeReadiness({
        db,
        env,
        repository: listedRepository([shared.connector, oauth.connector]),
      }),
    ).resolves.toBe(true);
  });

  it('accepts strictly advancing multi-page results', async () => {
    const first = await publish('none');
    const second = await publish('none');
    const repository = {
      listConnectors: vi
        .fn()
        .mockResolvedValueOnce({
          items: [first.connector],
          nextCursor: { connectorKey: 'page-a', id: 'cursor-a' },
        })
        .mockResolvedValueOnce({ items: [second.connector], nextCursor: null }),
    };
    await expect(resolveConnectorCatalogRuntimeReadiness({ db, env, repository })).resolves.toBe(
      true,
    );
    expect(repository.listConnectors).toHaveBeenCalledTimes(2);
    expect(repository.listConnectors).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: { connectorKey: 'page-a', id: 'cursor-a' } }),
    );
  });

  it('rejects A-to-B-to-A cursor cycles and lexicographic regression', async () => {
    const cycleRepository = {
      listConnectors: vi
        .fn()
        .mockResolvedValueOnce({
          items: [],
          nextCursor: { connectorKey: 'a', id: '1' },
        })
        .mockResolvedValueOnce({
          items: [],
          nextCursor: { connectorKey: 'b', id: '1' },
        })
        .mockResolvedValueOnce({
          items: [],
          nextCursor: { connectorKey: 'a', id: '1' },
        }),
    };
    await expect(
      resolveConnectorCatalogRuntimeReadiness({ db, env, repository: cycleRepository }),
    ).resolves.toBe(false);
    expect(cycleRepository.listConnectors).toHaveBeenCalledTimes(3);

    const regressionRepository = {
      listConnectors: vi
        .fn()
        .mockResolvedValueOnce({
          items: [],
          nextCursor: { connectorKey: 'b', id: '2' },
        })
        .mockResolvedValueOnce({
          items: [],
          nextCursor: { connectorKey: 'b', id: '1' },
        }),
    };
    await expect(
      resolveConnectorCatalogRuntimeReadiness({ db, env, repository: regressionRepository }),
    ).resolves.toBe(false);
    expect(regressionRepository.listConnectors).toHaveBeenCalledTimes(2);
  });

  it('fails closed at the total page and item caps', async () => {
    const pageCapRepository = {
      listConnectors: vi.fn(
        async ({ cursor }: Parameters<PlatformConnectorCatalogRepository['listConnectors']>[0]) => {
          const page = cursor && typeof cursor !== 'string' ? Number(cursor.id) + 1 : 1;
          return {
            items: [],
            nextCursor: { connectorKey: 'cap', id: String(page).padStart(3, '0') },
          };
        },
      ),
    };
    await expect(
      resolveConnectorCatalogRuntimeReadiness({ db, env, repository: pageCapRepository }),
    ).resolves.toBe(false);
    expect(pageCapRepository.listConnectors).toHaveBeenCalledTimes(100);

    const fixture = await publish('none');
    const getSnapshot = vi.fn();
    const itemCapRepository = listedRepository(
      Array.from({ length: 10_001 }, () => fixture.connector),
    );
    await expect(
      resolveConnectorCatalogRuntimeReadiness({
        db,
        env,
        readService: { getSnapshot },
        repository: itemCapRepository,
      }),
    ).resolves.toBe(false);
    expect(getSnapshot).not.toHaveBeenCalled();
  });

  it('loads one shared snapshot and resolves its exact secret once', async () => {
    const fixture = await publish('shared_service_account');
    const runtime = getConnectorOAuthRuntime(db, env);
    const validatedSnapshot = await new ConnectorCatalogReadService(
      db,
      runtime.secrets,
    ).getSnapshot(fixture.connector.id);
    const getSnapshot = vi.fn().mockResolvedValue(validatedSnapshot);
    const resolveSecret = vi.spyOn(runtime.secrets, 'resolveSecretVersion');
    await expect(
      resolveConnectorCatalogRuntimeReadiness({
        db,
        env,
        readService: { getSnapshot },
        repository: listedRepository([fixture.connector]),
        runtime,
      }),
    ).resolves.toBe(true);
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    expect(resolveSecret).toHaveBeenCalledTimes(1);
    expect(resolveSecret).toHaveBeenCalledWith({
      connectorId: fixture.connector.id,
      fingerprint: fixture.stored!.fingerprint,
      slot: 'sharedSecret',
    });
    resolveSecret.mockRestore();
  });

  it('fails closed for a missing secret ref and fingerprint', async () => {
    const fixture = await publish('shared_service_account', { persistSecret: false });
    await expect(
      resolveConnectorCatalogRuntimeReadiness({
        db,
        env,
        repository: listedRepository([fixture.connector]),
      }),
    ).rejects.toThrow();
  });

  it('fails closed for an invalid envelope and plaintext fingerprint mismatch', async () => {
    const invalid = await publish('shared_service_account');
    await db
      .update(platformConnectorSecrets)
      .set({ ciphertext: 'invalid-envelope' })
      .where(eq(platformConnectorSecrets.ref, invalid.stored!.ref));
    await expect(
      resolveConnectorCatalogRuntimeReadiness({
        db,
        env,
        repository: listedRepository([invalid.connector]),
      }),
    ).rejects.toThrow();

    const mismatch = await publish('shared_service_account');
    const secretService = PlatformSecretService.tryFromEnv(env)!;
    await db
      .update(platformConnectorSecrets)
      .set({ ciphertext: await secretService.encrypt(JSON.stringify({ apiKey: 'different' })) })
      .where(eq(platformConnectorSecrets.ref, mismatch.stored!.ref));
    await expect(
      resolveConnectorCatalogRuntimeReadiness({
        db,
        env,
        repository: listedRepository([mismatch.connector]),
      }),
    ).rejects.toThrow();
  });

  it('fails closed with the wrong key or an inaccessible secret table', async () => {
    const fixture = await publish('shared_service_account');
    await expect(
      resolveConnectorCatalogRuntimeReadiness({
        db,
        env: { ...env, PLATFORM_MASTER_KEY: wrongMasterKey },
        repository: listedRepository([fixture.connector]),
      }),
    ).rejects.toThrow();

    const missingTableDb = {
      select: () => ({
        from: () => ({
          limit: async () => {
            throw new Error('relation platform_connector_secrets does not exist');
          },
        }),
      }),
    } as unknown as LobeChatDatabase;
    await expect(
      resolveConnectorCatalogRuntimeReadiness({
        db: missingTableDb,
        env,
        repository: listedRepository([fixture.connector]),
      }),
    ).rejects.toThrow();
  });

  it('is not ready when no published connector exists', async () => {
    await expect(
      resolveConnectorCatalogRuntimeReadiness({ db, env, repository: listedRepository([]) }),
    ).resolves.toBe(false);
  });
});
