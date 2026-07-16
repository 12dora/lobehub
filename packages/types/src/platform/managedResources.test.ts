import { describe, expect, it } from 'vitest';

import {
  MANAGED_POLICY_RESOURCE_ID,
  MANAGED_POLICY_RESOURCE_TYPE,
  type ManagedResourcePolicyMap,
} from './managedResources';

describe('managed resource policy types', () => {
  it('uses the aggregate managed-policy revision identity', () => {
    expect(MANAGED_POLICY_RESOURCE_TYPE).toBe('managed_policy');
    expect(MANAGED_POLICY_RESOURCE_ID).toBe('global');
  });

  it('represents all five policy items without internal payload fields', () => {
    const policies: ManagedResourcePolicyMap = {
      agents: { enforcementMode: 'observe', managed: false },
      aiModels: { enforcementMode: 'observe', managed: false },
      aiProviders: { enforcementMode: 'ui-only', managed: true },
      connectors: { enforcementMode: 'observe', managed: false },
      skills: { enforcementMode: 'enforced', managed: true },
    };
    expect(Object.keys(policies)).toHaveLength(5);
    expect(JSON.stringify(policies)).not.toMatch(/rule|secret|token/i);
  });
});
