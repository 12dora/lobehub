// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as platformModels from '@/database/models/platform';
import { checksumPayload } from '@/database/models/platform';

import {
  loadCurrentAiCatalogSnapshot,
  resetAiCatalogSnapshotCacheForTest,
} from './catalogAuthority';
import { aiCatalogAuthorityToken, invalidateAiCatalogAuthorityToken } from './catalogTokens';

const peekGeneration = vi.hoisted(() =>
  vi.fn(async () => ({
    generation: 1,
    tokenKind: 'immutable_id',
    tokenValue: '0'.repeat(64),
  })),
);

vi.mock('@/database/models/platform/catalogAuthority', () => ({
  PlatformCatalogAuthorityModel: class {
    peekGeneration = peekGeneration;
  },
}));

vi.mock('@/database/models/platform', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    PlatformCatalogAuthorityModel: class {
      peekGeneration = peekGeneration;
    },
  };
});

const makeRow = (providerId: string, revision: number, displayName: string) => {
  const payload = {
    models: [{ enabled: true, modelKey: 'gpt', type: 'chat' }],
    provider: {
      displayName,
      enabled: true,
      providerKey: providerId,
    },
  };
  return {
    pointerRevision: revision,
    providerId,
    providerKey: providerId,
    revision: {
      checksum: checksumPayload(payload),
      payload,
      resourceId: providerId,
      resourceType: 'provider' as const,
      revision,
      secretFingerprint: null,
      status: 'published' as const,
    },
  };
};

const createDb = (rows: unknown[]) => {
  let selectCount = 0;
  const chain = {
    from: () => chain,
    leftJoin: () => chain,
    orderBy: async () => rows,
    select: () => {
      selectCount += 1;
      return chain;
    },
    where: () => chain,
  };
  return {
    db: chain as never,
    get selectCount() {
      return selectCount;
    },
  };
};

describe('loadCurrentAiCatalogSnapshot cache', () => {
  beforeEach(() => {
    aiCatalogAuthorityToken.clear();
    resetAiCatalogSnapshotCacheForTest();
    peekGeneration.mockReset();
    peekGeneration.mockResolvedValue({
      generation: 1,
      tokenKind: 'immutable_id',
      tokenValue: '0'.repeat(64),
    });
  });

  afterEach(() => {
    resetAiCatalogSnapshotCacheForTest();
    aiCatalogAuthorityToken.clear();
    vi.restoreAllMocks();
  });

  it('returns the same snapshot twice without a second payload join', async () => {
    const rows = [makeRow('openai', 3, 'OpenAI')];
    const created = createDb(rows);

    const first = await loadCurrentAiCatalogSnapshot(created.db);
    const before = created.selectCount;
    const second = await loadCurrentAiCatalogSnapshot(created.db);

    expect(second).toBe(first);
    expect(second.revisions).toHaveLength(1);
    // Cheap pointer-identity select only — no revision/payload join.
    expect(created.selectCount).toBe(before + 1);
  });

  it('does not serve a cached snapshot when pointers move at the same generation', async () => {
    const v2 = makeRow('openai', 4, 'OpenAI v2');
    const firstDb = createDb([v2]);
    const first = await loadCurrentAiCatalogSnapshot(firstDb.db);
    expect(first.revisions[0]?.revision).toBe(4);

    const rolledBack = makeRow('openai', 3, 'OpenAI');
    const next = await loadCurrentAiCatalogSnapshot(createDb([rolledBack]).db);
    expect(next.revisions[0]?.revision).toBe(3);
    expect(next).not.toBe(first);
  });

  it('does not populate the process slot from an open transaction', async () => {
    const rows = [makeRow('openai', 3, 'OpenAI')];
    const tx = Object.assign(createDb(rows).db as object, { rollback: () => undefined });
    await loadCurrentAiCatalogSnapshot(tx as never);

    const empty = createDb([]);
    const committed = await loadCurrentAiCatalogSnapshot(empty.db);
    expect(committed.revisions).toHaveLength(0);
  });

  it('rehashes only when the pointer revision changes', async () => {
    const checksumSpy = vi.spyOn(platformModels, 'checksumPayload');
    const v1 = makeRow('openai', 3, 'OpenAI');
    const firstDb = createDb([v1]);
    await loadCurrentAiCatalogSnapshot(firstDb.db);
    const hashesAfterFirst = checksumSpy.mock.calls.length;

    const v1Again = createDb([v1]);
    invalidateAiCatalogAuthorityToken();
    peekGeneration.mockResolvedValue({
      generation: 2,
      tokenKind: 'immutable_id',
      tokenValue: '1'.repeat(64),
    });
    await loadCurrentAiCatalogSnapshot(v1Again.db);
    expect(checksumSpy.mock.calls.length).toBe(hashesAfterFirst);

    const v2 = makeRow('openai', 4, 'OpenAI v2');
    invalidateAiCatalogAuthorityToken();
    peekGeneration.mockResolvedValue({
      generation: 3,
      tokenKind: 'immutable_id',
      tokenValue: '2'.repeat(64),
    });
    const next = await loadCurrentAiCatalogSnapshot(createDb([v2]).db);
    expect(next.revisions[0]?.revision).toBe(4);
    expect(checksumSpy.mock.calls.length).toBeGreaterThan(hashesAfterFirst);
  });

  it('rejects when peekGeneration throws instead of serving generation 0', async () => {
    peekGeneration.mockRejectedValueOnce(new Error('relation does not exist'));
    const { db } = createDb([makeRow('openai', 3, 'OpenAI')]);
    await expect(loadCurrentAiCatalogSnapshot(db)).rejects.toThrow('relation does not exist');
  });
});
