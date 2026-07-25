import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loadAiProviderPublicDraft, saveAiProviderPublicDraft } from '../localDraftStorage';
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
    secret: { configured: true, updatedAt: null },
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

describe('useAiProviderEditor CAS identity preservation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it('keeps stale local baseRevision/draftToken after hydration so conflict survives reload', async () => {
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
    const staleToken = 'a'.repeat(64);
    const liveToken = 'b'.repeat(64);
    saveAiProviderPublicDraft('provider-1', {
      baseDraft: serverDraft,
      baseRevision: 1,
      draft: { ...serverDraft, displayName: 'Stale local name' },
      draftToken: staleToken,
      savedAt: new Date(0).toISOString(),
    });

    const liveSnapshot: AdminAiProviderGetOutput = {
      ...snapshot,
      baseRevision: 2,
      draft: { ...snapshot.draft, revision: 2 },
      draftToken: liveToken,
    };

    const { result, rerender } = renderHook(
      ({ snap }: { snap: AdminAiProviderGetOutput }) => useAiProviderEditor(snap),
      { initialProps: { snap: liveSnapshot } },
    );

    expect(result.current.conflict).toBe(true);
    expect(result.current.draft?.displayName).toBe('Stale local name');

    // Allow the persistence effect to run; it must not rewrite CAS to the live snapshot.
    await act(async () => {
      await Promise.resolve();
    });

    const stored = loadAiProviderPublicDraft('provider-1');
    expect(stored?.baseRevision).toBe(1);
    expect(stored?.draftToken).toBe(staleToken);

    // Reload the hook against the same live snapshot — conflict must still be true.
    const { result: reloaded } = renderHook(() => useAiProviderEditor(liveSnapshot));
    expect(reloaded.current.conflict).toBe(true);
    expect(reloaded.current.draft?.displayName).toBe('Stale local name');

    // Rerender with identical props should not clear conflict either.
    rerender({ snap: liveSnapshot });
    expect(result.current.conflict).toBe(true);
  });
});
