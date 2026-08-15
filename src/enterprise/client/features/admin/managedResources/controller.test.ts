import { describe, expect, it } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import type {
  ManagedResourcePolicyMap,
  ManagedResourceReadinessMap,
} from '@/types/platform/managedResources';

import {
  buildManagedResourceDiff,
  deriveManagedResourcePermissions,
  fromManagedResourceUiMode,
  getUnreadyEnforcedResources,
  MANAGED_RESOURCE_NAV_LABEL_KEY,
  normalizeManagedResourcePolicyMap,
  toManagedResourceUiMode,
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

  it('maps legacy policies into the two-state UI and normalizes on save', () => {
    expect(toManagedResourceUiMode({ enforcementMode: 'enforced', managed: true })).toBe(
      'platform',
    );
    expect(toManagedResourceUiMode({ enforcementMode: 'ui-only', managed: true })).toBe('platform');
    expect(toManagedResourceUiMode({ enforcementMode: 'observe', managed: true })).toBe('user');
    expect(toManagedResourceUiMode({ enforcementMode: 'observe', managed: false })).toBe('user');
    expect(fromManagedResourceUiMode('platform')).toEqual({
      enforcementMode: 'enforced',
      managed: true,
    });
    expect(fromManagedResourceUiMode('user')).toEqual({
      enforcementMode: 'observe',
      managed: false,
    });

    const draft = policy();
    draft.skills = { enforcementMode: 'ui-only', managed: true };
    draft.connectors = { enforcementMode: 'observe', managed: true };
    const normalized = normalizeManagedResourcePolicyMap(draft);
    expect(normalized.skills).toEqual({ enforcementMode: 'enforced', managed: true });
    expect(normalized.connectors).toEqual({ enforcementMode: 'observe', managed: false });
  });

  it('aligns card labels with admin side-nav keys', () => {
    expect(MANAGED_RESOURCE_NAV_LABEL_KEY).toEqual({
      agents: 'nav.agents',
      aiModels: 'nav.aiServiceModel',
      aiProviders: 'nav.aiProviders',
      connectors: 'nav.aiConnectors',
      skills: 'nav.aiSkills',
    });
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
});
