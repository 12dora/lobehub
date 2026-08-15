// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  containsSensitiveMaterial,
  isCredentialBearingUrl,
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
  it('detects signed URL query keys without globally classifying signature fields', () => {
    expect(isSensitiveKey('signature')).toBe(false);
    for (const key of [
      'signature',
      'SIG',
      'X-Amz-Signature',
      'x_amz_signature',
      'X%2DAmz%2DSignature',
    ]) {
      expect(isCredentialBearingUrl(`https://example.test/file?${key}=signed-value`)).toBe(true);
    }
    expect(isCredentialBearingUrl('https://example.test/file?documentSignature=public')).toBe(
      false,
    );
  });

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

  it('preserves OAuth device-flow config keys while still redacting secret-shaped values under them', () => {
    // Builtin provider cards (chatgpt, githubcopilot, supergrok) carry these keys as
    // plain configuration — endpoint URLs and booleans, not credentials.
    const out = redactForAudit(
      {
        oauthDeviceFlow: {
          refreshTokenGrant: true,
          tokenEndpoint: 'https://auth.openai.com/oauth/token',
          tokenExchangeEndpoint: 'https://auth.openai.com/api/accounts/deviceauth/token',
        },
        refreshToken: 'opaque-refresh',
        showApiKey: false,
      },
      M07_REDACTION_OPTIONS,
    );
    expect(out).toEqual({
      oauthDeviceFlow: {
        refreshTokenGrant: true,
        tokenEndpoint: 'https://auth.openai.com/oauth/token',
        tokenExchangeEndpoint: 'https://auth.openai.com/api/accounts/deviceauth/token',
      },
      refreshToken: '[REDACTED]',
      showApiKey: false,
    });

    // A secret-shaped value under an allow-listed key is still caught by M01 value-shape
    // redaction (prefixed tokens / JWT / Bearer). Opaque scalars are NOT value-checked —
    // position scoping below is the guard against arbitrary-depth smuggling.
    const smuggled = redactForAudit(
      { oauthDeviceFlow: { tokenEndpoint: 'Bearer sk-fake-not-real-embedded' } },
      M07_REDACTION_OPTIONS,
    );
    expect(smuggled.oauthDeviceFlow.tokenEndpoint).toBe('[REDACTED]');

    // Position scoping: the OAuth config keys are benign ONLY directly under
    // `oauthDeviceFlow`; elsewhere the key-name rule still redacts them.
    const outOfPosition = redactForAudit(
      {
        config: { nested: { tokenEndpoint: 'opaque-not-a-secret-shape' } },
        tokenExchangeEndpoint: 'opaque-not-a-secret-shape',
      },
      M07_REDACTION_OPTIONS,
    );
    expect(outOfPosition.config.nested.tokenEndpoint).toBe('[REDACTED]');
    expect(outOfPosition.tokenExchangeEndpoint).toBe('[REDACTED]');

    // showApiKey is scoped to the settings root (walk root or a `settings` object).
    const showApiKeyScoped = redactForAudit(
      { nested: { deep: { showApiKey: 'smuggled' } }, settings: { showApiKey: false } },
      M07_REDACTION_OPTIONS,
    );
    expect(showApiKeyScoped.settings.showApiKey).toBe(false);
    expect(showApiKeyScoped.nested.deep.showApiKey).toBe('[REDACTED]');
  });

  it('preserves the authorization-code paste-flow config (chatgptweb) under its own parent only', () => {
    const out = redactForAudit(
      {
        oauthDeviceFlow: {
          allowAccessTokenPaste: true,
          authorizationCode: {
            audience: 'https://api.openai.com/v1',
            authorizeEndpoint: 'https://auth.openai.com/api/accounts/authorize',
            redirectUri: 'https://platform.openai.com/auth/callback',
          },
          grantFlow: 'authorization_code_paste',
        },
      },
      M07_REDACTION_OPTIONS,
    );
    expect(out).toEqual({
      oauthDeviceFlow: {
        allowAccessTokenPaste: true,
        authorizationCode: {
          audience: 'https://api.openai.com/v1',
          authorizeEndpoint: 'https://auth.openai.com/api/accounts/authorize',
          redirectUri: 'https://platform.openai.com/auth/callback',
        },
        grantFlow: 'authorization_code_paste',
      },
    });

    // Position scoping: `authorizationCode` is benign only under `oauthDeviceFlow`, and its
    // children only under `authorizationCode` — a real pasted code smuggled elsewhere is
    // still redacted by the key-name rule.
    const outOfPosition = redactForAudit(
      {
        allowAccessTokenPaste: 'smuggled',
        authorizationCode: 'oauth-code-value',
        nested: { authorizationCode: { authorizeEndpoint: 'x' } },
      },
      M07_REDACTION_OPTIONS,
    );
    expect(outOfPosition.allowAccessTokenPaste).toBe('[REDACTED]');
    expect(outOfPosition.authorizationCode).toBe('[REDACTED]');
    expect(outOfPosition.nested.authorizationCode).toBe('[REDACTED]');

    // Secret-shaped values under the allow-listed keys are still caught by M01.
    const smuggled = redactForAudit(
      {
        oauthDeviceFlow: {
          authorizationCode: { authorizeEndpoint: 'Bearer sk-fake-not-real-embedded' },
        },
      },
      M07_REDACTION_OPTIONS,
    );
    expect(smuggled.oauthDeviceFlow.authorizationCode.authorizeEndpoint).toBe('[REDACTED]');
  });

  it('rejects correctly-positioned but wrongly-typed OAuth config values', () => {
    // The whole point of the exception is that these key names label CONFIGURATION. An
    // opaque scalar under them is a credential wearing a config name: position alone must
    // not clear it, or `settings.oauthDeviceFlow.authorizationCode = '<live code>'` walks
    // straight into revisions/audit payloads.
    const out = redactForAudit(
      {
        oauthDeviceFlow: {
          allowAccessTokenPaste: 'opaque-secret',
          authorizationCode: 'opaque-authorization-code',
          refreshTokenGrant: 'opaque-secret',
          tokenEndpoint: 'opaque-not-a-url',
          tokenExchangeEndpoint: 'ftp://auth.example.test/token',
        },
      },
      M07_REDACTION_OPTIONS,
    );
    expect(out.oauthDeviceFlow).toEqual({
      allowAccessTokenPaste: '[REDACTED]',
      authorizationCode: '[REDACTED]',
      refreshTokenGrant: '[REDACTED]',
      tokenEndpoint: '[REDACTED]',
      tokenExchangeEndpoint: '[REDACTED]',
    });

    // Object/array impostors under the same keys are rejected too.
    const structured = redactForAudit(
      {
        oauthDeviceFlow: {
          allowAccessTokenPaste: { code: 'opaque' },
          authorizationCode: ['opaque-authorization-code'],
          tokenEndpoint: { url: 'https://auth.example.test/token' },
        },
      },
      M07_REDACTION_OPTIONS,
    );
    expect(structured.oauthDeviceFlow).toEqual({
      allowAccessTokenPaste: '[REDACTED]',
      authorizationCode: '[REDACTED]',
      tokenEndpoint: '[REDACTED]',
    });

    // `authorizationCode` must be the public authorize config and nothing else: an extra
    // key, or a non-string leaf, discredits the whole object.
    const extraneous = redactForAudit(
      {
        oauthDeviceFlow: {
          authorizationCode: {
            authorizeEndpoint: 'https://auth.openai.com/api/accounts/authorize',
            code: 'opaque-authorization-code',
          },
        },
      },
      M07_REDACTION_OPTIONS,
    );
    expect(extraneous.oauthDeviceFlow.authorizationCode).toBe('[REDACTED]');

    const nestedLeaf = redactForAudit(
      { oauthDeviceFlow: { authorizationCode: { redirectUri: { href: 'https://x.test/cb' } } } },
      M07_REDACTION_OPTIONS,
    );
    expect(nestedLeaf.oauthDeviceFlow.authorizationCode).toBe('[REDACTED]');

    // Credential-bearing endpoint URLs stay out as well.
    const signed = redactForAudit(
      {
        oauthDeviceFlow: {
          tokenEndpoint: 'https://auth.example.test/token?X-Amz-Signature=signed-value',
        },
      },
      M07_REDACTION_OPTIONS,
    );
    expect(signed.oauthDeviceFlow.tokenEndpoint).toBe('[REDACTED]');

    // A non-boolean `showApiKey` is a smuggled value, not a UI flag.
    const flag = redactForAudit({ showApiKey: 'opaque-secret' }, M07_REDACTION_OPTIONS);
    expect(flag.showApiKey).toBe('[REDACTED]');

    // `grantFlow` / `audience` / `authorizeEndpoint` / `redirectUri` are not sensitive key
    // names at all, so the walker never consults the predicate for them. Assert the
    // predicate's own contract directly: it is the second gate the contracts validator
    // relies on, and it must stay type-scoped if M01 ever widens its key heuristic.
    const { isBenignKey } = M07_REDACTION_OPTIONS;
    expect(isBenignKey('grantFlow', 'oauthDeviceFlow', 'device_code')).toBe(true);
    expect(isBenignKey('grantFlow', 'oauthDeviceFlow', 'authorization_code_paste')).toBe(true);
    expect(isBenignKey('grantFlow', 'oauthDeviceFlow', 'not-a-declared-grant')).toBe(false);
    expect(isBenignKey('grantFlow', 'oauthDeviceFlow', ['device_code'])).toBe(false);
    expect(isBenignKey('audience', 'authorizationCode', 'https://api.openai.com/v1')).toBe(true);
    expect(isBenignKey('audience', 'authorizationCode', 'opaque-audience')).toBe(false);
    expect(
      isBenignKey('redirectUri', 'authorizationCode', 'https://platform.openai.com/auth/callback'),
    ).toBe(true);
    expect(isBenignKey('redirectUri', 'authorizationCode', { href: 'https://x.test' })).toBe(false);
    // Absent values carry nothing to leak.
    expect(isBenignKey('authorizationCode', 'oauthDeviceFlow', undefined)).toBe(true);
    expect(isBenignKey('allowAccessTokenPaste', 'oauthDeviceFlow', null)).toBe(true);
  });

  it('treats the shared-OAuth account identity leaves as non-secret key names', () => {
    // `oauthAccountEmail` / `oauthAccountId` are display-only identity, projected to admins by
    // getConnectionStatus. They must not need an M07 benign-key exception — if the generic
    // contains-matcher ever starts eating them, the admin card silently shows [REDACTED] and
    // the write-path contract validator starts rejecting the vault.
    expect(isSensitiveKey('oauthAccountEmail')).toBe(false);
    expect(isSensitiveKey('oauthAccountId')).toBe(false);
    // The credential leaves next to them stay sensitive.
    expect(isSensitiveKey('oauthAccessToken')).toBe(true);
    expect(isSensitiveKey('oauthRefreshToken')).toBe(true);

    expect(
      redactForAudit({
        oauthAccessToken: 'fake-token',
        oauthAccountEmail: 'operator@example.test',
        oauthAccountId: 'acct-1234567890',
      }),
    ).toEqual({
      oauthAccessToken: '[REDACTED]',
      oauthAccountEmail: 'operator@example.test',
      oauthAccountId: 'acct-1234567890',
    });
  });

  it('keeps the M07 allowlist narrow: capability numbers anywhere, OAuth config position-scoped', () => {
    expect(
      redactForAudit(
        {
          apiKey: 'fake',
          contextWindowTokens: 128_000,
          maxTokens: 4096,
          secretConfigured: true,
          secretFingerprint: 'sha256:safe-metadata',
        },
        M07_REDACTION_OPTIONS,
      ),
    ).toEqual({
      apiKey: '[REDACTED]',
      contextWindowTokens: 128_000,
      maxTokens: 4096,
      secretConfigured: '[REDACTED]',
      secretFingerprint: '[REDACTED]',
    });
  });
});
