'use client';

import { createContext, type ReactNode, use, useMemo } from 'react';

import type { PlatformPublicSnapshot } from '@/types/platform/publicSnapshot';

import {
  BUILT_IN_RUNTIME_BRANDING,
  resolveRuntimeBranding,
  type RuntimeBranding,
} from './runtimeBranding';

const RuntimeBrandingContext = createContext<RuntimeBranding>(BUILT_IN_RUNTIME_BRANDING);

export interface RuntimeBrandingProviderProps {
  children: ReactNode;
  publicSnapshot: PlatformPublicSnapshot;
}

export const RuntimeBrandingProvider = ({
  children,
  publicSnapshot,
}: RuntimeBrandingProviderProps) => {
  const branding = useMemo(() => resolveRuntimeBranding(publicSnapshot), [publicSnapshot]);

  return <RuntimeBrandingContext value={branding}>{children}</RuntimeBrandingContext>;
};

export const useRuntimeBranding = (): RuntimeBranding => use(RuntimeBrandingContext);
