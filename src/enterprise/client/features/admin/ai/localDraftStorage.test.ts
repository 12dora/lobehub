import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearAiProviderPublicDraft,
  isPublicRawJsonSafeForStorage,
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

  afterEach(() => vi.restoreAllMocks());

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

  it('drops invalid public raw JSON and migrates the original object shape', () => {
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
    expect(loadAiProviderPublicDraft('p-1')?.draft.configText).toContain('endpoint');
    expect(isPublicRawJsonSafeForStorage('{')).toBe(false);
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

  it.each([
    ['apiKey', '{"apiKey":"api-key-marker"}'],
    ['token', '{"nested":{"accessToken":"token-marker"}}'],
    ['password', '{"password":"password-marker"}'],
    [
      'customHeaders.Authorization',
      '{"customHeaders":{"Authorization":"Bearer authorization-marker"}}',
    ],
    ['credential URL', '{"endpoint":"https://user:password@example.test/v1"}'],
    ['credential query', '{"endpoint":"https://example.test/v1?api_key=query-marker"}'],
    ['known value marker', '{"note":"sk-12345678marker"}'],
  ])('drops sensitive %s raw JSON while preserving other public fields', (_label, configText) => {
    const marker = configText.match(/[\w-]+marker/)?.[0] ?? 'password';
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const baseDraft = {
      checkModel: null,
      configText: '{"safe":true}',
      description: null,
      displayName: 'Original',
      enabled: true,
      fetchOnClient: false,
      logo: null,
      settingsText: '{}',
      sort: 0,
    };

    saveAiProviderPublicDraft('p-1', {
      baseDraft,
      baseRevision: 1,
      draft: { ...baseDraft, configText, displayName: 'Recover this name' },
      draftToken: 'a'.repeat(64),
      savedAt: new Date(0).toISOString(),
    });

    const stored = [...values.values()][0]!;
    expect(stored).not.toContain(marker);
    expect(loadAiProviderPublicDraft('p-1')?.draft).toMatchObject({
      configText: '{"safe":true}',
      displayName: 'Recover this name',
    });
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it('allows benign custom headers but rejects Authorization inside customHeaders', () => {
    expect(isPublicRawJsonSafeForStorage('{"customHeaders":{"X-Request-ID":"public-value"}}')).toBe(
      true,
    );
    expect(
      isPublicRawJsonSafeForStorage(
        '{"customHeaders":{"Authorization":"Bearer authorization-marker"}}',
      ),
    ).toBe(false);
  });

  it.each([
    ['configText', '{"SESSION-token":"session-marker"'],
    ['configText', '{"Bearer_Token":"bearer-marker",'],
    ['settingsText', "{'Set-Cookie':'cookie-marker'}"],
    ['settingsText', '{"client.credentials":"credential-marker"'],
    ['settingsText', '{"Authorization_Header":"authorization-marker"'],
  ] as const)(
    'never persists or reports sensitive material from malformed %s',
    (field, malformedRaw) => {
      const marker = malformedRaw.match(/[a-z]+-marker/i)?.[0] ?? 'sensitive-marker';
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const baseDraft = {
        checkModel: null,
        configText: '{"safeConfig":true}',
        description: null,
        displayName: 'Original',
        enabled: true,
        fetchOnClient: false,
        logo: null,
        settingsText: '{"safeSettings":true}',
        sort: 0,
      };

      expect(isPublicRawJsonSafeForStorage(malformedRaw)).toBe(false);
      expect(() =>
        saveAiProviderPublicDraft('p-malformed', {
          baseDraft,
          baseRevision: 1,
          draft: { ...baseDraft, [field]: malformedRaw, displayName: 'Recover public name' },
          draftToken: 'a'.repeat(64),
          savedAt: new Date(0).toISOString(),
        }),
      ).not.toThrow();

      const stored = [...values.values()][0]!;
      expect(stored).not.toContain(marker);
      expect(stored).not.toContain(malformedRaw);
      expect(loadAiProviderPublicDraft('p-malformed')?.draft).toMatchObject({
        [field]: baseDraft[field],
        displayName: 'Recover public name',
      });
      expect(consoleError).not.toHaveBeenCalled();
      expect(consoleLog).not.toHaveBeenCalled();
      expect(consoleWarn).not.toHaveBeenCalled();
    },
  );
});
