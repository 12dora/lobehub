import type { PlatformIdentityProviderDraft } from '@lobechat/types';
import { describe, expect, it } from 'vitest';

import type { EditableDraft } from './steps';
import { resolveIdentityProviderWizardReadiness } from './wizardReadiness';

const draft = (overrides: Partial<EditableDraft> = {}): EditableDraft =>
  ({
    claimMapping: {},
    clientId: 'client',
    dingtalkAllowedCorps: [],
    displayName: 'Provider',
    issuer: 'https://issuer.example',
    providerKey: 'idp',
    type: 'generic-oidc',
    ...overrides,
  }) as EditableDraft;

const provider = (
  overrides: Partial<PlatformIdentityProviderDraft> = {},
): PlatformIdentityProviderDraft =>
  ({
    publishTestReady: false,
    revision: 3,
    secret: { configured: true },
    status: 'draft',
    type: 'generic-oidc',
    workflowState: 'ready',
    ...overrides,
  }) as PlatformIdentityProviderDraft;

const succeeded = { result: { valid: true }, status: 'succeeded' } as never;

describe('resolveIdentityProviderWizardReadiness', () => {
  it('accepts a session test that ran against the revision on screen', () => {
    const readiness = resolveIdentityProviderWizardReadiness({
      attempt: { id: 'a1', revision: 3, startedAt: 0 },
      canPublish: true,
      dirty: false,
      draft: draft(),
      provider: provider(),
      testResultData: succeeded,
    });

    expect(readiness.testSucceeded).toBe(true);
    expect(readiness.publishReady).toBe(true);
  });

  it('refuses a session test that passed against an earlier revision (ASI-009)', () => {
    // The wizard has since saved: the pass belongs to revision 3, the provider is at 4.
    const readiness = resolveIdentityProviderWizardReadiness({
      attempt: { id: 'a1', revision: 3, startedAt: 0 },
      canPublish: true,
      dirty: false,
      draft: draft(),
      provider: provider({ revision: 4 }),
      testResultData: succeeded,
    });

    expect(readiness.testSucceeded).toBe(false);
    expect(readiness.publishReady).toBe(false);
  });

  it("keeps the server's own memory of a pass when this session never ran one", () => {
    const readiness = resolveIdentityProviderWizardReadiness({
      attempt: null,
      canPublish: true,
      dirty: false,
      draft: draft(),
      provider: provider({ publishTestReady: true }),
      testResultData: undefined,
    });

    expect(readiness.publishReady).toBe(true);
  });

  it('refuses a DingTalk provider whose organisation allowlist is empty', () => {
    // Fail-closed parity with the runtime: an empty allowlist lets nobody sign in.
    const readiness = resolveIdentityProviderWizardReadiness({
      attempt: null,
      canPublish: true,
      dirty: false,
      draft: draft({ dingtalkAllowedCorps: [], type: 'dingtalk' }),
      provider: provider({ publishTestReady: true, type: 'dingtalk' }),
      testResultData: undefined,
    });

    expect(readiness.corpAllowlistMissing).toBe(true);
    expect(readiness.publishReady).toBe(false);
  });

  it.each([
    ['unsaved edits', { dirty: true }],
    ['a missing permission', { canPublish: false }],
  ])('refuses publication with %s', (_label, override) => {
    const readiness = resolveIdentityProviderWizardReadiness({
      attempt: null,
      canPublish: true,
      dirty: false,
      draft: draft(),
      provider: provider({ publishTestReady: true }),
      testResultData: undefined,
      ...override,
    });

    expect(readiness.publishReady).toBe(false);
  });

  it('drops the two steps a protocol-fixed provider has nothing to say in', () => {
    const fixed = resolveIdentityProviderWizardReadiness({
      attempt: null,
      canPublish: true,
      dirty: false,
      draft: draft({ dingtalkAllowedCorps: ['corp'], type: 'dingtalk' }),
      provider: provider({ type: 'dingtalk' }),
      testResultData: undefined,
    });

    expect(fixed.fixedProtocol).toBe(true);
    expect(fixed.steps).not.toContain('discovery');
    expect(fixed.steps).not.toContain('claims');
  });
});
