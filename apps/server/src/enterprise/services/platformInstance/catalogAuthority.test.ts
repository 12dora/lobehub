// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vitest hoists vi.mock above these imports; kept at top for import-x/first.
import {
  loadCurrentAiCatalogTargetToken,
  loadCurrentSkillCatalogTargetToken,
} from './catalogAuthority';
import {
  aiCatalogAuthorityToken,
  buildAiCatalogRevisionToken,
  buildSkillCatalogRevisionToken,
  PlatformCatalogTokenInvariantError,
  skillCatalogAuthorityToken,
} from './catalogTokens';

const peekGeneration = vi.hoisted(() =>
  vi.fn(async (_domain: string) => ({
    generation: 0,
    tokenKind: 'immutable_id',
    tokenValue: '0'.repeat(64),
  })),
);

vi.mock('@/database/models/platform/catalogAuthority', () => ({
  PlatformCatalogAuthorityModel: class {
    peekGeneration = peekGeneration;
    bumpGeneration = vi.fn();
  },
}));

// Re-export barrel used by loaders may re-export the mock if resolution is shared.
vi.mock('@/database/models/platform', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@/database/models/platform')>();
  return {
    ...actual,
    PlatformCatalogAuthorityModel: class {
      peekGeneration = peekGeneration;
      bumpGeneration = vi.fn();
    },
  };
});

const checksum = (character: string) => character.repeat(64);

/**
 * Mock DB that counts catalog `select` calls. Authority PK peeks go through the
 * mocked PlatformCatalogAuthorityModel.
 */
const createCatalogDb = (rows: unknown[]) => {
  let selectCount = 0;
  const chain = {
    select: () => {
      selectCount += 1;
      return chain;
    },
    from: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    orderBy: async () => rows,
  };
  return {
    db: chain as never,
    get selectCount() {
      return selectCount;
    },
    resetSelectCount: () => {
      selectCount = 0;
    },
  };
};

describe('catalog authority persisted generation reconcile', () => {
  beforeEach(() => {
    aiCatalogAuthorityToken.clear();
    skillCatalogAuthorityToken.clear();
    peekGeneration.mockReset();
    peekGeneration.mockResolvedValue({
      generation: 0,
      tokenKind: 'immutable_id',
      tokenValue: '0'.repeat(64),
    });
  });

  afterEach(() => {
    aiCatalogAuthorityToken.clear();
    skillCatalogAuthorityToken.clear();
    vi.clearAllMocks();
  });

  it('publish-bumped generation forces a second instance to rebuild once; steady-state does zero catalog scans', async () => {
    const catalogRows = [
      {
        checksum: checksum('a'),
        pointerRevision: 1,
        providerId: 'p1',
        providerKey: 'alpha',
        revisionNumber: 1,
        secretFingerprint: null,
        status: 'published' as const,
      },
    ];
    const mock = createCatalogDb(catalogRows);
    peekGeneration.mockResolvedValue({
      generation: 7,
      tokenKind: 'immutable_id',
      tokenValue: checksum('z'),
    });

    const first = await loadCurrentAiCatalogTargetToken(mock.db);
    expect(peekGeneration).toHaveBeenCalledWith('ai_catalog');
    expect(mock.selectCount).toBe(1);
    expect(aiCatalogAuthorityToken.stats.rebuilds).toBe(1);
    expect(aiCatalogAuthorityToken.stats.pkReads).toBe(2);
    expect(first).toEqual(
      buildAiCatalogRevisionToken([
        {
          checksum: checksum('a'),
          providerId: 'p1',
          providerKey: 'alpha',
          revision: 1,
          secretFingerprint: null,
        },
      ]),
    );

    // Steady-state: one PK read per poll, ZERO catalog selects.
    mock.resetSelectCount();
    peekGeneration.mockClear();
    const rebuilds = aiCatalogAuthorityToken.stats.rebuilds;
    const rowsScanned = aiCatalogAuthorityToken.stats.rowsScanned;
    for (let i = 0; i < 25; i += 1) {
      expect(await loadCurrentAiCatalogTargetToken(mock.db)).toEqual(first);
    }
    expect(peekGeneration).toHaveBeenCalledTimes(25);
    expect(mock.selectCount).toBe(0);
    expect(aiCatalogAuthorityToken.stats.rebuilds).toBe(rebuilds);
    expect(aiCatalogAuthorityToken.stats.rowsScanned).toBe(rowsScanned);
    expect(aiCatalogAuthorityToken.stats.pkReads).toBe(27);

    // Second instance (fresh in-memory cache) observes bumped generation via one PK read.
    aiCatalogAuthorityToken.clear();
    const instanceB = createCatalogDb([
      {
        ...catalogRows[0],
        checksum: checksum('b'),
        pointerRevision: 2,
        revisionNumber: 2,
      },
    ]);
    peekGeneration.mockResolvedValue({
      generation: 8,
      tokenKind: 'immutable_id',
      tokenValue: checksum('y'),
    });
    const second = await loadCurrentAiCatalogTargetToken(instanceB.db);
    expect(second.value).not.toBe(first.value);
    expect(instanceB.selectCount).toBe(1);
    expect(aiCatalogAuthorityToken.stats.rebuilds).toBe(1);
    expect(aiCatalogAuthorityToken.stats.pkReads).toBe(2);

    instanceB.resetSelectCount();
    for (let i = 0; i < 10; i += 1) {
      expect(await loadCurrentAiCatalogTargetToken(instanceB.db)).toEqual(second);
    }
    expect(instanceB.selectCount).toBe(0);
  });

  it('skill steady-state does not reconstruct builtins or scan platform rows', async () => {
    peekGeneration.mockResolvedValue({
      generation: 2,
      tokenKind: 'immutable_id',
      tokenValue: checksum('s'),
    });

    const platformRows = [
      {
        checksum: checksum('b'),
        currentVersionId: 'v1',
        pointerRevision: 1,
        publishedEnabled: true,
        publishedTombstone: false,
        publishedVersionId: 'v1',
        revisionNumber: 1,
        skillId: 'skill-1',
        skillKey: 'skill.one',
        status: 'published' as const,
        versionId: 'v1',
      },
    ];
    const mock = createCatalogDb(platformRows);
    const builtinsFactory = vi.fn(() => [
      { checksum: checksum('a'), skillKey: 'builtin.core', version: '1.0.0' },
    ]);

    const first = await loadCurrentSkillCatalogTargetToken(mock.db, builtinsFactory);
    expect(peekGeneration).toHaveBeenCalledWith('skill_catalog');
    expect(builtinsFactory).toHaveBeenCalledTimes(1);
    expect(mock.selectCount).toBe(1);
    expect(first).toEqual(
      buildSkillCatalogRevisionToken({
        builtins: builtinsFactory.mock.results[0]!.value,
        platform: [
          {
            checksum: checksum('b'),
            currentVersionId: 'v1',
            revision: 1,
            skillId: 'skill-1',
            skillKey: 'skill.one',
            tombstone: false,
          },
        ],
      }),
    );

    builtinsFactory.mockClear();
    mock.resetSelectCount();
    peekGeneration.mockClear();
    for (let i = 0; i < 15; i += 1) {
      expect(await loadCurrentSkillCatalogTargetToken(mock.db, builtinsFactory)).toEqual(first);
    }
    expect(peekGeneration).toHaveBeenCalledTimes(15);
    expect(builtinsFactory).not.toHaveBeenCalled();
    expect(mock.selectCount).toBe(0);
    expect(skillCatalogAuthorityToken.stats.rebuilds).toBe(1);
  });

  it('coalesces concurrent cold target misses into one catalog scan', async () => {
    peekGeneration.mockResolvedValue({
      generation: 12,
      tokenKind: 'immutable_id',
      tokenValue: checksum('c'),
    });
    const mock = createCatalogDb([
      {
        checksum: checksum('a'),
        pointerRevision: 1,
        providerId: 'p1',
        providerKey: 'alpha',
        revisionNumber: 1,
        secretFingerprint: null,
        status: 'published' as const,
      },
    ]);

    const tokens = await Promise.all(
      Array.from({ length: 12 }, () => loadCurrentAiCatalogTargetToken(mock.db)),
    );
    expect(new Set(tokens.map(({ value }) => value)).size).toBe(1);
    expect(mock.selectCount).toBe(1);
    expect(aiCatalogAuthorityToken.stats.rebuilds).toBe(1);
  });

  it('uses immutable tombstone state when an archived builtin override pointer is disabled', async () => {
    peekGeneration.mockResolvedValue({
      generation: 13,
      tokenKind: 'immutable_id',
      tokenValue: checksum('d'),
    });
    const mock = createCatalogDb([
      {
        checksum: checksum('b'),
        currentVersionId: 'v1',
        pointerRevision: 2,
        publishedEnabled: true,
        publishedTombstone: true,
        publishedVersionId: 'v1',
        revisionNumber: 2,
        skillId: 'skill-1',
        skillKey: 'builtin.core',
        status: 'archived' as const,
        versionId: 'v1',
      },
    ]);

    const token = await loadCurrentSkillCatalogTargetToken(mock.db, () => []);
    expect(token).toEqual(
      buildSkillCatalogRevisionToken({
        builtins: [],
        platform: [
          {
            checksum: checksum('b'),
            currentVersionId: 'v1',
            revision: 2,
            skillId: 'skill-1',
            skillKey: 'builtin.core',
            tombstone: true,
          },
        ],
      }),
    );
  });

  it('skill cache-miss rebuild fails closed when published versionId mismatches currentVersionId', async () => {
    peekGeneration.mockResolvedValue({
      generation: 3,
      tokenKind: 'immutable_id',
      tokenValue: checksum('m'),
    });
    // Retargeted pointer: join still finds version v2, but published snapshot points at v1.
    const mock = createCatalogDb([
      {
        checksum: checksum('b'),
        currentVersionId: 'v2',
        pointerRevision: 1,
        publishedEnabled: true,
        publishedTombstone: false,
        publishedVersionId: 'v1',
        revisionNumber: 1,
        skillId: 'skill-1',
        skillKey: 'skill.one',
        status: 'published' as const,
        versionId: 'v2',
      },
    ]);

    await expect(loadCurrentSkillCatalogTargetToken(mock.db, () => [])).rejects.toBeInstanceOf(
      PlatformCatalogTokenInvariantError,
    );
    expect(mock.selectCount).toBe(1);
  });
});
