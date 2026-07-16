import { describe, expect, it } from 'vitest';

import type { ManagedResourcesCapabilities } from '@/types/platform/capabilities';

import {
  getManagedResourceForSettingsTab,
  isSettingsTabManaged,
} from './managedResourcePresentation';

const disabled: ManagedResourcesCapabilities = {
  agents: false,
  aiModels: false,
  aiProviders: false,
  connectors: false,
  skills: false,
};

describe('managed resource settings presentation', () => {
  it('maps every legacy resource settings route to its public boolean', () => {
    expect(getManagedResourceForSettingsTab('provider')).toBe('aiProviders');
    expect(getManagedResourceForSettingsTab('service-model')).toBe('aiModels');
    expect(getManagedResourceForSettingsTab('skill')).toBe('skills');
    expect(getManagedResourceForSettingsTab('connector')).toBe('connectors');
    expect(getManagedResourceForSettingsTab('appearance')).toBeUndefined();
  });

  it('keeps exact flag-off parity and gates only the enabled resource', () => {
    expect(isSettingsTabManaged('provider', disabled)).toBe(false);
    expect(
      isSettingsTabManaged('provider', { ...disabled, aiProviders: true }),
    ).toBe(true);
    expect(
      isSettingsTabManaged('service-model', { ...disabled, aiProviders: true }),
    ).toBe(false);
  });
});
