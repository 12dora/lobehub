import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useAiInfraStore, useScopedAiInfraStore } from '@/store/aiInfra';

/**
 * m4: Without AdminProviderSettingsStoreProvider, scoped hook reads the same
 * singleton as useAiInfraStore (zero user-behavior change).
 */
describe('ModelSelect scoped store smoke', () => {
  it('useScopedAiInfraStore matches useAiInfraStore singleton without a Provider', () => {
    const { result: scoped } = renderHook(() =>
      useScopedAiInfraStore((s) => s.enabledChatModelList),
    );
    const { result: global } = renderHook(() => useAiInfraStore((s) => s.enabledChatModelList));

    expect(scoped.current).toBe(global.current);
  });
});
