import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  aiCatalogAuthorityToken,
  buildAiCatalogRevisionToken,
  buildSkillCatalogRevisionToken,
  IncrementalCatalogAuthorityToken,
  invalidateAiCatalogAuthorityToken,
  invalidateSkillCatalogAuthorityToken,
  PlatformCatalogTokenInvariantError,
  resolveAiCatalogTargetToken,
  resolveSkillCatalogTargetToken,
  skillCatalogAuthorityToken,
} from './catalogTokens';

const checksum = (character: string) => character.repeat(64);

afterEach(() => {
  aiCatalogAuthorityToken.clear();
  skillCatalogAuthorityToken.clear();
  vi.restoreAllMocks();
});

describe('platform catalog revision tokens', () => {
  it('canonicalizes AI rows independently of database ordering', () => {
    const rows = [
      {
        checksum: checksum('b'),
        providerId: 'provider-b',
        providerKey: 'beta',
        revision: 2,
        secretFingerprint: checksum('c'),
      },
      {
        checksum: checksum('a'),
        providerId: 'provider-a',
        providerKey: 'alpha',
        revision: 1,
        secretFingerprint: null,
      },
    ];

    expect(buildAiCatalogRevisionToken(rows)).toEqual(
      buildAiCatalogRevisionToken([...rows].reverse()),
    );
    expect(buildAiCatalogRevisionToken(rows).value).toMatch(/^[a-f0-9]{64}$/);
  });

  it('includes builtin changes and platform tombstones in the Skill token', () => {
    const input = {
      builtins: [{ checksum: checksum('a'), skillKey: 'builtin.alpha', version: '1.0.0' }],
      platform: [
        {
          checksum: checksum('b'),
          currentVersionId: 'version-1',
          revision: 1,
          skillId: 'skill-1',
          skillKey: 'builtin.retired',
          tombstone: false,
        },
      ],
    };
    const baseline = buildSkillCatalogRevisionToken(input);
    const builtinChanged = buildSkillCatalogRevisionToken({
      ...input,
      builtins: [{ ...input.builtins[0]!, checksum: checksum('c') }],
    });
    const tombstoneChanged = buildSkillCatalogRevisionToken({
      ...input,
      platform: [{ ...input.platform[0]!, tombstone: true }],
    });

    expect(builtinChanged.value).not.toBe(baseline.value);
    expect(tombstoneChanged.value).not.toBe(baseline.value);
  });

  it('rejects malformed catalog coordinates before hashing', () => {
    expect(() =>
      buildAiCatalogRevisionToken([
        {
          checksum: 'not-a-checksum',
          providerId: 'provider',
          providerKey: 'provider',
          revision: 1,
          secretFingerprint: null,
        },
      ]),
    ).toThrow(PlatformCatalogTokenInvariantError);
    expect(() =>
      buildSkillCatalogRevisionToken({
        builtins: [],
        platform: [
          {
            checksum: checksum('a'),
            currentVersionId: null,
            revision: 1,
            skillId: 'skill',
            skillKey: 'skill',
            tombstone: false,
          },
        ],
      }),
    ).toThrow(PlatformCatalogTokenInvariantError);
  });

  it('steady-state polls perform no catalog-wide row/hash work (only O(1) generation peek)', () => {
    const store = new IncrementalCatalogAuthorityToken();
    const putSpy = vi.spyOn(store, 'put');
    const makeEntries = (n: number) =>
      Array.from({ length: n }, (_, index) => ({
        checksum: checksum(((index % 15) + 1).toString(16)),
        providerId: `provider-${index}`,
        providerKey: `p${index.toString().padStart(5, '0')}`,
        revision: 1 + (index % 3),
        secretFingerprint: null as string | null,
      }));

    const large = makeEntries(5_000);

    // Cold miss: exactly one put with full row/hash work accounting.
    const coldToken = resolveAiCatalogTargetToken(large, store, 0);
    expect(putSpy).toHaveBeenCalledTimes(1);
    expect(putSpy.mock.calls[0]?.[1]).toMatchObject({ entryHashes: 1, rowsScanned: 5_000 });
    expect(store.stats.rebuilds).toBe(1);
    expect(store.stats.rowsScanned).toBe(5_000);
    expect(store.stats.entryHashes).toBe(1);

    const rebuildsAfterCold = store.stats.rebuilds;
    const rowsAfterCold = store.stats.rowsScanned;
    const hashesAfterCold = store.stats.entryHashes;
    putSpy.mockClear();

    // Hundreds of steady-state polls: generation unchanged → put never runs (no scan/hash).
    for (let poll = 0; poll < 500; poll += 1) {
      expect(resolveAiCatalogTargetToken(large, store, 0)).toEqual(coldToken);
    }
    expect(putSpy).not.toHaveBeenCalled();
    expect(store.stats.rebuilds).toBe(rebuildsAfterCold);
    expect(store.stats.rowsScanned).toBe(rowsAfterCold);
    expect(store.stats.entryHashes).toBe(hashesAfterCold);

    // Persisted generation advanced (other instance publish) → next resolve rebuilds once.
    const next = makeEntries(5_001);
    const afterWrite = resolveAiCatalogTargetToken(next, store, 1);
    expect(afterWrite.value).not.toBe(coldToken.value);
    expect(putSpy).toHaveBeenCalledTimes(1);
    expect(putSpy.mock.calls[0]?.[1]).toMatchObject({ entryHashes: 1, rowsScanned: 5_001 });
    expect(store.stats.rebuilds).toBe(rebuildsAfterCold + 1);
    expect(store.stats.rowsScanned).toBe(rowsAfterCold + 5_001);
    expect(store.stats.entryHashes).toBe(hashesAfterCold + 1);

    putSpy.mockClear();
    const rebuildsAfterWrite = store.stats.rebuilds;
    const rowsAfterWrite = store.stats.rowsScanned;
    for (let poll = 0; poll < 200; poll += 1) {
      expect(resolveAiCatalogTargetToken(next, store, 1)).toEqual(afterWrite);
    }
    expect(putSpy).not.toHaveBeenCalled();
    expect(store.stats.rebuilds).toBe(rebuildsAfterWrite);
    expect(store.stats.rowsScanned).toBe(rowsAfterWrite);

    // Skill path: same bounded work property.
    const skillStore = new IncrementalCatalogAuthorityToken();
    const skillPut = vi.spyOn(skillStore, 'put');
    const skillEntries = (n: number) =>
      Array.from({ length: n }, (_, index) => ({
        checksum: checksum(((index % 15) + 1).toString(16)),
        currentVersionId: `version-${index}`,
        revision: 1,
        skillId: `skill-${index}`,
        skillKey: `skill.key.${index}`,
        tombstone: false,
      }));
    const builtins = [{ checksum: checksum('f'), skillKey: 'builtin.core', version: '1.0.0' }];
    const skillLarge = { builtins, platform: skillEntries(8_000) };
    resolveSkillCatalogTargetToken(skillLarge, skillStore, 0);
    expect(skillPut).toHaveBeenCalledTimes(1);
    expect(skillPut.mock.calls[0]?.[1]).toMatchObject({ entryHashes: 1, rowsScanned: 8_001 });
    expect(skillStore.stats.rebuilds).toBe(1);
    expect(skillStore.stats.rowsScanned).toBe(8_001);
    skillPut.mockClear();
    const skillRows = skillStore.stats.rowsScanned;
    for (let poll = 0; poll < 200; poll += 1) {
      resolveSkillCatalogTargetToken(skillLarge, skillStore, 0);
    }
    expect(skillPut).not.toHaveBeenCalled();
    expect(skillStore.stats.rebuilds).toBe(1);
    expect(skillStore.stats.rowsScanned).toBe(skillRows);
    expect(skillStore.stats.entryHashes).toBe(1);
  });

  it('process-wide invalidate advances generation so the next poll rebuilds', () => {
    const entries = [
      {
        checksum: checksum('a'),
        providerId: 'p1',
        providerKey: 'alpha',
        revision: 1,
        secretFingerprint: null as string | null,
      },
    ];
    const first = resolveAiCatalogTargetToken(entries);
    expect(aiCatalogAuthorityToken.stats.rebuilds).toBe(1);
    expect(resolveAiCatalogTargetToken(entries)).toEqual(first);
    expect(aiCatalogAuthorityToken.stats.rebuilds).toBe(1);

    invalidateAiCatalogAuthorityToken();
    const second = resolveAiCatalogTargetToken([
      { ...entries[0]!, revision: 2, checksum: checksum('b') },
    ]);
    expect(second.value).not.toBe(first.value);
    expect(aiCatalogAuthorityToken.stats.rebuilds).toBe(2);

    invalidateSkillCatalogAuthorityToken();
    expect(skillCatalogAuthorityToken.stats.generation).toBe(1);
  });

  it('a second instance observes a bumped persisted generation via peekAt and rebuilds once', () => {
    const entriesV1 = [
      {
        checksum: checksum('a'),
        providerId: 'p1',
        providerKey: 'alpha',
        revision: 1,
        secretFingerprint: null as string | null,
      },
    ];
    const entriesV2 = [{ ...entriesV1[0]!, revision: 2, checksum: checksum('b') }];

    // Instance A warms cache at generation 3.
    const instanceA = new IncrementalCatalogAuthorityToken();
    const tokenA = resolveAiCatalogTargetToken(entriesV1, instanceA, 3);
    expect(instanceA.stats.rebuilds).toBe(1);

    // Instance B is cold (fresh process). Same generation → rebuilds once from catalog.
    const instanceB = new IncrementalCatalogAuthorityToken();
    const tokenBCold = resolveAiCatalogTargetToken(entriesV1, instanceB, 3);
    expect(tokenBCold).toEqual(tokenA);
    expect(instanceB.stats.rebuilds).toBe(1);
    expect(instanceB.stats.rowsScanned).toBe(1);

    // Steady-state on B: generation still 3 → zero catalog work.
    const rowsAfterWarm = instanceB.stats.rowsScanned;
    for (let i = 0; i < 50; i += 1) {
      expect(resolveAiCatalogTargetToken(entriesV1, instanceB, 3)).toEqual(tokenA);
    }
    expect(instanceB.stats.rebuilds).toBe(1);
    expect(instanceB.stats.rowsScanned).toBe(rowsAfterWarm);

    // Publish on A bumps persisted generation to 4; B sees 4 via one PK (caller) and rebuilds once.
    resolveAiCatalogTargetToken(entriesV2, instanceA, 4);
    const tokenBAfter = resolveAiCatalogTargetToken(entriesV2, instanceB, 4);
    expect(tokenBAfter.value).not.toBe(tokenA.value);
    expect(instanceB.stats.rebuilds).toBe(2);
    expect(instanceB.stats.rowsScanned).toBe(rowsAfterWarm + 1);
  });
});
