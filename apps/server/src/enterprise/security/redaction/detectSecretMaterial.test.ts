import { describe, expect, it } from 'vitest';

import { containsEnterpriseSecretMaterial } from './detectSecretMaterial';

describe('containsEnterpriseSecretMaterial', () => {
  it('detects centralized M13 credential shapes without flagging ordinary text', () => {
    expect(containsEnterpriseSecretMaterial('ordinary Skill documentation')).toBe(false);
    expect(containsEnterpriseSecretMaterial('rotate the client secret after approval')).toBe(false);
    for (const value of [
      'postgres://admin:password@db.internal/catalog',
      's3://bucket/key?X-Amz-Signature=plain-signature',
      '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----',
      'AKIAABCDEFGHIJKLMNOP',
      'AIzaSyA12345678901234567890123456789012',
      '{"type":"service_account","project_id":"example"}',
      'password=hunter2',
      'client_secret: opaque-value',
      'private key = opaque-value',
      'token=opaque-value',
    ]) {
      expect(containsEnterpriseSecretMaterial(value)).toBe(true);
    }
  });

  it('scans nested payloads and fails closed on excessive/cyclic input', () => {
    expect(
      containsEnterpriseSecretMaterial({ nested: [{ safe: true }, { private_key: 'opaque' }] }),
    ).toBe(true);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(containsEnterpriseSecretMaterial(cyclic)).toBe(false);
    expect(containsEnterpriseSecretMaterial(Array.from({ length: 10_001 }, () => 'safe'))).toBe(
      true,
    );
  });
});
