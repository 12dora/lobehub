import { describe, expect, it } from 'vitest';

import {
  adminIdentityProviderGetOutputSchema,
  adminIdentityProviderListOutputSchema,
  adminIdentityProviderMutationOutputSchema,
  adminIdentityProviderPublishOutputSchema,
  adminIdentityProviderRollbackOutputSchema,
  adminIdentityProviderTestResultOutputSchema,
} from './identityProviders';

const publicDraft = {
  activationRevision: null,
  autoProvision: true,
  buttonLabel: 'Sign in with work',
  claimMapping: {
    dingtalkTitle: [],
    dingtalkUserId: [],
    email: ['email'],
    name: ['name'],
    picture: [],
    subject: ['sub'],
  },
  clientId: 'client-id',
  displayName: 'Work',
  domainAllowlist: [],
  enabled: false,
  groupRoleMapping: {},
  icon: null,
  id: 'provider-work',
  issuer: 'https://login.example.test',
  migrationRequired: false,
  providerKey: 'work',
  revision: 1,
  scopes: ['openid'],
  secret: { configured: true, updatedAt: new Date('2026-07-19T00:00:00Z') },
  status: 'draft',
  type: 'generic_oidc',
  usePkce: true,
};

describe('identity provider public draft outputs', () => {
  it.each([
    ['get', () => adminIdentityProviderGetOutputSchema.parse(publicDraft)],
    ['create', () => adminIdentityProviderMutationOutputSchema.parse(publicDraft)],
    ['update', () => adminIdentityProviderMutationOutputSchema.parse(publicDraft)],
    ['publish', () => adminIdentityProviderPublishOutputSchema.parse(publicDraft)],
    ['rollback', () => adminIdentityProviderRollbackOutputSchema.parse(publicDraft)],
    [
      'list',
      () => adminIdentityProviderListOutputSchema.parse({ items: [publicDraft], nextCursor: null }),
    ],
  ])('keeps %s output free of fingerprint and digest metadata', (_name, parse) => {
    expect(JSON.stringify(parse())).not.toMatch(/fingerprint|digest|[a-f0-9]{64}/i);
  });

  it.each([
    adminIdentityProviderGetOutputSchema,
    adminIdentityProviderMutationOutputSchema,
    adminIdentityProviderPublishOutputSchema,
    adminIdentityProviderRollbackOutputSchema,
  ])('rejects server-internal fingerprint fields at the API boundary', (schema) => {
    expect(() =>
      schema.parse({
        ...publicDraft,
        secret: { ...publicDraft.secret, fingerprint: 'a'.repeat(64) },
      }),
    ).toThrow();
  });

  it('rejects server-internal fields from list output and preserves cleared timestamps', () => {
    expect(() =>
      adminIdentityProviderListOutputSchema.parse({
        items: [
          {
            ...publicDraft,
            secret: { configured: true, digest: 'a'.repeat(64), updatedAt: new Date() },
          },
        ],
        nextCursor: null,
      }),
    ).toThrow();
    expect(
      adminIdentityProviderGetOutputSchema.parse({
        ...publicDraft,
        secret: { configured: false, updatedAt: null },
      }).secret,
    ).toEqual({ configured: false, updatedAt: null });
  });
});

describe('identity provider test result output', () => {
  it('serializes only strict claim presence summaries and rejects raw or unknown claims', () => {
    const output = adminIdentityProviderTestResultOutputSchema.parse({
      attemptId: 'attempt-1',
      errorCode: null,
      result: {
        claims: {
          dingtalk_user_id: { present: true, type: 'string' },
          email: { present: true, type: 'string' },
          name: { present: true, type: 'string' },
          sub: { present: true, type: 'string' },
        },
        issues: [],
        valid: true,
      },
      status: 'succeeded',
    });
    expect(JSON.stringify(output)).not.toMatch(
      /admin@example\.test|Ada Lovelace|subject-1|ding-user-42/,
    );

    expect(() =>
      adminIdentityProviderTestResultOutputSchema.parse({
        ...output,
        result: { ...output.result, claims: { email: 'admin@example.test' } },
      }),
    ).toThrow();
    expect(() =>
      adminIdentityProviderTestResultOutputSchema.parse({
        ...output,
        result: {
          ...output.result,
          claims: { unknown_private_claim: { present: true, type: 'string' } },
        },
      }),
    ).toThrow();
  });
});
