// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EditableSkillDraft } from './controller';
import {
  clearSkillLocalDraft,
  loadSkillLocalDraft,
  MAX_SKILL_LOCAL_DRAFT_BYTES,
  saveSkillLocalDraft,
  type StoredSkillDraft,
} from './localDraftStorage';

const manifest = {
  description: 'Safe Skill',
  displayName: 'Safe Skill',
  localizedDescriptions: {},
  localizedDisplayNames: {},
  permissions: {
    filesystem: 'none',
    network: { allowedHosts: [], enabled: false },
    tools: { allow: [] },
  },
  skillDependencies: [],
  toolDependencies: [],
};

const editableDraft = (content = '# Safe content'): EditableSkillDraft => ({
  identity: {
    description: 'Safe description',
    displayName: 'Safe Skill',
    distribution: 'default',
    enabled: true,
  },
  versionDraft: {
    content,
    contentRef: '',
    manifestText: JSON.stringify(manifest),
    resourcesText: '[]',
    version: '1.0.0',
  },
});

const payload = (draft = editableDraft()): StoredSkillDraft => ({
  baseDraft: editableDraft(),
  baseDraftSequence: 3,
  baseRevision: 3,
  draft,
  savedAt: '2026-07-17T00:00:00.000Z',
});

const key = 'aihub.admin.skills.draft.skill-1';

describe('M08 Skill local draft storage', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('restores a bounded safe draft by Skill id without persisting extra reason fields', () => {
    const withReason = {
      ...payload(),
      reason: 'must never enter local storage',
    };
    expect(saveSkillLocalDraft('skill-1', withReason)).toBe('saved');
    expect(loadSkillLocalDraft('skill-1')).toEqual(payload());
    expect(localStorage.getItem(key)).not.toContain('must never');
    expect(loadSkillLocalDraft('skill-2')).toBeNull();
  });

  it.each([
    'Bearer sk-fake-not-real-content',
    '-----BEGIN PRIVATE KEY----- fake material',
    'Connect to postgres://admin:password@db.internal/catalog',
    '{"type":"service_account","project_id":"example"}',
    'use api_key AKIA1234567890ABCD99 to call the tool',
  ])('fails closed and removes durable recovery for suspicious material: %s', (content) => {
    expect(saveSkillLocalDraft('skill-1', payload())).toBe('saved');
    expect(saveSkillLocalDraft('skill-1', payload(editableDraft(content)))).toBe('sensitive');
    expect(loadSkillLocalDraft('skill-1')).toBeNull();
  });

  it('persists incomplete JSON drafts for crash recovery and reloads them intact', () => {
    const draft = editableDraft();
    draft.versionDraft = { ...draft.versionDraft!, manifestText: '{invalid' };
    expect(saveSkillLocalDraft('skill-1', payload(draft))).toBe('saved');

    const restored = loadSkillLocalDraft('skill-1');
    expect(restored?.draft.versionDraft?.manifestText).toBe('{invalid');

    // Repair and re-save — recovery entry remains usable through the edit cycle.
    const repaired = structuredClone(restored!.draft);
    repaired.versionDraft = {
      ...repaired.versionDraft!,
      manifestText: JSON.stringify(manifest),
    };
    expect(saveSkillLocalDraft('skill-1', { ...restored!, draft: repaired })).toBe('saved');
    expect(loadSkillLocalDraft('skill-1')?.draft.versionDraft?.manifestText).toBe(
      JSON.stringify(manifest),
    );
  });

  it.each([
    ['oversized payload', 'x'.repeat(MAX_SKILL_LOCAL_DRAFT_BYTES + 1)],
    ['malformed JSON', '{malformed'],
    [
      'strict-invalid payload',
      JSON.stringify({ ...payload(), unexpectedCredential: 'must-not-survive' }),
    ],
  ])('removes an unusable recovery entry immediately: %s', (_name, raw) => {
    localStorage.setItem(key, raw);
    expect(loadSkillLocalDraft('skill-1')).toBeNull();
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('rejects oversized writes as too_large without persisting', () => {
    // Envelope size gate runs on the raw payload before whitelist normalization.
    const oversized = {
      ...payload(),
      pad: 'z'.repeat(MAX_SKILL_LOCAL_DRAFT_BYTES),
    } as unknown as StoredSkillDraft;
    expect(saveSkillLocalDraft('skill-1', oversized)).toBe('too_large');
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('reports unavailable when serialization fails', () => {
    const value = payload();
    vi.spyOn(JSON, 'stringify').mockImplementation(() => {
      throw new TypeError('Converting circular structure to JSON');
    });
    expect(saveSkillLocalDraft('skill-1', value)).toBe('unavailable');
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('reports unavailable when storage write throws (quota / private mode)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });
    expect(saveSkillLocalDraft('skill-1', payload())).toBe('unavailable');
  });

  it('clears only the selected Skill recovery slot', () => {
    expect(saveSkillLocalDraft('skill-1', payload())).toBe('saved');
    expect(saveSkillLocalDraft('skill-2', payload())).toBe('saved');
    clearSkillLocalDraft('skill-1');
    expect(loadSkillLocalDraft('skill-1')).toBeNull();
    expect(loadSkillLocalDraft('skill-2')).not.toBeNull();
  });
});
