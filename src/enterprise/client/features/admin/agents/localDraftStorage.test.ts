import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearAdminAgentDraft,
  loadAdminAgentDraft,
  MAX_DRAFT_BYTES,
  saveAdminAgentDraft,
  type StoredAdminAgentDraft,
} from './localDraftStorage';

const baseValue = (): StoredAdminAgentDraft => ({
  draft: {
    config: {
      avatar: null,
      backgroundColor: null,
      description: null,
      displayName: 'Research',
      modelParameters: {},
      openingMessage: null,
      openingQuestions: [],
      systemRole: 'Research carefully.',
      tags: [],
    },
    dependencies: {
      connectors: [],
      model: {
        modelKey: 'gpt-4.1',
        providerChecksum: 'a'.repeat(64),
        providerKey: 'openai',
        providerRevision: 1,
      },
      skills: [],
    },
    version: '1.0.1',
  },
  draftToken: 'b'.repeat(64),
  revision: 3,
  savedAt: '2026-07-17T00:00:00.000Z',
});

const key = 'aihub.admin.agents.draft.agent-1';

describe('admin Agent recovery draft storage', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('round-trips a valid draft and clears only the selected Agent', () => {
    const value = baseValue();
    expect(saveAdminAgentDraft('agent-1', value)).toBe('saved');
    expect(loadAdminAgentDraft('agent-1')).toEqual(value);
    clearAdminAgentDraft('agent-1');
    expect(loadAdminAgentDraft('agent-1')).toBeNull();
  });

  it('tolerates an in-progress draft with a null (unresolved) model', () => {
    const value = baseValue();
    value.draft.dependencies.model = null;
    value.draft.config.displayName = '';
    expect(saveAdminAgentDraft('agent-1', value)).toBe('saved');
    expect(loadAdminAgentDraft('agent-1')?.draft.dependencies.model).toBeNull();
  });

  it('removes malformed JSON instead of hydrating it', () => {
    localStorage.setItem(key, '{bad');
    expect(loadAdminAgentDraft('agent-1')).toBeNull();
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('rejects schema drift (wrong types / unknown keys) and purges it', () => {
    localStorage.setItem(key, JSON.stringify({ draft: { config: 'nope' }, draftToken: 1 }));
    expect(loadAdminAgentDraft('agent-1')).toBeNull();
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('blocks secret-bearing drafts without persisting or leaking the content', () => {
    const value = baseValue();
    value.draft.config.systemRole = 'use api_key AKIA1234567890ABCD99 to call the tool';
    expect(saveAdminAgentDraft('agent-1', value)).toBe('blocked');
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('blocks drafts that carry a sensitive field name', () => {
    const value = baseValue() as unknown as Record<string, unknown>;
    (value as { password?: string }).password = 'opaque';
    expect(saveAdminAgentDraft('agent-1', value as unknown as StoredAdminAgentDraft)).toBe(
      'blocked',
    );
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('rejects an oversized draft as too_large without persisting', () => {
    const value = baseValue();
    value.draft.config.systemRole = 'x'.repeat(MAX_DRAFT_BYTES + 1);
    expect(saveAdminAgentDraft('agent-1', value)).toBe('too_large');
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('reports unavailable when the storage write throws (quota / private mode)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });
    expect(saveAdminAgentDraft('agent-1', baseValue())).toBe('unavailable');
  });

  it('returns null (never throws) when reading throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('SecurityError');
    });
    expect(loadAdminAgentDraft('agent-1')).toBeNull();
  });
});
