import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ProviderSettingsContext,
  type ProviderSettingsContextValue,
} from './ProviderSettingsContext';
import { useManagedAiModels } from './useManagedAiModels';

const mocks = vi.hoisted(() => ({ managed: false }));

vi.mock('@/features/ManagedResources', () => ({
  useManagedResource: () => ({ managed: mocks.managed }),
}));

const withContext = (value: ProviderSettingsContextValue) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <ProviderSettingsContext value={value}>{children}</ProviderSettingsContext>;
  };

describe('useManagedAiModels', () => {
  beforeEach(() => {
    mocks.managed = false;
  });

  it('is unmanaged on a member surface while the policy is off', () => {
    const { result } = renderHook(() => useManagedAiModels(), { wrapper: withContext({}) });

    expect(result.current).toBe(false);
  });

  it('is managed on a member surface once the policy is published', () => {
    mocks.managed = true;

    const { result } = renderHook(() => useManagedAiModels(), { wrapper: withContext({}) });

    expect(result.current).toBe(true);
  });

  // The regression: `managedResources.aiModels` is global, and the admin catalog renders these
  // same components, so publishing 平台托管 used to hide the catalog's own editing controls
  // from the administrator who published it.
  it('exempts the admin platform catalog while the policy is published', () => {
    mocks.managed = true;

    const { result } = renderHook(() => useManagedAiModels(), {
      wrapper: withContext({ adminPlatformCatalog: true }),
    });

    expect(result.current).toBe(false);
  });

  it('is unmanaged on the admin platform catalog while the policy is off', () => {
    const { result } = renderHook(() => useManagedAiModels(), {
      wrapper: withContext({ adminPlatformCatalog: true }),
    });

    expect(result.current).toBe(false);
  });

  it('defaults to the member reading when no provider is mounted', () => {
    mocks.managed = true;

    const { result } = renderHook(() => useManagedAiModels());

    expect(result.current).toBe(true);
  });
});
