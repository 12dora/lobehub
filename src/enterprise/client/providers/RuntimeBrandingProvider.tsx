'use client';

import { createContext, type ReactNode, use, useEffect, useMemo } from 'react';

import { setPlatformDefaultPrimaryColor } from '@/layout/GlobalProvider/platformThemeDefaults';
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
  const primaryColor = branding.themeDefaults?.primaryColor ?? null;

  // The theme lives above this provider, so the platform default colour is pushed to it.
  useEffect(() => {
    setPlatformDefaultPrimaryColor(primaryColor);
  }, [primaryColor]);

  return <RuntimeBrandingContext value={branding}>{children}</RuntimeBrandingContext>;
};

export const useRuntimeBranding = (): RuntimeBranding => use(RuntimeBrandingContext);

/** Preferred concise consumer hook; the long name remains for compatibility. */
export const useBranding = useRuntimeBranding;
