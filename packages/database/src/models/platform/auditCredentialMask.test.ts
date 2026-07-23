// @vitest-environment node
/**
 * Pure unit tests for credential-only audit masking (no DB / DATABASE_TEST_URL).
 */
import { describe, expect, it } from 'vitest';

import {
  isCredentialKey,
  maskAuditConversationEvidence,
  maskCredentialsDeep,
  maskCredentialsInText,
} from './auditCredentialMask';
import { isSensitiveKey } from './redact';

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
