'use client';

import i18n from 'i18next';
import { createContext, type ReactNode, use, useEffect, useLayoutEffect, useMemo } from 'react';

import { setPlatformDefaultPrimaryColor } from '@/layout/GlobalProvider/platformThemeDefaults';
import type { PlatformPublicSnapshot } from '@/types/platform/publicSnapshot';

import {
  BUILT_IN_RUNTIME_BRANDING,
  resolveRuntimeBranding,
  type RuntimeBranding,
} from './runtimeBranding';

const RuntimeBrandingContext = createContext<RuntimeBranding>(BUILT_IN_RUNTIME_BRANDING);

let runtimeBrandingSnapshot: RuntimeBranding = BUILT_IN_RUNTIME_BRANDING;

/** Non-hook snapshot for services and download filenames outside React. */
export const getRuntimeBranding = (): RuntimeBranding => runtimeBrandingSnapshot;

const applyRuntimeBrandingGlobals = (branding: RuntimeBranding) => {
  runtimeBrandingSnapshot = branding;
  i18n.options.interpolation = {
    ...i18n.options.interpolation,
    defaultVariables: {
      appName: branding.name,
      platformName: branding.name,
    },
  };
};

const resetRuntimeBrandingGlobals = () => {
  runtimeBrandingSnapshot = BUILT_IN_RUNTIME_BRANDING;
  if (i18n.options.interpolation) {
    delete i18n.options.interpolation.defaultVariables;
  }
};

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

  // Commit-phase only: concurrent/abandoned renders must not publish globals.
  // Call sites pass `appName` explicitly; this is a safety net after layout.
  useLayoutEffect(() => {
    applyRuntimeBrandingGlobals(branding);
    return () => {
      resetRuntimeBrandingGlobals();
    };
  }, [branding]);

  // The theme lives above this provider, so the platform default colour is pushed to it.
  useEffect(() => {
    setPlatformDefaultPrimaryColor(primaryColor);
  }, [primaryColor]);

  return <RuntimeBrandingContext value={branding}>{children}</RuntimeBrandingContext>;
};

export const useRuntimeBranding = (): RuntimeBranding => use(RuntimeBrandingContext);

/** Preferred concise consumer hook; the long name remains for compatibility. */
export const useBranding = useRuntimeBranding;
