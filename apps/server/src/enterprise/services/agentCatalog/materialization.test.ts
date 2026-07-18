import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ExactPlatformAgentVersion,
  PlatformAgentCatalogRepository,
} from '@/database/repositories/platformAgentCatalog';
import { PlatformAgentMaterializationRaceError } from '@/database/repositories/platformAgentCatalog';
import type { LobeChatDatabase } from '@/database/type';

import type { PlatformAgentOperationSnapshot } from './effectiveResolver';
import { PlatformAgentMaterializationError, PlatformAgentNotFoundError } from './errors';
import { PlatformAgentMaterializationService } from './materialization';

const CHECKSUM = 'a'.repeat(64);

const config = (displayName: string): PlatformAgentOperationSnapshot['config'] => ({
  avatar: 'avatar.png',
  backgroundColor: '#123456',
  description: 'desc',
  displayName,
  modelParameters: { maxTokens: 4096, temperature: 0.4, topP: 0.9 },
  openingMessage: 'hi',
  openingQuestions: ['q1'],
  systemRole: 'Use approved sources.',
  tags: ['t1'],
});

const snapshot = (
  overrides: Partial<PlatformAgentOperationSnapshot> = {},
): PlatformAgentOperationSnapshot => ({
  checksum: CHECKSUM,
  config: config('Research Agent'),
  platformAgentId: 'pagt_1',
  versionId: 'pav_1',
  ...overrides,
});

const exactVersion = (
  overrides: Partial<ExactPlatformAgentVersion> = {},
): ExactPlatformAgentVersion =>
  ({
    agentId: 'pagt_1',
    checksum: CHECKSUM,
    config: config('Research Agent'),
    createdAt: new Date(),
    createdBy: null,
    dependencySnapshot: {
      connectors: [
        {
          allowedToolKeys: ['x.y'],
          connectorId: 'c1',
          connectorKey: 'internal.search',
          publishedChecksum: 'c'.repeat(64),
          publishedRevision: 1,
        },
      ],
      model: {
        modelKey: 'chat-model',
        providerChecksum: 'b'.repeat(64),
        providerKey: 'internal-provider',
        providerRevision: 1,
      },
      skills: [{ checksum: 'd'.repeat(64), skillKey: 'research', version: '1.0.0' }],
    },
    id: 'pav_1',
    version: '1.0.0',
    ...overrides,
  }) as ExactPlatformAgentVersion;

const makeService = (repo: Partial<PlatformAgentCatalogRepository>) =>
  new PlatformAgentMaterializationService(
    {} as LobeChatDatabase,
    'user-a',
    repo as PlatformAgentCatalogRepository,
  );

describe('PlatformAgentMaterializationService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps the pinned snapshot to a runtime config bound to the materialized Agent id', async () => {
    const service = makeService({
      getExactVersion: vi.fn(async () => exactVersion()),
      materializeLocalAgent: vi.fn(
        async () => ({ agentId: 'agt_new', created: true, ok: true }) as const,
      ),
    });

    const { agentId, config: runtime } = await service.materializeForOperation(snapshot());

    expect(agentId).toBe('agt_new');
    // Config authority is the snapshot + exact version model ref — never a local-row read.
    expect(runtime).toMatchObject({
      avatar: 'avatar.png',
      id: 'agt_new',
      model: 'chat-model',
      openingMessage: 'hi',
      openingQuestions: ['q1'],
      provider: 'internal-provider',
      slug: null,
      systemRole: 'Use approved sources.',
      title: 'Research Agent',
    });
    // camelCase managed params are lowered to the runtime snake_case shape.
    expect(runtime.params).toMatchObject({ max_tokens: 4096, temperature: 0.4, top_p: 0.9 });
  });

  it('reuses an existing local Agent id without creating a second one, still config from snapshot', async () => {
    const materializeLocalAgent = vi.fn(async () => ({
      agentId: 'agt_existing',
      created: false,
      ok: true as const,
    }));
    const service = makeService({
      getExactVersion: vi.fn(async () => exactVersion()),
      materializeLocalAgent,
    });

    const result = await service.materializeForOperation(snapshot());
    expect(result.agentId).toBe('agt_existing');
    expect(result.config.id).toBe('agt_existing');
    expect(result.config.title).toBe('Research Agent');
  });

  it('pins each operation to its OWN captured snapshot (v1 stays v1 after v2 exists)', async () => {
    // The runtime config is built ONLY from the snapshot captured by beginOperation, and the exact
    // version is fetched by (platformAgentId, versionId). A v1 operation therefore keeps its v1
    // config even once v2 has been published — nothing re-resolves latest mid-operation.
    const getExactVersion = vi.fn(async (_agentId: string, versionId: string) =>
      exactVersion({ id: versionId }),
    );
    const service = makeService({
      getExactVersion,
      materializeLocalAgent: vi.fn(
        async () => ({ agentId: 'agt_1', created: true, ok: true }) as const,
      ),
    });

    const v1 = await service.materializeForOperation(
      snapshot({ config: config('Agent v1'), versionId: 'pav_1' }),
    );
    const v2 = await service.materializeForOperation(
      snapshot({ config: config('Agent v2'), versionId: 'pav_2' }),
    );
    expect(v1.config.title).toBe('Agent v1');
    expect(v2.config.title).toBe('Agent v2');
    expect(getExactVersion).toHaveBeenNthCalledWith(1, 'pagt_1', 'pav_1');
    expect(getExactVersion).toHaveBeenNthCalledWith(2, 'pagt_1', 'pav_2');
  });

  it('fails closed when the exact pinned version is missing', async () => {
    const service = makeService({ getExactVersion: vi.fn(async () => undefined) });
    await expect(service.materializeForOperation(snapshot())).rejects.toBeInstanceOf(
      PlatformAgentMaterializationError,
    );
  });

  it('fails closed on a checksum mismatch (tampered / stale pin)', async () => {
    const service = makeService({
      getExactVersion: vi.fn(async () => exactVersion({ checksum: 'e'.repeat(64) })),
    });
    await expect(service.materializeForOperation(snapshot())).rejects.toBeInstanceOf(
      PlatformAgentMaterializationError,
    );
  });

  it('fails closed on a malformed model reference', async () => {
    const service = makeService({
      getExactVersion: vi.fn(async () =>
        exactVersion({
          dependencySnapshot: {
            connectors: [],
            model: { modelKey: '', providerChecksum: 'z', providerKey: '', providerRevision: 1 },
            skills: [],
          },
        }),
      ),
    });
    await expect(service.materializeForOperation(snapshot())).rejects.toBeInstanceOf(
      PlatformAgentMaterializationError,
    );
  });

  it('maps an archived Agent (lost archive race) to NotFound — not entitled', async () => {
    const service = makeService({
      getExactVersion: vi.fn(async () => exactVersion()),
      materializeLocalAgent: vi.fn(async () => ({
        ok: false as const,
        reason: 'archived' as const,
      })),
    });
    await expect(service.materializeForOperation(snapshot())).rejects.toBeInstanceOf(
      PlatformAgentNotFoundError,
    );
  });

  it('recovers from the rollback race by reusing the winning owner-scoped mapping', async () => {
    const service = makeService({
      getExactVersion: vi.fn(async () => exactVersion()),
      getMaterialization: vi.fn(async () => ({ materializedAgentId: 'agt_winner' }) as never),
      materializeLocalAgent: vi.fn(async () => {
        throw new PlatformAgentMaterializationRaceError();
      }),
    });
    const result = await service.materializeForOperation(snapshot());
    expect(result.agentId).toBe('agt_winner');
  });

  it('redacts a raw DB failure into a stable materialization error', async () => {
    const service = makeService({
      getExactVersion: vi.fn(async () => exactVersion()),
      materializeLocalAgent: vi.fn(async () => {
        throw new Error('duplicate key value violates unique constraint "…"');
      }),
    });
    await expect(service.materializeForOperation(snapshot())).rejects.toBeInstanceOf(
      PlatformAgentMaterializationError,
    );
  });

  describe('materializeFromPin (resume replay)', () => {
    const pin = { checksum: CHECKSUM, platformAgentId: 'pagt_1', versionId: 'pav_1' };

    it('re-derives the pinned config from the exact version and reuses the local Agent', async () => {
      const service = makeService({
        getExactVersion: vi.fn(async () => exactVersion()),
        materializeLocalAgent: vi.fn(async () => ({
          agentId: 'agt_reuse',
          created: false,
          ok: true as const,
        })),
      });
      const result = await service.materializeFromPin(pin);
      expect(result.agentId).toBe('agt_reuse');
      expect(result.config.title).toBe('Research Agent');
    });

    it('fails closed when the pinned version is missing', async () => {
      const service = makeService({ getExactVersion: vi.fn(async () => undefined) });
      await expect(service.materializeFromPin(pin)).rejects.toBeInstanceOf(
        PlatformAgentMaterializationError,
      );
    });

    it('fails closed when the persisted pin checksum no longer matches the version (tampered)', async () => {
      const service = makeService({
        getExactVersion: vi.fn(async () => exactVersion({ checksum: 'f'.repeat(64) })),
      });
      await expect(service.materializeFromPin(pin)).rejects.toBeInstanceOf(
        PlatformAgentMaterializationError,
      );
    });
  });

  it('redacts a raw driver error from the exact-version read (REWORK-5)', async () => {
    const service = makeService({
      getExactVersion: vi.fn(async () => {
        throw Object.assign(
          new Error('error: column "checksum" does not exist for provider acme-secret'),
          { code: '42703', severity: 'ERROR' },
        );
      }),
    });
    const error = await service.materializeForOperation(snapshot()).then(
      () => null,
      (e) => e,
    );
    expect(error).toBeInstanceOf(PlatformAgentMaterializationError);
    expect(`${(error as Error).message} ${JSON.stringify(error)}`).not.toMatch(
      /does not exist|acme-secret|42703|checksum/,
    );
  });
});
