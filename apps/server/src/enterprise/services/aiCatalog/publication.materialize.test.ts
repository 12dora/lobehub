// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { publishedSecretPointerColumns } from './publication.materialize';

describe('publishedSecretPointerColumns', () => {
  const storedProvider = {
    secretKeyId: 'stored-key',
    secretKeyVersion: 3,
    secretUpdatedAt: new Date('2024-01-01T00:00:00.000Z'),
  };
  const secretVersion = {
    ciphertext: 'cipher',
    createdAt: new Date('2024-06-01T00:00:00.000Z'),
    keyVersion: 7,
  };
  const secrets = { peekKeyId: (ciphertext: string) => `peek:${ciphertext}` };

  it('keeps stored secret pointer columns when deactivating a published provider', () => {
    expect(
      publishedSecretPointerColumns(true, storedProvider, secretVersion, secrets as never),
    ).toEqual({
      secretKeyId: 'stored-key',
      secretKeyVersion: 3,
      secretUpdatedAt: storedProvider.secretUpdatedAt,
    });
  });

  it('peeks the secret version key id when a version is present', () => {
    expect(
      publishedSecretPointerColumns(false, storedProvider, secretVersion, secrets as never),
    ).toEqual({
      secretKeyId: 'peek:cipher',
      secretKeyVersion: 7,
      secretUpdatedAt: secretVersion.createdAt,
    });
  });

  it('nulls secret pointer columns when no secret version is present', () => {
    expect(
      publishedSecretPointerColumns(false, storedProvider, undefined, secrets as never),
    ).toEqual({
      secretKeyId: null,
      secretKeyVersion: null,
      secretUpdatedAt: null,
    });
  });
});
