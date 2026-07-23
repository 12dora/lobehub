import { describe, expect, it } from 'vitest';

import {
  MANAGED_RESOURCE_ENFORCEMENT_MODES,
  MANAGED_RESOURCE_KINDS,
} from '@/const/platform/managedResources';

import {
  adminManagedResourcesPublishInputSchema,
  adminManagedResourcesSaveDraftInputSchema,
  managedResourceEnforcementModeSchema,
  managedResourcePolicyMapSchema,
  managedResourceReadinessMapSchema,
} from './adminManagedResources';

const validMap = {
  agents: { enforcementMode: 'observe', managed: false },
  aiModels: { enforcementMode: 'ui-only', managed: true },
  aiProviders: { enforcementMode: 'enforced', managed: true },
  connectors: { enforcementMode: 'observe', managed: false },
  skills: { enforcementMode: 'observe', managed: false },
};

const secretReason = 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz012345';

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

  it('stays in parity with shared MANAGED_RESOURCE_KINDS and enforcement modes', () => {
    expect([...MANAGED_RESOURCE_KINDS].sort()).toEqual(
      Object.keys(managedResourcePolicyMapSchema.shape).sort(),
    );
    expect([...MANAGED_RESOURCE_KINDS].sort()).toEqual(
      Object.keys(managedResourceReadinessMapSchema.shape).sort(),
    );
    for (const mode of MANAGED_RESOURCE_ENFORCEMENT_MODES) {
      expect(managedResourceEnforcementModeSchema.parse(mode)).toBe(mode);
    }
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

  it('rejects secret material in reasons and publication comments', () => {
    expect(
      adminManagedResourcesSaveDraftInputSchema.safeParse({
        draft: validMap,
        expectedDraftToken: 'a'.repeat(64),
        reason: secretReason,
      }).success,
    ).toBe(false);
    expect(
      adminManagedResourcesPublishInputSchema.safeParse({
        comment: secretReason,
        expectedDraftToken: 'a'.repeat(64),
        expectedRevision: 0,
        reason: 'publish managed policy',
      }).success,
    ).toBe(false);
  });
});
