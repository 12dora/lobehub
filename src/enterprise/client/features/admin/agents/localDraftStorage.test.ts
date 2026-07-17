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

  describe('authoritative contract validation on write', () => {
    it.each([
      ['invalid SemVer version', (v: StoredAdminAgentDraft) => (v.draft.version = 'not-semver')],
      [
        'non-hex provider checksum',
        (v: StoredAdminAgentDraft) => (v.draft.dependencies.model!.providerChecksum = 'zz'),
      ],
      [
        'non-positive provider revision',
        (v: StoredAdminAgentDraft) => (v.draft.dependencies.model!.providerRevision = 0),
      ],
      [
        'out-of-range model parameter',
        (v: StoredAdminAgentDraft) => (v.draft.config.modelParameters.temperature = 9),
      ],
      [
        'too many opening questions',
        (v: StoredAdminAgentDraft) =>
          (v.draft.config.openingQuestions = Array.from({ length: 51 }, (_, i) => `q${i}`)),
      ],
      ['empty display name', (v: StoredAdminAgentDraft) => (v.draft.config.displayName = '')],
      ['invalid savedAt date', (v: StoredAdminAgentDraft) => (v.savedAt = 'yesterday')],
    ])('rejects %s as invalid without persisting', (_label, mutate) => {
      const value = baseValue();
      mutate(value);
      expect(saveAdminAgentDraft('agent-1', value)).toBe('invalid');
      expect(localStorage.getItem(key)).toBeNull();
    });

    it('rejects duplicate skill references as invalid', () => {
      const value = baseValue();
      const skill = { checksum: 'c'.repeat(64), skillKey: 'writer', version: '1.0.0' };
      value.draft.dependencies.skills = [skill, { ...skill }];
      expect(saveAdminAgentDraft('agent-1', value)).toBe('invalid');
    });

    it('rejects a drifted persisted draft on read (bad checksum) and purges it', () => {
      const value = baseValue();
      value.draft.dependencies.model!.providerChecksum = 'not-64-hex';
      localStorage.setItem(key, JSON.stringify(value));
      expect(loadAdminAgentDraft('agent-1')).toBeNull();
      expect(localStorage.getItem(key)).toBeNull();
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

    it('fails closed on a >10k-node tree hiding a secret PAST the scan cap', () => {
      // A wide array pushes the secret beyond the node budget; the scan must not silently pass.
      const value = baseValue() as unknown as { filler: unknown[]; late: { systemRole: string } };
      value.filler = Array.from({ length: 10_050 }, () => 'safe');
      value.late = { systemRole: 'AKIA1234567890ABCD99' };
      expect(saveAdminAgentDraft('agent-1', value as unknown as StoredAdminAgentDraft)).toBe(
        'blocked',
      );
      expect(localStorage.getItem(key)).toBeNull();
    });

    it('fails closed on a benign but un-scannably-large tree', () => {
      const value = baseValue() as unknown as { filler: unknown[] };
      value.filler = Array.from({ length: 10_050 }, (_, i) => `benign-${i}`);
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

  it('returns null (never throws) when reading throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('SecurityError');
    });
    expect(loadAdminAgentDraft('agent-1')).toBeNull();
  });
});

const byteEstimate = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
