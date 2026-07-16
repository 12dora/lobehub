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
});
