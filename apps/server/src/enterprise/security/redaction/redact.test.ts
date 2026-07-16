// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  containsSensitiveMaterial,
  isSensitiveKey,
  M07_BENIGN_KEY_CANDIDATES,
  M07_REDACTION_OPTIONS,
  redactDeep,
  REDACTED_PLACEHOLDER,
  redactForAudit,
  redactForLog,
  redactSensitive,
} from './index';

describe('enterprise redaction entry', () => {
  it('re-exports M01 fact-source helpers', () => {
    expect(REDACTED_PLACEHOLDER).toBe('[REDACTED]');
    expect(isSensitiveKey('apiKey')).toBe(true);
    expect(isSensitiveKey('displayName')).toBe(false);

    const out = redactSensitive({ apiKey: 'sk-fake-not-real-0001', name: 'ok' });
    expect(out).toEqual({ apiKey: '[REDACTED]', name: 'ok' });
    expect(containsSensitiveMaterial(out)).toBe(false);
  });

  it('redactForLog / redactForAudit match default over-redaction', () => {
    const input = {
      accessToken: 'opaque-oauth-access-token',
      nested: { client_secret: 'fake', safe: 1 },
    };
    expect(redactForLog(input)).toEqual(redactSensitive(input));
    expect(redactForAudit(input)).toEqual(redactSensitive(input));
    expect(redactForLog(input)).toEqual({
      accessToken: '[REDACTED]',
      nested: { client_secret: '[REDACTED]', safe: 1 },
    });
  });

  it('does not mutate input', () => {
    const input = { token: 'x', keep: 'y' };
    const copy = structuredClone(input);
    redactForAudit(input);
    expect(input).toEqual(copy);
  });

  it('isBenignKey allows M07-style false positives without weakening real secrets', () => {
    const benign = new Set(M07_BENIGN_KEY_CANDIDATES.map((k) => k.toLowerCase()));
    const isBenignKey = (key: string) => benign.has(key.toLowerCase());

    const input = {
      apiKey: 'sk-fake-not-real-0002',
      contextWindowTokens: 128_000,
      maxTokens: 4096,
      nested: {
        maxTokens: 256,
        refreshToken: 'opaque-refresh',
      },
    };

    // Default path: maxTokens is over-redacted by M01 (contains "token")
    const defaultOut = redactDeep(input);
    expect(defaultOut.maxTokens).toBe('[REDACTED]');
    expect(defaultOut.contextWindowTokens).toBe('[REDACTED]');
    expect(defaultOut.apiKey).toBe('[REDACTED]');

    // Wrapper with benign hook preserves numeric config fields
    const withBenign = redactDeep(input, { isBenignKey });
    expect(withBenign).toEqual({
      apiKey: '[REDACTED]',
      contextWindowTokens: 128_000,
      maxTokens: 4096,
      nested: {
        maxTokens: 256,
        refreshToken: '[REDACTED]',
      },
    });
  });

  it('still redacts secret value shapes inside benign-key values', () => {
    const isBenignKey = (key: string) => key === 'note';
    const out = redactDeep(
      { note: 'Bearer sk-fake-not-real-embedded', token: 'still-redacted' },
      { isBenignKey },
    );
    expect(out.note).toBe('[REDACTED]');
    expect(out.token).toBe('[REDACTED]');
  });

  it('exports the narrow M07 numeric token-key allowlist', () => {
    expect(
      redactForAudit(
        { apiKey: 'fake', contextWindowTokens: 128_000, maxTokens: 4096 },
        M07_REDACTION_OPTIONS,
      ),
    ).toEqual({ apiKey: '[REDACTED]', contextWindowTokens: 128_000, maxTokens: 4096 });
  });
});
