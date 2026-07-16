import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { saveAiProviderPublicDraft } from '../localDraftStorage';
import type { AdminAiProviderGetOutput } from '../types';
import { useAiProviderEditor } from './useAiProviderEditor';

const mocks = vi.hoisted(() => ({ useBlocker: vi.fn(() => ({ state: 'unblocked' })) }));

vi.mock('react-router', () => ({
  useBlocker: mocks.useBlocker,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  confirmModal: vi.fn(),
}));

const snapshot = {
  baseRevision: 3,
  draft: {
    checkModel: 'model-1',
    config: {},
    connectionTest: {
      errorCategory: null,
      latencyMs: 12,
      sanitizedMessage: 'ok',
      stale: false,
      status: 'success',
      testedAt: new Date(0),
      testedDraftToken: 'a'.repeat(64),
      testedRevision: 3,
    },
    description: null,
    displayName: 'Provider',
    enabled: true,
    fetchOnClient: false,
    id: 'provider-1',
    logo: null,
    models: [],
    providerKey: 'provider',
    revision: 3,
    secret: { configured: true, fingerprint: 'safe-metadata', updatedAt: null },
    settings: {},
    sort: 0,
    source: 'custom',
    status: 'draft',
  },
  draftToken: 'a'.repeat(64),
  published: null,
} satisfies AdminAiProviderGetOutput;

describe('useAiProviderEditor persisted connection test', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it('restores a matching persisted success and invalidates it on raw input', () => {
    const { result } = renderHook(() => useAiProviderEditor(snapshot));
    expect(result.current.connectionTest).toMatchObject({ canPublish: true, stale: false });

    act(() => result.current.updateDraft('configText', '{'));

    expect(result.current.valid).toBe(false);
    expect(result.current.connectionTest).toMatchObject({ canPublish: false, stale: true });
  });

  it('never unlocks publish for a persisted result bound to another token', () => {
    const staleSnapshot: AdminAiProviderGetOutput = {
      ...snapshot,
      draftToken: 'b'.repeat(64),
    };
    const { result } = renderHook(() => useAiProviderEditor(staleSnapshot));
    expect(result.current.connectionTest).toMatchObject({ canPublish: false, stale: true });
  });

  it('ignores recovery drafts and never blocks navigation for a read-only auditor', () => {
    const serverDraft = {
      checkModel: 'model-1',
      configText: '{}',
      description: null,
      displayName: 'Provider',
      enabled: true,
      fetchOnClient: false,
      logo: null,
      settingsText: '{}',
      sort: 0,
    };
    saveAiProviderPublicDraft('provider-1', {
      baseDraft: serverDraft,
      baseRevision: 3,
      draft: { ...serverDraft, displayName: 'Unsaved local name' },
      draftToken: 'a'.repeat(64),
      savedAt: new Date(0).toISOString(),
    });

    const { result } = renderHook(() => useAiProviderEditor(snapshot, false));
    expect(result.current.draft?.displayName).toBe('Provider');
    expect(result.current.dirty).toBe(false);
    expect(mocks.useBlocker).toHaveBeenLastCalledWith(false);

    act(() => result.current.updateDraft('displayName', 'Cannot write'));
    expect(result.current.draft?.displayName).toBe('Provider');
    expect(result.current.dirty).toBe(false);
  });
});
