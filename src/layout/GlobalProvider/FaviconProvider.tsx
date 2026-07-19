'use client';

import { type ReactNode } from 'react';
import { createContext, memo, use, useCallback, useEffect, useMemo, useState } from 'react';

import { useBranding } from '@/enterprise/client/providers/RuntimeBrandingProvider';
import { type FaviconState, resolveFaviconHref } from '@/utils/favicon';

export type { FaviconState } from '@/utils/favicon';

interface FaviconStateContextValue {
  currentState: FaviconState;
  isDevMode: boolean;
}

interface FaviconSettersContextValue {
  setFavicon: (state: FaviconState) => void;
  setIsDevMode: (isDev: boolean) => void;
}

const FaviconStateContext = createContext<FaviconStateContextValue | null>(null);
const FaviconSettersContext = createContext<FaviconSettersContextValue | null>(null);

export const useFaviconState = () => {
  const context = use(FaviconStateContext);
  if (!context) {
    throw new Error('useFaviconState must be used within FaviconProvider');
  }
  return context;
};

export const useFaviconSetters = () => {
  const context = use(FaviconSettersContext);
  if (!context) {
    throw new Error('useFaviconSetters must be used within FaviconProvider');
  }
  return context;
};

const updateFaviconDOM = (
  state: FaviconState,
  isDev: boolean,
  runtimeFaviconUrl: string | null,
  publishedRevision: string | null,
) => {
  if (typeof document === 'undefined') return;

  const head = document.head;
  const existingLinks = document.querySelectorAll<HTMLLinkElement>(
    'link[rel="icon"], link[rel="shortcut icon"]',
  );

  if (existingLinks.length === 0) {
    // No favicon links found — create them
    const iconLink = document.createElement('link');
    iconLink.rel = 'icon';
    iconLink.href = resolveFaviconHref(state, isDev, runtimeFaviconUrl, publishedRevision);
    head.append(iconLink);

    const shortcutLink = document.createElement('link');
    shortcutLink.rel = 'shortcut icon';
    shortcutLink.href = resolveFaviconHref(
      state,
      isDev,
      runtimeFaviconUrl,
      publishedRevision,
      '32x32',
    );
    head.append(shortcutLink);
    return;
  }

  // Remove existing favicon links and create new ones to bust cache
  existingLinks.forEach((link) => {
    const oldHref = link.href;
    const is32 = oldHref.includes('32x32');
    const rel = link.rel;

    // Remove old link
    link.remove();

    // Create new link with cache-busting query param
    const newLink = document.createElement('link');
    newLink.rel = rel;
    newLink.href = resolveFaviconHref(
      state,
      isDev,
      runtimeFaviconUrl,
      publishedRevision,
      is32 ? '32x32' : undefined,
    );
    head.append(newLink);
  });
};

export const FaviconProvider = memo<{ children: ReactNode }>(({ children }) => {
  const branding = useBranding();
  const [currentState, setCurrentState] = useState<FaviconState>('default');
  const [isDevMode, setIsDevModeState] = useState<boolean>(__DEV__);

  const setFavicon = useCallback((state: FaviconState) => {
    setCurrentState(state);
  }, []);

  const setIsDevMode = useCallback((isDev: boolean) => {
    setIsDevModeState(isDev);
  }, []);

  useEffect(() => {
    updateFaviconDOM(currentState, isDevMode, branding.faviconUrl, branding.publishedRevision);
  }, [branding.faviconUrl, branding.publishedRevision, currentState, isDevMode]);

  const stateValue = useMemo(() => ({ currentState, isDevMode }), [currentState, isDevMode]);

  const settersValue = useMemo(() => ({ setFavicon, setIsDevMode }), [setFavicon, setIsDevMode]);

  return (
    <FaviconStateContext value={stateValue}>
      <FaviconSettersContext value={settersValue}>{children}</FaviconSettersContext>
    </FaviconStateContext>
  );
});

FaviconProvider.displayName = 'FaviconProvider';
