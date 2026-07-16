// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';

import type { EditableSkillDraft } from './controller';
import {
  clearSkillLocalDraft,
  loadSkillLocalDraft,
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
  baseRevision: 3,
  draft,
  savedAt: '2026-07-17T00:00:00.000Z',
});

describe('M08 Skill local draft storage', () => {
  beforeEach(() => localStorage.clear());

  it('restores a bounded safe draft by Skill id without persisting extra reason fields', () => {
    const withReason = {
      ...payload(),
      reason: 'must never enter local storage',
    };
    expect(saveSkillLocalDraft('skill-1', withReason)).toBe('saved');
    expect(loadSkillLocalDraft('skill-1')).toEqual(payload());
    expect(localStorage.getItem('aihub.admin.skills.draft.skill-1')).not.toContain('must never');
    expect(loadSkillLocalDraft('skill-2')).toBeNull();
  });

  it.each([
    'Bearer sk-fake-not-real-content',
    '-----BEGIN PRIVATE KEY----- fake material',
    'Connect to postgres://admin:password@db.internal/catalog',
    '{"type":"service_account","project_id":"example"}',
  ])('fails closed and removes durable recovery for suspicious material: %s', (content) => {
    expect(saveSkillLocalDraft('skill-1', payload())).toBe('saved');
    expect(saveSkillLocalDraft('skill-1', payload(editableDraft(content)))).toBe('sensitive');
    expect(loadSkillLocalDraft('skill-1')).toBeNull();
  });

  it('keeps invalid in-progress JSON in memory only', () => {
    const draft = editableDraft();
    draft.versionDraft = { ...draft.versionDraft!, manifestText: '{invalid' };
    expect(saveSkillLocalDraft('skill-1', payload(draft))).toBe('invalid');
    expect(loadSkillLocalDraft('skill-1')).toBeNull();
  });

  it('clears only the selected Skill recovery slot', () => {
    expect(saveSkillLocalDraft('skill-1', payload())).toBe('saved');
    expect(saveSkillLocalDraft('skill-2', payload())).toBe('saved');
    clearSkillLocalDraft('skill-1');
    expect(loadSkillLocalDraft('skill-1')).toBeNull();
    expect(loadSkillLocalDraft('skill-2')).not.toBeNull();
  });
});
