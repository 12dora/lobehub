// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';

import {
  buildLocalDraftKey,
  clearLocalDraft,
  loadLocalDraft,
  saveLocalDraft,
  SETTINGS_POLICY_LOCAL_DRAFT_TTL_MS,
} from './localDraftStorage';
import {
  clearConflictDraft,
  CONFLICT_DRAFT_KEY,
  loadConflictDraft,
  saveConflictDraft,
  SETTINGS_POLICY_CONFLICT_DRAFT_TTL_MS,
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
      draftToken: 'a'.repeat(64),
      originalBaseDraft: {},
      registryVersion: 1,
      savedAt: new Date().toISOString(),
    });
    const loaded = loadLocalDraft(1, 2);
    expect(loaded?.draft['general.fontSize']?.value).toBe(18);
    expect(loaded?.draftToken).toBe('a'.repeat(64));
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
      previousDraftToken: 'a'.repeat(64),
      registryVersion: 1,
      savedAt: new Date().toISOString(),
    });
    const loaded = loadConflictDraft();
    expect(loaded?.draft.x?.mode).toBe('locked');
    expect(loaded?.originalBaseDraft.x?.value).toBe(false);
    expect(loaded?.previousDraftToken).toBe('a'.repeat(64));
    clearConflictDraft();
    expect(loadConflictDraft()).toBeNull();
  });

  it('buildLocalDraftKey is stable', () => {
    expect(buildLocalDraftKey(1, 0)).toContain('v1');
    expect(buildLocalDraftKey(1, 0)).toContain('r0');
    clearLocalDraft(1, 0);
  });

  it('removes expired recovery and conflict records', () => {
    const expired = new Date(Date.now() - SETTINGS_POLICY_LOCAL_DRAFT_TTL_MS - 1).toISOString();
    saveLocalDraft({
      baseRevision: 2,
      draft: {},
      draftToken: 'a'.repeat(64),
      originalBaseDraft: {},
      registryVersion: 1,
      savedAt: expired,
    });
    expect(loadLocalDraft(1, 2)).toBeNull();
    expect(window.localStorage.getItem(buildLocalDraftKey(1, 2))).toBeNull();

    saveConflictDraft({
      draft: {},
      originalBaseDraft: {},
      previousBaseRevision: 2,
      previousDraftToken: 'a'.repeat(64),
      registryVersion: 1,
      savedAt: new Date(Date.now() - SETTINGS_POLICY_CONFLICT_DRAFT_TTL_MS - 1).toISOString(),
    });
    expect(loadConflictDraft()).toBeNull();
    expect(window.localStorage.getItem(CONFLICT_DRAFT_KEY)).toBeNull();
  });

  it('prunes older revision records after a successful write', () => {
    const payload = {
      draft: {},
      draftToken: 'a'.repeat(64),
      originalBaseDraft: {},
      registryVersion: 1,
      savedAt: new Date().toISOString(),
    };
    saveLocalDraft({ ...payload, baseRevision: 1 });
    saveLocalDraft({ ...payload, baseRevision: 2 });

    expect(window.localStorage.getItem(buildLocalDraftKey(1, 1))).toBeNull();
    expect(window.localStorage.getItem(buildLocalDraftKey(1, 2))).not.toBeNull();
  });

  it('rejects oversized recovery records', () => {
    saveLocalDraft({
      baseRevision: 2,
      draft: {
        large: {
          mode: 'default',
          schemaVersion: 1,
          value: 'x'.repeat(600_000),
          visibility: 'visible',
        },
      },
      draftToken: 'a'.repeat(64),
      originalBaseDraft: {},
      registryVersion: 1,
      savedAt: new Date().toISOString(),
    });

    expect(window.localStorage.getItem(buildLocalDraftKey(1, 2))).toBeNull();
  });

  it.each([
    ['local draft', buildLocalDraftKey(1, 2), false],
    ['conflict draft', CONFLICT_DRAFT_KEY, true],
  ])('purges structurally invalid %s records', (_label, key, conflict) => {
    const metadata = conflict
      ? {
          previousBaseRevision: 2,
          previousDraftToken: 'a'.repeat(64),
          registryVersion: 1,
          savedAt: new Date().toISOString(),
        }
      : {
          baseRevision: 2,
          draftToken: 'a'.repeat(64),
          registryVersion: 1,
          savedAt: new Date().toISOString(),
        };

    window.localStorage.setItem(
      key,
      JSON.stringify({ ...metadata, draft: 'not-a-draft-map', originalBaseDraft: {} }),
    );
    expect(conflict ? loadConflictDraft() : loadLocalDraft(1, 2)).toBeNull();
    expect(window.localStorage.getItem(key)).toBeNull();

    window.localStorage.setItem(
      key,
      JSON.stringify({ ...metadata, draft: {}, originalBaseDraft: 'not-a-draft-map' }),
    );
    expect(conflict ? loadConflictDraft() : loadLocalDraft(1, 2)).toBeNull();
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it.each([
    ['local draft', buildLocalDraftKey(1, 2), false],
    ['conflict draft', CONFLICT_DRAFT_KEY, true],
  ])('purges secret-bearing %s records', (_label, key, conflict) => {
    const secretDraft = {
      x: {
        mode: 'locked',
        schemaVersion: 1,
        value: { apiKey: 'must-never-survive-recovery' },
        visibility: 'hidden',
      },
    };
    const metadata = conflict
      ? {
          previousBaseRevision: 2,
          previousDraftToken: 'a'.repeat(64),
          registryVersion: 1,
          savedAt: new Date().toISOString(),
        }
      : {
          baseRevision: 2,
          draftToken: 'a'.repeat(64),
          registryVersion: 1,
          savedAt: new Date().toISOString(),
        };

    window.localStorage.setItem(
      key,
      JSON.stringify({ ...metadata, draft: secretDraft, originalBaseDraft: {} }),
    );

    expect(conflict ? loadConflictDraft() : loadLocalDraft(1, 2)).toBeNull();
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it.each([
    ['local draft', buildLocalDraftKey(1, 2), false],
    ['conflict draft', CONFLICT_DRAFT_KEY, true],
  ])('purges oversized raw %s records', (_label, key, conflict) => {
    const metadata = conflict
      ? {
          previousBaseRevision: 2,
          previousDraftToken: 'a'.repeat(64),
          registryVersion: 1,
          savedAt: new Date().toISOString(),
        }
      : {
          baseRevision: 2,
          draftToken: 'a'.repeat(64),
          registryVersion: 1,
          savedAt: new Date().toISOString(),
        };
    window.localStorage.setItem(
      key,
      JSON.stringify({
        ...metadata,
        draft: {},
        originalBaseDraft: {},
        padding: 'x'.repeat(600_000),
      }),
    );

    expect(conflict ? loadConflictDraft() : loadLocalDraft(1, 2)).toBeNull();
    expect(window.localStorage.getItem(key)).toBeNull();
  });
});
