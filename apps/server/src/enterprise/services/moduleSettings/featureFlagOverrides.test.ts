// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IFeatureFlags } from '@/config/featureFlags';
import { DEFAULT_FEATURE_FLAGS, mapFeatureFlagsEnvToState } from '@/config/featureFlags';
import { ALL_MODULES_ENABLED, type PlatformModuleStateMap } from '@/const/platform/modules';

import { applyDisabledModuleFeatureFlagOverrides } from './featureFlagOverrides';
import * as moduleSettings from './index';

describe('applyDisabledModuleFeatureFlagOverrides', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forces knowledge_base off when the knowledgeBase module is disabled', async () => {
    const effective = { ...ALL_MODULES_ENABLED, knowledgeBase: false } as PlatformModuleStateMap;
    vi.spyOn(moduleSettings, 'getModuleSettingsSnapshot').mockResolvedValue({
      db: null,
      effective,
      envDisabled: ['knowledgeBase'],
      envDisabledBy: { knowledgeBase: 'LOBE_MODULES_DISABLED' },
      preset: null,
      presetFromEnv: 'full',
      revision: 0,
      setupCompletedAt: null,
    });

    const flags: IFeatureFlags = { ...DEFAULT_FEATURE_FLAGS, knowledge_base: true, rag_eval: true };
    const overridden = await applyDisabledModuleFeatureFlagOverrides(flags);

    expect(overridden.knowledge_base).toBe(false);
    expect(overridden.rag_eval).toBe(false);
    expect(mapFeatureFlagsEnvToState(overridden).enableKnowledgeBase).toBe(false);
    expect(mapFeatureFlagsEnvToState(overridden).enableRAGEval).toBe(false);
  });

  it('leaves flags unchanged when every module is enabled', async () => {
    vi.spyOn(moduleSettings, 'getModuleSettingsSnapshot').mockResolvedValue({
      db: null,
      effective: ALL_MODULES_ENABLED,
      envDisabled: [],
      envDisabledBy: {},
      preset: 'full',
      presetFromEnv: 'full',
      revision: 0,
      setupCompletedAt: null,
    });

    const flags: IFeatureFlags = { ...DEFAULT_FEATURE_FLAGS, knowledge_base: true };
    await expect(applyDisabledModuleFeatureFlagOverrides(flags)).resolves.toBe(flags);
  });
});
