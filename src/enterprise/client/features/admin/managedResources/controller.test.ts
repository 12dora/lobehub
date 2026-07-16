import { describe, expect, it } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import type {
  ManagedResourcePolicyMap,
  ManagedResourceReadinessMap,
} from '@/types/platform/managedResources';

import {
  buildManagedResourceDiff,
  deriveManagedResourcePermissions,
  getUnreadyEnforcedResources,
  rebaseManagedResourceDraft,
  resolveManagedResourcePrimaryAction,
} from './controller';

const policy = (): ManagedResourcePolicyMap => ({
  agents: { enforcementMode: 'observe', managed: false },
  aiModels: { enforcementMode: 'observe', managed: false },
  aiProviders: { enforcementMode: 'observe', managed: false },
  connectors: { enforcementMode: 'observe', managed: false },
  skills: { enforcementMode: 'observe', managed: false },
});

const readiness = (): ManagedResourceReadinessMap => ({
  agents: false,
  aiModels: false,
  aiProviders: false,
  connectors: false,
  skills: false,
});

describe('managed resource policy controller', () => {
  it('derives independent read, update, and publish permissions', () => {
    expect(deriveManagedResourcePermissions([PLATFORM_PERMISSIONS.POLICY_READ])).toEqual({
      canPublish: false,
      canUpdate: false,
      canView: true,
    });
    expect(
      deriveManagedResourcePermissions([
        PLATFORM_PERMISSIONS.POLICY_READ,
        PLATFORM_PERMISSIONS.POLICY_UPDATE,
        PLATFORM_PERMISSIONS.POLICY_PUBLISH,
      ]),
    ).toEqual({ canPublish: true, canUpdate: true, canView: true });
  });

  it('requires readiness only for managed enforced resources', () => {
    const draft = policy();
    draft.aiProviders = { enforcementMode: 'enforced', managed: true };
    draft.skills = { enforcementMode: 'ui-only', managed: true };

    expect(getUnreadyEnforcedResources(draft, readiness())).toEqual(['aiProviders']);
  });

  it('builds a five-key impact diff without reporting unchanged resources', () => {
    const published = policy();
    const draft = policy();
    draft.connectors = { enforcementMode: 'ui-only', managed: true };

    expect(buildManagedResourceDiff(published, draft)).toEqual([
      {
        after: { enforcementMode: 'ui-only', managed: true },
        before: { enforcementMode: 'observe', managed: false },
        resource: 'connectors',
      },
    ]);
  });

  it('keeps exactly one primary action and blocks publish during conflict/readiness failure', () => {
    const base = {
      canPublish: true,
      canUpdate: true,
      conflict: false,
      dirty: true,
      hasChanges: true,
      publishReady: true,
      saveState: 'dirty' as const,
    };
    expect(resolveManagedResourcePrimaryAction(base)).toBe('save');
    expect(resolveManagedResourcePrimaryAction({ ...base, dirty: false, saveState: 'saved' })).toBe(
      'publish',
    );
    expect(
      resolveManagedResourcePrimaryAction({
        ...base,
        dirty: false,
        publishReady: false,
        saveState: 'saved',
      }),
    ).toBe('none');
    expect(resolveManagedResourcePrimaryAction({ ...base, conflict: true })).toBe('none');
  });

  it('rebases local edits while accepting latest values for untouched resources', () => {
    const original = policy();
    const local = policy();
    const latest = policy();
    local.skills = { enforcementMode: 'ui-only', managed: true };
    latest.aiModels = { enforcementMode: 'observe', managed: true };

    const rebased = rebaseManagedResourceDraft({ latest, local, original });
    expect(rebased.draft.skills).toEqual(local.skills);
    expect(rebased.draft.aiModels).toEqual(latest.aiModels);
    expect(rebased.conflicts).toEqual([]);
  });

  it('merges non-conflicting local and remote edits to different fields of one resource', () => {
    const original = policy();
    const local = policy();
    const latest = policy();
    local.connectors.managed = true;
    latest.connectors.enforcementMode = 'enforced';

    expect(rebaseManagedResourceDraft({ latest, local, original })).toEqual({
      conflicts: [],
      draft: {
        ...latest,
        connectors: { enforcementMode: 'enforced', managed: true },
      },
    });
  });

  it('reports divergent edits to the same field instead of silently choosing one', () => {
    const original = policy();
    const local = policy();
    const latest = policy();
    local.connectors.enforcementMode = 'ui-only';
    latest.connectors.enforcementMode = 'enforced';

    const rebased = rebaseManagedResourceDraft({ latest, local, original });
    expect(rebased.draft.connectors.enforcementMode).toBe('ui-only');
    expect(rebased.conflicts).toEqual([
      {
        field: 'enforcementMode',
        latestValue: 'enforced',
        localValue: 'ui-only',
        originalValue: 'observe',
        resource: 'connectors',
      },
    ]);
  });
});
