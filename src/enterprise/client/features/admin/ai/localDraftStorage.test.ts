import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearAiProviderPublicDraft,
  loadAiProviderPublicDraft,
  saveAiProviderPublicDraft,
} from './localDraftStorage';

describe('AI provider public draft storage', () => {
  const values = new Map<string, string>();

  beforeEach(() => {
    values.clear();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        removeItem: (key: string) => values.delete(key),
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
  });

  it('persists public fields without accepting a secret field', () => {
    const payload = {
      baseDraft: {
        checkModel: null,
        configText: '{"endpoint":"https://example.com"}',
        description: null,
        displayName: 'Example',
        enabled: true,
        fetchOnClient: false,
        logo: null,
        settingsText: '{}',
        sort: 0,
      },
      baseRevision: 1,
      draft: {
        checkModel: null,
        configText: '{"endpoint":"https://example.com"}',
        description: null,
        displayName: 'Example',
        enabled: true,
        fetchOnClient: false,
        logo: null,
        settingsText: '{}',
        sort: 0,
      },
      draftToken: 'a'.repeat(64),
      savedAt: new Date(0).toISOString(),
    };

    saveAiProviderPublicDraft('p-1', payload);
    expect(loadAiProviderPublicDraft('p-1')).toEqual(payload);
    expect([...values.values()][0]).not.toContain('secret');
  });

  it('rejects malformed snapshots and clears by provider', () => {
    values.set('aihub.admin.ai.provider.public-draft.p-1', '{"draft":{}}');
    expect(loadAiProviderPublicDraft('p-1')).toBeNull();
    clearAiProviderPublicDraft('p-1');
    expect(loadAiProviderPublicDraft('p-1')).toBeNull();
  });

  it('preserves invalid public raw JSON and migrates the original object shape', () => {
    values.set(
      'aihub.admin.ai.provider.public-draft.p-1',
      JSON.stringify({
        baseRevision: 1,
        draft: {
          checkModel: null,
          config: { endpoint: 'https://example.com' },
          description: null,
          displayName: 'Example',
          enabled: true,
          fetchOnClient: false,
          logo: null,
          settings: {},
          sort: 0,
        },
        draftToken: 'a'.repeat(64),
        savedAt: new Date(0).toISOString(),
      }),
    );
    expect(loadAiProviderPublicDraft('p-1')?.draft.configText).toContain('endpoint');

    const migrated = loadAiProviderPublicDraft('p-1')!;
    saveAiProviderPublicDraft('p-1', {
      ...migrated,
      draft: { ...migrated.draft, configText: '{' },
    });
    expect(loadAiProviderPublicDraft('p-1')?.draft.configText).toBe('{');
    expect([...values.values()][0]).not.toContain('secret');
  });

  it('runtime-whitelists public fields even when a caller supplies extra credential keys', () => {
    const draft = {
      checkModel: null,
      configText: '{}',
      description: null,
      displayName: 'Example',
      enabled: true,
      fetchOnClient: false,
      logo: null,
      secret: { apiKey: 'must-never-persist' },
      settingsText: '{}',
      sort: 0,
    };
    saveAiProviderPublicDraft('p-1', {
      baseDraft: draft,
      baseRevision: 1,
      draft,
      draftToken: 'a'.repeat(64),
      savedAt: new Date(0).toISOString(),
    });
    expect([...values.values()][0]).not.toContain('must-never-persist');
    expect(loadAiProviderPublicDraft('p-1')).not.toHaveProperty('draft.secret');
  });
});
