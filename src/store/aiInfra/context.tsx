'use client';

import { createContext, type ReactNode, use } from 'react';
import { shallow } from 'zustand/shallow';
import { useStoreWithEqualityFn } from 'zustand/traditional';

import { type AiInfraStore, type AiInfraStoreApi, useAiInfraStore as defaultStore } from './store';

/**
 * Carries a store API (singleton by default). Admin pages inject an independent
 * store created via {@link createAiInfraStore} with platform adapter services.
 */
const AiInfraStoreContext = createContext<AiInfraStoreApi>(defaultStore);

export const AiInfraStoreProvider = ({
  children,
  store,
}: {
  children: ReactNode;
  store: AiInfraStoreApi;
}) => <AiInfraStoreContext value={store}>{children}</AiInfraStoreContext>;

/** Raw store API from context (supports getState/setState/subscribe). */
export const useAiInfraStoreApi = (): AiInfraStoreApi => use(AiInfraStoreContext);

/**
 * Context-bound selector hook for provider settings UI.
 * Defaults to the user singleton when no Provider is mounted — zero behavior change.
 */
export function useScopedAiInfraStore<T>(
  selector: (state: AiInfraStore) => T,
  equalityFn: (a: T, b: T) => boolean = shallow,
): T {
  const store = use(AiInfraStoreContext);
  return useStoreWithEqualityFn(store, selector, equalityFn);
}
