import { describe, expect, it } from 'vitest';

import { containsEnterpriseSecretMaterial } from './detectSecretMaterial';

const randomSecret = 'aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY';
const easyauthTokenSecret = 'ABCDEF1234567890';

const sensitiveCases = [
  ['EasyAuth live app token', `eat_live_${easyauthTokenSecret}`],
  ['EasyAuth test app token', `eat_test_${easyauthTokenSecret}`],
  ['Bearer value', `Bearer ${randomSecret}`],
  ['short Bearer value', 'Bearer abc123'],
  ['JWT value', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMzQ1NiJ9.c2lnbmF0dXJlX3ZhbHVlXzEyMzQ1Ng'],
  ['prefixed API key', `sk-proj-${randomSecret}`],
  ['client secret assignment', `client_secret=${randomSecret}`],
  ['short client secret assignment', 'client_secret=opaque-value'],
  ['password assignment', `password=${randomSecret}`],
  ['short password assignment', 'password=hunter2'],
  ['short token assignment', 'token=opaque-value'],
  ['private key', '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----'],
] as const;

const benignCases = [
  ['token status', 'token: expired'],
  ['authorization status', 'authorization: required'],
  ['credential status', 'credential: missing'],
  ['password status', 'password: reset'],
  ['ordinary documentation', 'The authorization token is required before publishing.'],
  ['rotation documentation', 'Rotate the client secret after approval.'],
  ['angle-bracket placeholder', 'client_secret=<your-client-secret>'],
  ['text placeholder', 'token: your-token-here'],
  ['Bearer placeholder', 'Authorization: Bearer <token>'],
  ['EasyAuth placeholder', 'eat_test_...'],
  ['API key placeholder', 'sk-your-key-here'],
] as const;

describe('containsEnterpriseSecretMaterial', () => {
  it.each(sensitiveCases)('detects %s', (_label, value) => {
    expect(containsEnterpriseSecretMaterial(value)).toBe(true);
  });

  it.each(benignCases)('allows benign %s', (_label, value) => {
    expect(containsEnterpriseSecretMaterial(value)).toBe(false);
  });

  it('retains cloud, service-account, signed-url, and credential-URL detection', () => {
    for (const value of [
      'postgres://admin:password@db.internal/catalog',
      's3://bucket/key?X-Amz-Signature=plain-signature',
      'AKIAABCDEFGHIJKLMNOP',
      'AIzaSyA12345678901234567890123456789012',
      '{"type":"service_account","project_id":"example"}',
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
