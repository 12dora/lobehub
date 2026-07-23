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
      modelParameters: { temperature: 0.5 },
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

  it('round-trips a fully contract-valid draft and clears only the selected Agent', () => {
    const value = baseValue();
    expect(saveAdminAgentDraft('agent-1', value)).toBe('saved');
    expect(loadAdminAgentDraft('agent-1')).toEqual(value);
    clearAdminAgentDraft('agent-1');
    expect(loadAdminAgentDraft('agent-1')).toBeNull();
  });

  it('persists an in-progress draft whose model is not yet resolved (null model)', () => {
    const value = baseValue();
    value.draft.dependencies.model = null;
    expect(saveAdminAgentDraft('agent-1', value)).toBe('saved');
    expect(loadAdminAgentDraft('agent-1')?.draft.dependencies.model).toBeNull();
  });

  it('removes malformed JSON instead of hydrating it', () => {
    localStorage.setItem(key, '{bad');
    expect(loadAdminAgentDraft('agent-1')).toBeNull();
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('rejects schema drift (unknown keys / wrong types) on read and purges it', () => {
    localStorage.setItem(key, JSON.stringify({ ...baseValue(), extra: 'nope' }));
    expect(loadAdminAgentDraft('agent-1')).toBeNull();
    expect(localStorage.getItem(key)).toBeNull();
  });

  describe('recovery validation on write', () => {
    it.each([
      ['unfinished SemVer version', (v: StoredAdminAgentDraft) => (v.draft.version = '1.')],
      [
        'unfinished provider checksum',
        (v: StoredAdminAgentDraft) => (v.draft.dependencies.model!.providerChecksum = 'zz'),
      ],
      [
        'unresolved provider revision',
        (v: StoredAdminAgentDraft) => (v.draft.dependencies.model!.providerRevision = 0),
      ],
      [
        'temporarily out-of-range model parameter',
        (v: StoredAdminAgentDraft) => (v.draft.config.modelParameters.temperature = 9),
      ],
      ['empty display name', (v: StoredAdminAgentDraft) => (v.draft.config.displayName = '')],
      [
        'unfinished background color',
        (v: StoredAdminAgentDraft) => (v.draft.config.backgroundColor = '#1'),
      ],
    ])('persists %s so incomplete form input is recoverable', (_label, mutate) => {
      const value = baseValue();
      mutate(value);
      expect(saveAdminAgentDraft('agent-1', value)).toBe('saved');
      expect(loadAdminAgentDraft('agent-1')).toEqual(value);
    });

    it('keeps duplicate dependency references for authoritative submission validation', () => {
      const value = baseValue();
      const skill = { checksum: 'c'.repeat(64), skillKey: 'writer', version: '1.0.0' };
      value.draft.dependencies.skills = [skill, { ...skill }];
      expect(saveAdminAgentDraft('agent-1', value)).toBe('saved');
      expect(loadAdminAgentDraft('agent-1')).toEqual(value);
    });

    it('hydrates an incomplete persisted draft instead of deleting user input', () => {
      const value = baseValue();
      value.draft.dependencies.model!.providerChecksum = 'not-64-hex';
      localStorage.setItem(key, JSON.stringify(value));
      expect(loadAdminAgentDraft('agent-1')).toEqual(value);
      expect(localStorage.getItem(key)).not.toBeNull();
    });

    it('rejects malformed shape without erasing the last good recovery draft', () => {
      const original = baseValue();
      expect(saveAdminAgentDraft('agent-1', original)).toBe('saved');

      const malformed = baseValue() as unknown as {
        draft: { config: { displayName: number } };
      };
      malformed.draft.config.displayName = 42;
      expect(saveAdminAgentDraft('agent-1', malformed as unknown as StoredAdminAgentDraft)).toBe(
        'invalid',
      );
      expect(loadAdminAgentDraft('agent-1')).toEqual(original);
    });

    it('still enforces hard recovery bounds and envelope metadata types', () => {
      const tooManyQuestions = baseValue();
      tooManyQuestions.draft.config.openingQuestions = Array.from(
        { length: 51 },
        (_, index) => `q${index}`,
      );
      expect(saveAdminAgentDraft('agent-1', tooManyQuestions)).toBe('invalid');

      const invalidDate = baseValue();
      invalidDate.savedAt = 'yesterday';
      expect(saveAdminAgentDraft('agent-1', invalidDate)).toBe('invalid');
    });
  });

  describe('fail-closed secret / scan-exhaustion guard', () => {
    it('blocks a secret value in a text field without leaking it', () => {
      const value = baseValue();
      value.draft.config.systemRole = 'use api_key AKIA1234567890ABCD99 to call the tool';
      expect(saveAdminAgentDraft('agent-1', value)).toBe('blocked');
      expect(localStorage.getItem(key)).toBeNull();
    });

    it('blocks a draft carrying a sensitive field name', () => {
      const value = baseValue() as unknown as Record<string, unknown>;
      (value as { password?: string }).password = 'opaque';
      expect(saveAdminAgentDraft('agent-1', value as unknown as StoredAdminAgentDraft)).toBe(
        'blocked',
      );
      expect(localStorage.getItem(key)).toBeNull();
    });

    it('fails closed when a secret is truly visited only AFTER the >10k-node scan cap', () => {
      // The scan is a LIFO stack: the LAST-inserted key is popped first. To force the secret to be
      // reached only after the node budget is exhausted, insert it FIRST (bottom of the stack) and
      // the wide benign filler LAST (top of the stack, drained first).
      // Innocuous key names (no sensitive substring) so ONLY the deep value is a secret. Built in
      // one literal to preserve key order: `aaaDeep` first (bottom of the LIFO stack → visited last)
      // and `zzzFillerLast` last (top of the stack → drained first).
      const value: Record<string, unknown> = {
        aaaDeep: { note: 'AKIA1234567890ABCD99' },
        ...baseValue(),
        zzzFillerLast: Array.from({ length: 10_050 }, (_, i) => `safe-${i}`),
      };

      const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
      expect(bytes).toBeLessThanOrEqual(MAX_DRAFT_BYTES); // within size, yet un-scannable → blocked

      expect(saveAdminAgentDraft('agent-1', value as unknown as StoredAdminAgentDraft)).toBe(
        'blocked',
      );
      expect(localStorage.getItem(key)).toBeNull();
    });

    it('fails closed on a benign but un-scannably-large tree (within size)', () => {
      const value: Record<string, unknown> = {
        ...baseValue(),
        filler: Array.from({ length: 10_050 }, (_, i) => `benign-${i}`),
      };
      expect(new TextEncoder().encode(JSON.stringify(value)).length).toBeLessThanOrEqual(
        MAX_DRAFT_BYTES,
      );
      expect(saveAdminAgentDraft('agent-1', value as unknown as StoredAdminAgentDraft)).toBe(
        'blocked',
      );
      expect(localStorage.getItem(key)).toBeNull();
    });
  });

  it('rejects a contract-valid but oversized draft as too_large without persisting', () => {
    const value = baseValue();
    // Contract-valid (≤100 connectors, ≤1000 tools each, unique keys) but > MAX_DRAFT_BYTES bytes,
    // while staying under the node-scan cap so it reaches the size check, not the scan guard.
    value.draft.dependencies.connectors = Array.from({ length: 4 }, (_, c) => ({
      allowedToolKeys: Array.from({ length: 1000 }, (_, i) => `t${c}-${i}-${'x'.repeat(180)}`),
      connectorId: `connector-${c}`,
      connectorKey: `connector-${c}`,
      publishedChecksum: 'd'.repeat(64),
      publishedRevision: 1,
    }));
    expect(byteEstimate(value) > MAX_DRAFT_BYTES).toBe(true);
    expect(saveAdminAgentDraft('agent-1', value)).toBe('too_large');
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('reports unavailable when the storage write throws (quota / private mode)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });
    expect(saveAdminAgentDraft('agent-1', baseValue())).toBe('unavailable');
  });

  it('reports unavailable when serialization fails (circular structure)', () => {
    const value = baseValue();
    vi.spyOn(JSON, 'stringify').mockImplementation(() => {
      throw new TypeError('Converting circular structure to JSON');
    });
    expect(saveAdminAgentDraft('agent-1', value)).toBe('unavailable');
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('returns null (never throws) when reading throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('SecurityError');
    });
    expect(loadAdminAgentDraft('agent-1')).toBeNull();
  });
});

const byteEstimate = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
