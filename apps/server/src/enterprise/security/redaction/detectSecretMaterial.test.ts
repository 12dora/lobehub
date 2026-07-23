import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { containsEnterpriseSecretMaterial } from './detectSecretMaterial';

const randomSecret = 'aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY';

const sensitiveCases = [
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

  it(
    'handles a 200 KB adversarial placeholder-like assignment without backtracking',
    { timeout: 2000 },
    () => {
      const value = `client_secret=${'your-'.repeat(40_000)}zzz`;
      expect(value.length).toBeGreaterThan(200_000);
      expect(containsEnterpriseSecretMaterial(value)).toBe(false);
    },
  );

  it('scans a 200 KB multi-separator URL-like value only once', { timeout: 2000 }, () => {
    // Whitespace between candidates keeps each run short (no fail-closed long-URL path).
    const value = 'a://host '.repeat(25_000);
    expect(value.length).toBe(225_000);
    expect(containsEnterpriseSecretMaterial(value)).toBe(false);
  });

  it('uses deterministic placeholder checks without an unbounded wildcard regex', async () => {
    const source = await readFile(
      new URL('../../../../../../packages/database/src/models/platform/redact.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('DOCUMENTATION_PLACEHOLDER_MARKERS');
    expect(source).not.toContain('DOCUMENTATION_PLACEHOLDER_PATTERN');
    expect(source).not.toContain('.*');
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
