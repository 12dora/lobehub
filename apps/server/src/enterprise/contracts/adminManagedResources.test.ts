import { describe, expect, it } from 'vitest';

import {
  adminManagedResourcesPublishInputSchema,
  adminManagedResourcesSaveDraftInputSchema,
  managedResourcePolicyMapSchema,
} from './adminManagedResources';

const validMap = {
  agents: { enforcementMode: 'observe', managed: false },
  aiModels: { enforcementMode: 'ui-only', managed: true },
  aiProviders: { enforcementMode: 'enforced', managed: true },
  connectors: { enforcementMode: 'observe', managed: false },
  skills: { enforcementMode: 'observe', managed: false },
};

describe('admin managed-resource contracts', () => {
  it('accepts only the exact five resources and progressive modes', () => {
    expect(managedResourcePolicyMapSchema.parse(validMap)).toEqual(validMap);
    expect(() =>
      managedResourcePolicyMapSchema.parse({ ...validMap, providers: validMap.aiProviders }),
    ).toThrow();
    const { agents: _agents, ...missing } = validMap;
    expect(() => managedResourcePolicyMapSchema.parse(missing)).toThrow();
    expect(() =>
      managedResourcePolicyMapSchema.parse({
        ...validMap,
        agents: { enforcementMode: 'disabled', managed: true },
      }),
    ).toThrow();
  });

  it('requires CAS tokens and non-empty reasons and rejects unknown input keys', () => {
    const input = {
      draft: validMap,
      expectedDraftToken: 'a'.repeat(64),
      reason: 'progressive rollout',
    };
    expect(adminManagedResourcesSaveDraftInputSchema.parse(input)).toEqual(input);
    expect(() =>
      adminManagedResourcesSaveDraftInputSchema.parse({ ...input, extra: true }),
    ).toThrow();
    expect(() =>
      adminManagedResourcesSaveDraftInputSchema.parse({ ...input, reason: ' ' }),
    ).toThrow();
    expect(() =>
      adminManagedResourcesPublishInputSchema.parse({
        expectedDraftToken: 'short',
        expectedRevision: 0,
        reason: 'publish',
      }),
    ).toThrow();
  });
});
