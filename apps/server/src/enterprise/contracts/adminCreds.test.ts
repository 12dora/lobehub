import { describe, expect, it } from 'vitest';

import {
  adminCredsGetOutputSchema,
  adminCredsOauthConnectionsOutputSchema,
  adminCredsSkillStatusOutputSchema,
  adminCredsSummaryOutputSchema,
  adminCredsUploadFileInputSchema,
  PLATFORM_GLOBAL_CREDENTIAL_MASK,
} from './adminCreds';

const summary = {
  createdAt: '2026-07-26T00:00:00.000Z',
  id: 1,
  key: 'provider.api',
  name: 'Provider API',
  revision: 2,
  type: 'kv-env' as const,
  updatedAt: '2026-07-26T00:00:00.000Z',
};

describe('adminCreds contracts', () => {
  it('strictly whitelists the public credential summary', () => {
    expect(adminCredsSummaryOutputSchema.parse(summary)).toEqual(summary);
    expect(
      adminCredsSummaryOutputSchema.safeParse({ ...summary, ciphertext: 'secret-envelope' })
        .success,
    ).toBe(false);
  });

  it('allows only fixed public mask/status literals at the plaintext compatibility field', () => {
    expect(
      adminCredsGetOutputSchema.parse({
        ...summary,
        configured: true,
        plaintext: { TOKEN: PLATFORM_GLOBAL_CREDENTIAL_MASK },
      }),
    ).toMatchObject({ configured: true });
    expect(
      adminCredsGetOutputSchema.safeParse({
        ...summary,
        configured: true,
        plaintext: { TOKEN: 'opaque-real-secret' },
      }).success,
    ).toBe(false);
  });

  it('rejects secret-shaped OAuth connection fields', () => {
    expect(
      adminCredsOauthConnectionsOutputSchema.parse({
        connections: [{ id: 7, providerId: 'github', providerName: 'GitHub' }],
      }),
    ).toMatchObject({ connections: [{ providerId: 'github' }] });
    expect(
      adminCredsOauthConnectionsOutputSchema.safeParse({
        connections: [{ accessToken: 'oauth-secret', id: 7, providerId: 'github' }],
      }).success,
    ).toBe(false);
  });

  it('strictly validates nested skill credential summaries and rejects plaintext', () => {
    const skillStatus = {
      boundCred: {
        createdAt: '2026-07-26T00:00:00.000Z',
        id: 8,
        key: 'github.token',
        name: 'GitHub token',
        type: 'oauth' as const,
        updatedAt: '2026-07-26T00:00:00.000Z',
      },
      key: 'github.token',
      name: 'GitHub token',
      required: true,
      satisfied: true,
      type: 'oauth' as const,
    };
    expect(adminCredsSkillStatusOutputSchema.parse([skillStatus])).toEqual([skillStatus]);
    expect(
      adminCredsSkillStatusOutputSchema.safeParse([
        {
          ...skillStatus,
          boundCred: { ...skillStatus.boundCred, plaintext: { TOKEN: 'real-secret' } },
        },
      ]).success,
    ).toBe(false);
  });

  it('returns a stable code instead of English for invalid upload payloads', () => {
    const parsed = adminCredsUploadFileInputSchema.safeParse({
      file: 'YWJj!!!!',
      fileName: 'bad.bin',
      fileType: 'application/octet-stream',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toBe(
        'PLATFORM_GLOBAL_CREDENTIAL_FILE_PAYLOAD_INVALID',
      );
    }
  });
});
