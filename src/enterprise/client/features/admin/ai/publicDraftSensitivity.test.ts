import { describe, expect, it } from 'vitest';

import {
  containsSensitivePublicDraftValue,
  isAiCatalogBenignPublicKey,
  isPublicDraftCredentialBearingUrl,
  isPublicDraftSensitiveKey,
} from './publicDraftSensitivity';

describe('public draft sensitivity parity', () => {
  it.each([
    'sessionToken',
    'SESSION-token',
    'bearerToken',
    'Set_Cookie',
    'client.credentials',
    'AWS_SECRET-ACCESS_KEY',
    'encryptedClientSecret',
    'Authorization_Header',
  ])('matches the platform normalized sensitive-key rule for %s', (key) => {
    expect(isPublicDraftSensitiveKey(key)).toBe(true);
  });

  it('keeps the M07 numeric token metadata allowlist explicit', () => {
    expect(isPublicDraftSensitiveKey('max_tokens')).toBe(true);
    expect(isAiCatalogBenignPublicKey('MAX-TOKENS')).toBe(true);
    expect(isPublicDraftSensitiveKey('context-window-tokens')).toBe(true);
    expect(isAiCatalogBenignPublicKey('contextWindowTokens')).toBe(true);
    expect(containsSensitivePublicDraftValue({ contextWindowTokens: 128_000 })).toBe(false);
  });

  it('rejects sensitive nested keys and credential-bearing URL query variants', () => {
    expect(
      containsSensitivePublicDraftValue({ nested: { 'Bearer-Token': 'sensitive-value' } }),
    ).toBe(true);
    expect(
      isPublicDraftCredentialBearingUrl('https://example.test/v1?session_token=sensitive-value'),
    ).toBe(true);
    expect(isPublicDraftCredentialBearingUrl('https://example.test/v1?max_tokens=128000')).toBe(
      false,
    );
  });

  it.each(['endpoint', 'modelKey', 'requestTimeout', 'sdkType'])(
    'does not over-classify public key %s',
    (key) => {
      expect(isPublicDraftSensitiveKey(key)).toBe(false);
    },
  );
});
