import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminConnectorGetOutput } from './types';
import { useConnectorEditor } from './useConnectorEditor';

const mocks = vi.hoisted(() => ({
  confirmModal: vi.fn(),
  i18n: { language: 'en' },
  toastWarning: vi.fn(),
  useBlocker: vi.fn((): { state: 'unblocked' } => ({ state: 'unblocked' })),
  t: vi.fn((key: string) => key),
}));

vi.mock('react-router', () => ({
  useBlocker: mocks.useBlocker,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  confirmModal: mocks.confirmModal,
  toast: { warning: mocks.toastWarning },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ i18n: mocks.i18n, t: mocks.t }),
}));

const snapshot = (overrides: Partial<AdminConnectorGetOutput> = {}): AdminConnectorGetOutput => ({
  baseRevision: 2,
  draft: {
    connectionTest: null,
    credentialMode: 'shared_service_account',
    description: null,
    displayName: 'Calendar',
    enabled: true,
    endpoint: 'https://calendar.example.com/mcp',
    id: 'connector-1',
    key: 'calendar',
    oauthClientSecret: { configured: false, fingerprint: null, updatedAt: null },
    oauthConfig: null,
    revision: 2,
    sharedSecret: { configured: true, fingerprint: 'a'.repeat(64), updatedAt: null },
    sort: 0,
    status: 'draft',
    tools: [],
    transport: 'http',
  },
  draftToken: 'b'.repeat(64),
  published: null,
  ...overrides,
});

describe('useConnectorEditor', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('supplies_edited_secret_as_secretLeaves_and_rejects_localStorage_write', () => {
    const { result } = renderHook(() => useConnectorEditor(snapshot(), true));
    const secret = 'correct-horse-battery-staple-never-store';

    act(() => {
      result.current.changeSecret(secret);
    });

    // Intent metadata may persist; secret bytes must never appear.
    const key = 'aihub.admin.connectors.draft.v2.connector-1';
    const stored = localStorage.getItem(key);
    expect(stored).toBeTruthy();
    expect(stored).not.toContain(secret);
    expect(JSON.parse(stored!).secretIntent).toBe('replace_requires_reentry');
    expect(result.current.secret).toEqual({ operation: 'replace', value: secret });

    // When the live secret also lands in a public field, storage fails closed.
    act(() => {
      result.current.updateDraft('description', `note: ${secret}`);
    });
    expect(localStorage.getItem(key)).toBeNull();
    expect(mocks.toastWarning).toHaveBeenCalledWith('connectorCatalog.unsaved.recoveryUnavailable');
  });

  it('warns only once per editing session when recovery writes remain unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });
    const { result } = renderHook(() => useConnectorEditor(snapshot(), true));

    act(() => {
      result.current.updateDraft('description', 'First edit');
    });
    act(() => {
      result.current.updateDraft('description', 'Second edit');
    });

    expect(mocks.toastWarning).toHaveBeenCalledTimes(1);
    expect(mocks.toastWarning).toHaveBeenCalledWith('connectorCatalog.unsaved.recoveryUnavailable');
  });

  it('restored_replace_requires_reentry_blocks_save_until_reentered_or_dismissed', () => {
    localStorage.setItem(
      'aihub.admin.connectors.draft.v2.connector-1',
      JSON.stringify({
        baseRevision: 2,
        draft: {
          credentialMode: 'shared_service_account',
          description: '',
          displayName: 'Calendar',
          enabled: true,
          endpoint: 'https://calendar.example.com/mcp',
          oauthAuthorizationEndpoint: '',
          oauthClientId: '',
          oauthIssuer: '',
          oauthScopes: '',
          oauthTokenEndpoint: '',
          sort: 0,
          tools: [],
        },
        draftToken: 'b'.repeat(64),
        savedAt: new Date(0).toISOString(),
        secretIntent: 'replace_requires_reentry',
      }),
    );

    const { result } = renderHook(() => useConnectorEditor(snapshot(), true));

    expect(result.current.requiresSecretReentry).toBe(true);
    expect(result.current.restoreNotice).toBe('connectorCatalog.unsaved.secretReentry');
    expect(result.current.validation.valid).toBe(false);
    expect(result.current.secret.operation).toBe('keep');

    act(() => {
      result.current.changeSecret('reentered-secret-value');
    });
    expect(result.current.requiresSecretReentry).toBe(false);
    expect(result.current.secret.operation).toBe('replace');
    // Still invalid for save if secret leaks into storage, but reentry flag is cleared.
    expect(result.current.requiresSecretReentry).toBe(false);
  });

  it('restored_clear_intent_hydrates_clear_operation', () => {
    localStorage.setItem(
      'aihub.admin.connectors.draft.v2.connector-1',
      JSON.stringify({
        baseRevision: 2,
        draft: {
          credentialMode: 'shared_service_account',
          description: '',
          displayName: 'Calendar',
          enabled: true,
          endpoint: 'https://calendar.example.com/mcp',
          oauthAuthorizationEndpoint: '',
          oauthClientId: '',
          oauthIssuer: '',
          oauthScopes: '',
          oauthTokenEndpoint: '',
          sort: 0,
          tools: [],
        },
        draftToken: 'b'.repeat(64),
        savedAt: new Date(0).toISOString(),
        secretIntent: 'clear',
      }),
    );

    const { result } = renderHook(() => useConnectorEditor(snapshot(), true));
    expect(result.current.secret.operation).toBe('clear');
    expect(result.current.requiresSecretReentry).toBe(false);
    expect(result.current.restoreNotice).toBe('connectorCatalog.unsaved.secretClearRestored');
  });

  it('restore_notice_recomputes_when_translator_changes', () => {
    localStorage.setItem(
      'aihub.admin.connectors.draft.v2.connector-1',
      JSON.stringify({
        baseRevision: 2,
        draft: {
          credentialMode: 'shared_service_account',
          description: '',
          displayName: 'Calendar',
          enabled: true,
          endpoint: 'https://calendar.example.com/mcp',
          oauthAuthorizationEndpoint: '',
          oauthClientId: '',
          oauthIssuer: '',
          oauthScopes: '',
          oauthTokenEndpoint: '',
          sort: 0,
          tools: [],
        },
        draftToken: 'b'.repeat(64),
        savedAt: new Date(0).toISOString(),
        secretIntent: 'replace_requires_reentry',
      }),
    );

    mocks.i18n.language = 'en';
    mocks.t.mockImplementation((key: string) => `en:${key}`);
    const { result, rerender } = renderHook(() => useConnectorEditor(snapshot(), true));
    expect(result.current.restoreNotice).toBe('en:connectorCatalog.unsaved.secretReentry');

    mocks.i18n.language = 'zh-CN';
    mocks.t.mockImplementation((key: string) => `zh:${key}`);
    rerender();
    expect(result.current.restoreNotice).toBe('zh:connectorCatalog.unsaved.secretReentry');
  });
});
