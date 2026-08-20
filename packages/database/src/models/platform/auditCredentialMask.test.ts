// @vitest-environment node
/**
 * Pure unit tests for credential-only audit masking (no DB / DATABASE_TEST_URL).
 */
import { describe, expect, it } from 'vitest';

import {
  applyAuditConversationRedaction,
  isCredentialKey,
  maskAuditConversationEvidence,
  maskCredentialsDeep,
  maskCredentialsInText,
} from './auditCredentialMask';
import { containsSensitiveMaterial, isSensitiveKey, redactSensitive } from './redact';

const githubFineGrained = `github_pat_${'A'.repeat(22)}_${'b'.repeat(59)}`;
const githubClassic = `ghp_${'a'.repeat(36)}`;
const githubOauth = `gho_${'c'.repeat(36)}`;
const githubUserToServer = `ghu_${'d'.repeat(36)}`;
const githubServerToServer = `ghs_${'e'.repeat(36)}`;
const githubRefresh = `ghr_${'f'.repeat(36)}`;
const awsAccessKey = 'AKIAABCDEFGHIJKLMNOP';
const gcpApiKey = 'AIzaSyA12345678901234567890123456789012';
const pemBlock = '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----';
const pemPrefixOnly = '-----BEGIN RSA PRIVATE KEY-----';

describe('maskCredentialsInText', () => {
  it('preserves long ordinary business and PII text exactly', () => {
    const ordinary = `Customer ACME Corp discussed roadmap for Q3. Contact Jane Doe at jane.doe@example.com. Phone +1-555-0100. ${'lorem '.repeat(500)}`;
    expect(maskCredentialsInText(ordinary)).toBe(ordinary);
  });

  it('masks credential substrings only', () => {
    const body =
      'Use key sk-abcdefghijklmnopqrstuvwxyz012345 and Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signaturepartok and keep ACME Corp';
    const masked = maskCredentialsInText(body);
    expect(masked).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
    expect(masked).toContain('[REDACTED]');
    expect(masked).toContain('ACME Corp');
    expect(masked).toContain('Use key');
  });

  it('masks signed-url auth query params without dropping the rest of the URL', () => {
    const url =
      'https://cdn.example.com/file.pdf?token=supersecrettokenvalue&x-amz-signature=sig123&name=report';
    const masked = maskCredentialsInText(url);
    expect(masked).toContain('name=report');
    expect(masked).toContain('token=[REDACTED]');
    expect(masked).toContain('x-amz-signature=[REDACTED]');
    expect(masked).not.toContain('supersecrettokenvalue');
    expect(masked).not.toContain('sig123');
  });

  it('masks all GitHub token families in free text', () => {
    for (const token of [
      githubClassic,
      githubFineGrained,
      githubOauth,
      githubUserToServer,
      githubServerToServer,
      githubRefresh,
    ]) {
      const masked = maskCredentialsInText(`deploy with ${token} please`);
      expect(masked).toContain('[REDACTED]');
      expect(masked).not.toContain(token);
      expect(masked).toContain('deploy with');
    }
  });

  it('fail-closes on malformed percent-encoding in query keys without throwing', () => {
    // Invalid UTF-8 percent sequence (%E0%A4%A is incomplete) previously threw URIError.
    const malformed = 'https://cdn.example.com/file?%E0%A4%A=secretvalue&name=report';
    expect(() => maskCredentialsInText(malformed)).not.toThrow();
    const masked = maskCredentialsInText(malformed);
    expect(masked).toContain('[REDACTED]');
    expect(masked).not.toContain('secretvalue');
    expect(masked).toContain('name=report');
  });
});

describe('write-path redactSensitive full secret catalog', () => {
  it.each([
    ['PEM private key block', pemBlock],
    ['PEM private key prefix', pemPrefixOnly],
    ['AWS access key id', awsAccessKey],
    ['Google API key', gcpApiKey],
    ['GitHub classic PAT', githubClassic],
    ['GitHub fine-grained PAT', githubFineGrained],
    ['GitHub OAuth token', githubOauth],
    ['GitHub user-to-server', githubUserToServer],
    ['GitHub server-to-server', githubServerToServer],
    ['GitHub refresh', githubRefresh],
  ] as const)('redacts free-text %s', (_label, secret) => {
    const input = { note: `diagnostic ${secret} end`, ordinary: 'ok' };
    const redacted = redactSensitive(input);
    expect(redacted.ordinary).toBe('ok');
    expect(redacted.note).toBe('[REDACTED]');
    expect(containsSensitiveMaterial(redacted)).toBe(false);
  });
});

describe('isCredentialKey vs isSensitiveKey', () => {
  it('does not treat ordinary business token* keys as credentials', () => {
    expect(isCredentialKey('tokenCount')).toBe(false);
    expect(isCredentialKey('tokenizer')).toBe(false);
    expect(isCredentialKey('secretSauce')).toBe(false);
    // Write-path redactor is intentionally broader.
    expect(isSensitiveKey('tokenCount')).toBe(true);
  });

  it('matches exact and compound credential keys', () => {
    expect(isCredentialKey('token')).toBe(true);
    expect(isCredentialKey('password')).toBe(true);
    expect(isCredentialKey('apiKey')).toBe(true);
    expect(isCredentialKey('openaiApiKey')).toBe(true);
    expect(isCredentialKey('refresh_token')).toBe(true);
    expect(isCredentialKey('authToken')).toBe(true);
    expect(isCredentialKey('mySecret')).toBe(true);
  });
});

describe('maskCredentialsDeep / maskAuditConversationEvidence', () => {
  it('redacts credential keys fully and preserves business fields', () => {
    const input = {
      apiKey: 'sk-abcdefghijklmnopqrstuvwxyz012345',
      note: 'ACME Corp legal memo with full body text',
      password: 'hunter2-not-in-output',
      tokenCount: 42,
      tokenizer: 'cl100k_base',
    };
    const masked = maskAuditConversationEvidence(input);
    expect(masked.apiKey).toBe('[REDACTED]');
    expect(masked.password).toBe('[REDACTED]');
    expect(masked.tokenCount).toBe(42);
    expect(masked.tokenizer).toBe('cl100k_base');
    expect(masked.note).toBe(input.note);
  });

  it('masks credential substrings inside nested free text', () => {
    const nested = {
      blocks: [{ text: 'deploy with sk-abcdefghijklmnopqrstuvwxyz012345 please' }],
      meta: { tokenCount: 9 },
    };
    const masked = maskCredentialsDeep(nested);
    expect(masked.meta.tokenCount).toBe(9);
    expect(masked.blocks[0]!.text).toContain('[REDACTED]');
    expect(masked.blocks[0]!.text).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
    expect(masked.blocks[0]!.text).toContain('deploy with');
  });
});

describe('applyAuditConversationRedaction', () => {
  const input = 'Use sk-abcdefghijklmnopqrstuvwxyz012345 and keep ACME Corp';

  it('returns input untouched when profile is off', () => {
    expect(applyAuditConversationRedaction(input, 'off')).toBe(input);
  });

  it.each([
    ['strict', 'strict' as const],
    ['standard', 'standard' as const],
    ['undefined', undefined],
  ] as const)('masks credentials when profile is %s', (_label, profile) => {
    const masked = applyAuditConversationRedaction(input, profile);
    expect(masked).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
    expect(masked).toContain('[REDACTED]');
    expect(masked).toContain('ACME Corp');
  });
});
