// @vitest-environment node
/**
 * Rollback restores the whole published configuration, not a hand-maintained subset.
 *
 * The regression this guards: `dingtalkAllowedCorps` was omitted from the rollback projection,
 * so rolling back kept the *current draft's* organisation allowlist — preserving a grant the
 * rollback was meant to revoke (or failing to restore one it was meant to bring back), and
 * disagreeing with the canonical idempotent-replay payload, which does carry the historical list.
 */
import {
  DINGTALK_IDENTITY_PROVIDER_ISSUER,
  DINGTALK_IDENTITY_PROVIDER_TEMPLATE,
} from '@lobechat/types';
import { describe, expect, it } from 'vitest';

import { restoredConfigFromPublishedPayload } from './publicationService';
import type { PublishedIdentityProviderPayload } from './publishedPayload';

const targetPayload: PublishedIdentityProviderPayload & { secretUpdatedAt: string } = {
  autoProvision: true,
  buttonLabel: DINGTALK_IDENTITY_PROVIDER_TEMPLATE.buttonLabel,
  claimMapping: structuredClone(
    DINGTALK_IDENTITY_PROVIDER_TEMPLATE.claimMapping,
  ) as PublishedIdentityProviderPayload['claimMapping'],
  clientId: 'app-key',
  dingtalkAllowedCorps: [{ addedAt: '2026-01-01T00:00:00.000Z', corpId: 'ding42', label: 'HQ' }],
  displayName: 'DingTalk',
  domainAllowlist: [],
  enabled: true,
  groupRoleMapping: {},
  icon: 'dingtalk',
  issuer: DINGTALK_IDENTITY_PROVIDER_ISSUER,
  providerKey: 'dingtalk',
  scopes: [...DINGTALK_IDENTITY_PROVIDER_TEMPLATE.scopes],
  secretFingerprint: 'a'.repeat(64),
  secretUpdatedAt: '2026-01-01T00:00:00.000Z',
  type: 'dingtalk',
  usePkce: true,
};

describe('rollback configuration restoration', () => {
  it('restores the target revision organisation allowlist, not the current draft one', () => {
    // Current draft granted a second organisation and dropped the original one.
    const currentDraftAllowlist = [{ addedAt: '2026-06-01T00:00:00.000Z', corpId: 'ding99' }];
    const restored = restoredConfigFromPublishedPayload(targetPayload);

    expect(restored.dingtalkAllowedCorps).toEqual(targetPayload.dingtalkAllowedCorps);
    expect(restored.dingtalkAllowedCorps).not.toEqual(currentDraftAllowlist);
    // The revoked grant is gone and the historical one is back.
    expect(restored.dingtalkAllowedCorps.map((entry) => entry.corpId)).toEqual(['ding42']);
  });

  it('restores an empty allowlist when the target revision had none', () => {
    const oidcTarget = {
      ...targetPayload,
      dingtalkAllowedCorps: [],
      issuer: 'https://login.example.test',
      providerKey: 'work',
      type: 'generic_oidc' as const,
    };
    expect(restoredConfigFromPublishedPayload(oidcTarget).dingtalkAllowedCorps).toEqual([]);
  });

  it('restores every published configuration field, so a new field cannot be forgotten', () => {
    const restored = restoredConfigFromPublishedPayload(targetPayload);
    // Lifecycle fields are owned by the rollback itself, never copied from the payload.
    const lifecycleOwned = new Set(['enabled', 'secretUpdatedAt']);
    const expectedKeys = Object.keys(targetPayload)
      .filter((key) => !lifecycleOwned.has(key))
      .toSorted();

    expect(Object.keys(restored).toSorted()).toEqual(expectedKeys);
    for (const key of expectedKeys) {
      expect(restored[key as keyof typeof restored], key).toEqual(
        targetPayload[key as keyof typeof targetPayload],
      );
    }
  });
});
