import { describe, expect, it } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import {
  buildAiSecretMutation,
  buildCompleteModelOrder,
  buildProviderCreatePayload,
  buildProviderUpdatePayload,
  deriveAiCatalogPermissions,
  fingerprintAiProviderPublicDraft,
  hasBlockingModelDependents,
  parseJsonObject,
  resolveAiProviderPrimaryAction,
  toEditableAiProviderDraft,
} from './controller';
import type { AdminAiProviderDraft } from './types';

const provider = {
  checkModel: 'gpt-test',
  config: { endpoint: 'https://example.com' },
  description: 'Provider',
  displayName: 'Example',
  enabled: true,
  fetchOnClient: false,
  id: 'p-1',
  logo: null,
  models: [],
  providerKey: 'example',
  revision: 3,
  secret: { configured: true, fingerprint: 'sha256:abc', updatedAt: null },
  settings: { sdkType: 'openai' },
  sort: 0,
  source: 'custom',
  status: 'draft',
} satisfies AdminAiProviderDraft;

describe('ai catalog controller', () => {
  it('derives action permissions independently', () => {
    const permissions = deriveAiCatalogPermissions([
      PLATFORM_PERMISSIONS.AI_PROVIDER_READ,
      PLATFORM_PERMISSIONS.AI_PROVIDER_TEST,
      PLATFORM_PERMISSIONS.AI_MODEL_UPDATE,
    ]);

    expect(permissions).toMatchObject({
      canCreateProvider: false,
      canReadProviders: true,
      canReorderModels: true,
      canTestProvider: true,
      canUpdateProvider: false,
    });
  });

  it('keeps exactly one primary provider action', () => {
    const base = {
      canPublish: true,
      canSave: true,
      canTest: true,
      conflict: false,
      dirty: false,
      saveState: 'idle' as const,
      testPassed: false,
    };
    expect(resolveAiProviderPrimaryAction(base)).toBe('test');
    expect(resolveAiProviderPrimaryAction({ ...base, dirty: true })).toBe('save');
    expect(resolveAiProviderPrimaryAction({ ...base, saveState: 'failed' })).toBe('retry');
    expect(resolveAiProviderPrimaryAction({ ...base, testPassed: true })).toBe('publish');
    expect(resolveAiProviderPrimaryAction({ ...base, conflict: true })).toBe('none');
  });

  it('excludes secret metadata from public draft fingerprint and payload', () => {
    const changedSecret = {
      ...provider,
      secret: { configured: false, fingerprint: null, updatedAt: null },
    } satisfies AdminAiProviderDraft;
    expect(fingerprintAiProviderPublicDraft(changedSecret)).toBe(
      fingerprintAiProviderPublicDraft(provider),
    );

    const payload = buildProviderUpdatePayload({
      draft: toEditableAiProviderDraft(provider),
      draftToken: 'a'.repeat(64),
      id: provider.id,
      reason: ' rotate model ',
      revision: provider.revision,
    });
    expect(payload.secret).toEqual({ operation: 'keep' });
    expect(JSON.stringify(payload)).not.toContain('sha256:abc');
    expect(payload.reason).toBe('rotate model');
  });

  it('requires the complete unique model set for reorder', () => {
    expect(buildCompleteModelOrder(['a', 'b'], ['b', 'a'])).toEqual([
      { id: 'b', sort: 0 },
      { id: 'a', sort: 1 },
    ]);
    expect(buildCompleteModelOrder(['a', 'b'], ['a'])).toBeNull();
    expect(buildCompleteModelOrder(['a', 'b'], ['a', 'c'])).toBeNull();
    expect(buildCompleteModelOrder(['a', 'a'], ['a', 'a'])).toBeNull();
  });

  it('blocks model removal when any dependent is blocking', () => {
    expect(
      hasBlockingModelDependents({
        items: [
          { blocking: false, label: 'Draft', resourceId: 'a', resourceType: 'agent' },
          { blocking: true, label: 'Inbox', resourceId: 'b', resourceType: 'agent' },
        ],
      }),
    ).toBe(true);
    expect(hasBlockingModelDependents({ items: [] })).toBe(false);
  });

  it('accepts JSON objects and rejects arrays or invalid JSON', () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ error: null, value: { a: 1 } });
    expect(parseJsonObject('[]')).toEqual({ error: 'object', value: null });
    expect(parseJsonObject('{')).toEqual({ error: 'syntax', value: null });
  });

  it('never carries a value for keep or clear Secret operations', () => {
    expect(buildAiSecretMutation('keep', 'must-not-leak')).toEqual({ operation: 'keep' });
    expect(buildAiSecretMutation('clear', 'must-not-leak')).toEqual({ operation: 'clear' });
    expect(buildAiSecretMutation('replace', '')).toBeNull();
    expect(buildAiSecretMutation('replace', 'new-secret')).toEqual({
      operation: 'replace',
      value: 'new-secret',
    });
  });

  it('builds create payload without inventing an empty Secret', () => {
    const base = {
      config: {},
      description: '',
      displayName: ' Example ',
      enabled: false,
      fetchOnClient: false,
      providerKey: ' example ',
      reason: ' create ',
      secretValue: '',
      settings: {},
      source: 'custom',
    };
    expect(buildProviderCreatePayload(base)).not.toHaveProperty('secret');
    expect(buildProviderCreatePayload(base)).toMatchObject({
      description: null,
      displayName: 'Example',
      providerKey: 'example',
      reason: 'create',
    });
    expect(buildProviderCreatePayload({ ...base, secretValue: 'token' }).secret).toEqual({
      operation: 'replace',
      value: 'token',
    });
  });
});
