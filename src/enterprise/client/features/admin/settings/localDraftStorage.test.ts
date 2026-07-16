// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';

import {
  buildLocalDraftKey,
  clearLocalDraft,
  loadLocalDraft,
  saveLocalDraft,
} from './localDraftStorage';
import {
  clearConflictDraft,
  loadConflictDraft,
  saveConflictDraft,
} from './settingsPolicyController';

describe('localDraftStorage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('restores draft keyed by registry + base revision', () => {
    saveLocalDraft({
      baseRevision: 2,
      draft: {
        'general.fontSize': {
          mode: 'default',
          schemaVersion: 1,
          value: 18,
          visibility: 'visible',
        },
      },
      registryVersion: 1,
      savedAt: new Date().toISOString(),
    });
    const loaded = loadLocalDraft(1, 2);
    expect(loaded?.draft['general.fontSize']?.value).toBe(18);
    expect(loadLocalDraft(1, 3)).toBeNull();
  });

  it('conflict draft survives revision-keyed key change (U7)', () => {
    saveConflictDraft({
      draft: {
        x: { mode: 'locked', schemaVersion: 1, value: true, visibility: 'visible' },
      },
      originalBaseDraft: {
        x: { mode: 'user', schemaVersion: 1, value: false, visibility: 'visible' },
      },
      previousBaseRevision: 1,
      registryVersion: 1,
      savedAt: new Date().toISOString(),
    });
    const loaded = loadConflictDraft();
    expect(loaded?.draft.x?.mode).toBe('locked');
    expect(loaded?.originalBaseDraft.x?.value).toBe(false);
    clearConflictDraft();
    expect(loadConflictDraft()).toBeNull();
  });

  it('buildLocalDraftKey is stable', () => {
    expect(buildLocalDraftKey(1, 0)).toContain('v1');
    expect(buildLocalDraftKey(1, 0)).toContain('r0');
    clearLocalDraft(1, 0);
  });
});
