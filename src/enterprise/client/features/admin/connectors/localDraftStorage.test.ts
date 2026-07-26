import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StoredAdminConnectorDraft } from './localDraftStorage';
import {
  loadAdminConnectorDraft,
  MAX_CONNECTOR_DRAFT_BYTES,
  saveAdminConnectorDraft,
} from './localDraftStorage';

const baseValue = (): StoredAdminConnectorDraft => ({
  baseRevision: 1,
  draft: {
    credentialMode: 'none',
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
  draftToken: 'a'.repeat(64),
  savedAt: new Date(0).toISOString(),
});

const key = 'aihub.admin.connectors.draft.v2.connector-1';
const legacyKey = 'aihub.admin.connectors.draft.connector-1';

describe('Connector local draft storage', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('persists only public draft fields and never accepts a secret slot', () => {
    expect(saveAdminConnectorDraft('connector-1', baseValue())).toEqual({ status: 'saved' });

    const raw = localStorage.getItem(key);
    expect(raw).toBeTruthy();
    // secretIntent is safe metadata (operation only); secret *values* must never appear.
    expect(raw).not.toMatch(/bearerToken|apiKey|password|private-token/i);
    expect(JSON.parse(raw!).secretIntent).toBe('keep');
    expect(loadAdminConnectorDraft('connector-1')?.draft.displayName).toBe('Calendar');
  });

  it('strips unexpected secret-shaped fields on save and recovery', () => {
    const value = {
      ...baseValue(),
      draft: {
        ...baseValue().draft,
        credentialMode: 'shared_service_account',
        secret: 'must-not-persist',
      },
    } as unknown as StoredAdminConnectorDraft;
    expect(saveAdminConnectorDraft('connector-1', value)).toEqual({
      status: 'saved',
    });
    expect(localStorage.getItem(key)).not.toContain('must-not-persist');

    localStorage.setItem(key, JSON.stringify(value));
    expect(loadAdminConnectorDraft('connector-1')?.draft).not.toHaveProperty('secret');
    expect(localStorage.getItem(key)).not.toContain('must-not-persist');
  });

  it('fails closed when a secret value is pasted into a public field', () => {
    const value = baseValue();
    value.draft.description = 'rotate with AKIA1234567890ABCD99 immediately';
    expect(saveAdminConnectorDraft('connector-1', value)).toEqual({
      reason: 'unsafe',
      status: 'unavailable',
    });
    expect(localStorage.getItem(key)).toBeNull();
    expect(loadAdminConnectorDraft('connector-1')).toBeNull();
  });

  it('local_draft_rejects_arbitrary_current_secret_in_public_field', () => {
    const value = baseValue();
    value.draft.description = 'note: correct-horse-battery-staple is temporary';
    expect(
      saveAdminConnectorDraft('connector-1', value, {
        secretLeaves: ['correct-horse-battery-staple'],
      }),
    ).toEqual({ reason: 'unsafe', status: 'unavailable' });
    expect(localStorage.getItem(key)).toBeNull();
    expect(loadAdminConnectorDraft('connector-1')).toBeNull();
  });

  it('restored_clear_secret_intent_is_preserved', () => {
    const value = baseValue();
    value.secretIntent = 'clear';
    expect(saveAdminConnectorDraft('connector-1', value)).toEqual({ status: 'saved' });
    expect(loadAdminConnectorDraft('connector-1')?.secretIntent).toBe('clear');
  });

  it('preserves replace_requires_reentry intent without secret bytes', () => {
    const value = baseValue();
    value.secretIntent = 'replace_requires_reentry';
    expect(saveAdminConnectorDraft('connector-1', value)).toEqual({ status: 'saved' });
    const loaded = loadAdminConnectorDraft('connector-1');
    expect(loaded?.secretIntent).toBe('replace_requires_reentry');
    // Intent metadata only — never a replacement secret value.
    expect(JSON.stringify(loaded)).not.toContain('correct-horse');
    expect(JSON.stringify(loaded)).not.toMatch(/"value"\s*:/);
  });

  it('purges legacy pre-v2 draft entries that cannot be re-scanned', () => {
    const legacy = baseValue();
    legacy.draft.description = 'note: correct-horse-battery-staple is temporary';
    localStorage.setItem(legacyKey, JSON.stringify(legacy));
    expect(loadAdminConnectorDraft('connector-1')).toBeNull();
    expect(localStorage.getItem(legacyKey)).toBeNull();
  });

  it('fails closed when the scan node budget is exhausted', () => {
    const value = baseValue();
    // Whitelisted `tools` keeps filler after sanitize. Compact nodes stay under the byte cap
    // while exceeding the shared 10k-node scan budget → fail closed as un-scannable.
    value.draft.tools = Array.from(
      { length: 10_050 },
      (_, i) => i,
    ) as unknown as StoredAdminConnectorDraft['draft']['tools'];
    expect(new TextEncoder().encode(JSON.stringify(value)).length).toBeLessThanOrEqual(
      MAX_CONNECTOR_DRAFT_BYTES,
    );
    expect(saveAdminConnectorDraft('connector-1', value)).toEqual({
      reason: 'unsafe',
      status: 'unavailable',
    });
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('fails closed on oversized recovery payloads', () => {
    const value = baseValue();
    value.draft.description = 'x'.repeat(MAX_CONNECTOR_DRAFT_BYTES);
    expect(saveAdminConnectorDraft('connector-1', value)).toEqual({
      reason: 'oversized',
      status: 'unavailable',
    });
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('fails closed when serialization throws', () => {
    vi.spyOn(JSON, 'stringify').mockImplementation(() => {
      throw new TypeError('Converting circular structure to JSON');
    });
    expect(saveAdminConnectorDraft('connector-1', baseValue())).toEqual({
      reason: 'serialization',
      status: 'unavailable',
    });
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('fails closed when storage write throws (quota / private mode)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });
    expect(saveAdminConnectorDraft('connector-1', baseValue())).toEqual({
      reason: 'storage',
      status: 'unavailable',
    });
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('purges oversized or secret-bearing raw entries on load', () => {
    localStorage.setItem(key, 'x'.repeat(MAX_CONNECTOR_DRAFT_BYTES + 1));
    expect(loadAdminConnectorDraft('connector-1')).toBeNull();
    expect(localStorage.getItem(key)).toBeNull();

    const secretRaw = {
      ...baseValue(),
      draft: {
        ...baseValue().draft,
        description: '-----BEGIN PRIVATE KEY----- fake',
      },
    };
    localStorage.setItem(key, JSON.stringify(secretRaw));
    expect(loadAdminConnectorDraft('connector-1')).toBeNull();
    expect(localStorage.getItem(key)).toBeNull();
  });
});
