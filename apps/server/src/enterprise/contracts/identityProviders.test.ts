import {
  DINGTALK_IDENTITY_PROVIDER_ISSUER,
  DINGTALK_IDENTITY_PROVIDER_TEMPLATE,
} from '@lobechat/types';
import { describe, expect, it } from 'vitest';

import {
  adminIdentityProviderCreateInputSchema,
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
  dingtalkAllowedCorps: [],
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

/**
 * The DingTalk identity contract is protocol-fixed: the claim mapping selects the Better Auth
 * account id and the issuer is a constant, so neither is administrator-configurable. These are
 * write-boundary regressions — the read boundary is covered in publishedPayload tests.
 */
describe('DingTalk fixed identity contract at the write boundary', () => {
  const dingtalkInput = () => ({
    autoProvision: true,
    buttonLabel: DINGTALK_IDENTITY_PROVIDER_TEMPLATE.buttonLabel,
    claimMapping: structuredClone(DINGTALK_IDENTITY_PROVIDER_TEMPLATE.claimMapping) as Record<
      keyof typeof DINGTALK_IDENTITY_PROVIDER_TEMPLATE.claimMapping,
      string[]
    >,
    clientId: 'app-key',
    dingtalkAllowedCorps: [{ addedAt: '2026-01-01T00:00:00.000Z', corpId: 'ding42' }],
    displayName: 'DingTalk',
    domainAllowlist: [],
    groupRoleMapping: {},
    icon: 'dingtalk',
    issuer: DINGTALK_IDENTITY_PROVIDER_ISSUER,
    providerKey: 'dingtalk',
    reason: 'add dingtalk login',
    scopes: [...DINGTALK_IDENTITY_PROVIDER_TEMPLATE.scopes],
    secret: { operation: 'replace' as const, value: 'app-secret' },
    type: 'dingtalk' as const,
    usePkce: true as const,
  });

  it('accepts the canonical DingTalk contract', () => {
    expect(adminIdentityProviderCreateInputSchema.safeParse(dingtalkInput()).success).toBe(true);
  });

  it('rejects a remapped subject, altered scopes and a foreign issuer', () => {
    const remapped = dingtalkInput();
    remapped.claimMapping.subject = ['nick'];
    expect(adminIdentityProviderCreateInputSchema.safeParse(remapped).success).toBe(false);

    const emailSubject = dingtalkInput();
    emailSubject.claimMapping.subject = ['email'];
    expect(adminIdentityProviderCreateInputSchema.safeParse(emailSubject).success).toBe(false);

    expect(
      adminIdentityProviderCreateInputSchema.safeParse({
        ...dingtalkInput(),
        scopes: ['openid'],
      }).success,
    ).toBe(false);

    for (const issuer of [
      'https://evil.example',
      `${DINGTALK_IDENTITY_PROVIDER_ISSUER}/ding42`,
      `${DINGTALK_IDENTITY_PROVIDER_ISSUER}/`,
    ]) {
      expect(
        adminIdentityProviderCreateInputSchema.safeParse({ ...dingtalkInput(), issuer }).success,
        issuer,
      ).toBe(false);
    }
  });

  it('requires a DNS-label provider key so the synthesized address stays valid', () => {
    for (const providerKey of ['dingtalk', 'ding-talk', 'd', '0ding']) {
      expect(
        adminIdentityProviderCreateInputSchema.safeParse({ ...dingtalkInput(), providerKey })
          .success,
        providerKey,
      ).toBe(true);
    }
    // `_` / `.` / edge hyphens are allowed by the generic providerKey charset but would make
    // `<unionId>@<providerKey>.dingtalk.sso` fail email validation at every login.
    for (const providerKey of ['corp_sso', 'corp.sso', '-ding', 'ding-']) {
      expect(
        adminIdentityProviderCreateInputSchema.safeParse({ ...dingtalkInput(), providerKey })
          .success,
        providerKey,
      ).toBe(false);
    }
  });

  it('validates organisation allowlist entries and rejects them on other kinds', () => {
    const withCorp = (corps: unknown) => ({ ...dingtalkInput(), dingtalkAllowedCorps: corps });
    expect(
      adminIdentityProviderCreateInputSchema.safeParse(
        withCorp([{ addedAt: '2026-01-01T00:00:00.000Z', corpId: 'ding/../evil' }]),
      ).success,
    ).toBe(false);
    expect(
      adminIdentityProviderCreateInputSchema.safeParse(
        withCorp([{ addedAt: 'not-a-date', corpId: 'ding42' }]),
      ).success,
    ).toBe(false);
    expect(
      adminIdentityProviderCreateInputSchema.safeParse(
        withCorp([
          { addedAt: '2026-01-01T00:00:00.000Z', corpId: 'ding42' },
          { addedAt: '2026-01-02T00:00:00.000Z', corpId: 'ding42' },
        ]),
      ).success,
    ).toBe(false);
    expect(
      adminIdentityProviderCreateInputSchema.safeParse(
        withCorp([
          { addedAt: '2026-01-01T00:00:00.000Z', corpId: 'ding42', label: 'x'.repeat(65) },
        ]),
      ).success,
    ).toBe(false);

    // A grant on a non-DingTalk kind would be dead config — and dangerous after a kind switch.
    expect(
      adminIdentityProviderCreateInputSchema.safeParse({
        ...dingtalkInput(),
        claimMapping: {
          dingtalkTitle: [],
          dingtalkUserId: [],
          email: ['email'],
          name: ['name'],
          picture: [],
          subject: ['sub'],
        },
        issuer: 'https://login.example.test',
        scopes: ['openid'],
        type: 'generic_oidc' as const,
      }).success,
    ).toBe(false);
  });
});
