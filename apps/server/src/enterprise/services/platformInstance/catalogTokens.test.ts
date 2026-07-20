import { describe, expect, it } from 'vitest';

import {
  buildAiCatalogRevisionToken,
  buildSkillCatalogRevisionToken,
  PlatformCatalogTokenInvariantError,
} from './catalogTokens';

const checksum = (character: string) => character.repeat(64);

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
});
