/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from 'vitest';

import type { ManagedResourcePolicyMap } from '@/types/platform/managedResources';

import {
  clearManagedResourceLocalDraft,
  loadManagedResourceLocalDraft,
  MANAGED_RESOURCE_LOCAL_DRAFT_KEY,
  saveManagedResourceLocalDraft,
} from './localDraftStorage';

const draft: ManagedResourcePolicyMap = {
  agents: { enforcementMode: 'observe', managed: false },
  aiModels: { enforcementMode: 'observe', managed: false },
  aiProviders: { enforcementMode: 'observe', managed: false },
  connectors: { enforcementMode: 'ui-only', managed: true },
  skills: { enforcementMode: 'observe', managed: false },
};

afterEach(() => window.localStorage.clear());

describe('managed resource local draft storage', () => {
  it('survives reload-shaped reads with its CAS base', () => {
    saveManagedResourceLocalDraft({
      baseRevision: 8,
      draft,
      draftToken: 'a'.repeat(64),
      original: { ...draft, connectors: { enforcementMode: 'observe', managed: false } },
      savedAt: '2026-07-16T00:00:00.000Z',
    });

    expect(loadManagedResourceLocalDraft()).toMatchObject({
      baseRevision: 8,
      draftToken: 'a'.repeat(64),
    });
  });

  it('rejects malformed or incomplete five-resource payloads', () => {
    window.localStorage.setItem(
      MANAGED_RESOURCE_LOCAL_DRAFT_KEY,
      JSON.stringify({ baseRevision: 1, draft: {}, draftToken: 'x', original: {}, savedAt: 'x' }),
    );
    expect(loadManagedResourceLocalDraft()).toBeNull();
  });

  it('clears the recovery payload after save/publish', () => {
    window.localStorage.setItem(MANAGED_RESOURCE_LOCAL_DRAFT_KEY, '{}');
    clearManagedResourceLocalDraft();
    expect(window.localStorage.getItem(MANAGED_RESOURCE_LOCAL_DRAFT_KEY)).toBeNull();
  });
});
