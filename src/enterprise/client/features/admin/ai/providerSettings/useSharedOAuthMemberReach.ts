'use client';

import { usePlatformAiTakeover } from '@/features/ManagedResources';
import { useScopedAiInfraStore as useAiInfraStore } from '@/store/aiInfra';

/**
 * What the shared account this panel stores actually means to members right now — the three
 * readings the connect copy is allowed to make claims from.
 */
export const useSharedOAuthMemberReach = (providerId: string) => {
  /**
   * Whether the platform AI catalog actually OVERRIDES what members use right now
   * (published `managed + enforced` + the feature flag) — not merely whether their settings
   * UI is blocked. `useManagedResource('aiProviders').managed` is the wrong signal here: it
   * is also true for `ui-only`, where members keep using their own accounts and this shared
   * one reaches nobody. Read from the app-wide capability context: no extra request, and no
   * POLICY_READ requirement on an operator who only administers AI.
   *
   * While it is loading or failed we say nothing: a hint that guesses wrong is worse than
   * no hint.
   */
  const { loading: platformLoading, error: platformError, takeover } = usePlatformAiTakeover();
  const takeoverKnown = !platformLoading && platformError === null;
  const showEnforcementHint = takeoverKnown && !takeover;
  /**
   * Same source as the header EnableSwitch (`aiProviderSelectors.isProviderEnabled`), so the
   * success copy cannot claim a provider is serving members while that switch reads off.
   * Storing a credential never enables anything on the update path — only first connect does.
   */
  const providerEnabled = useAiInfraStore((s) =>
    (s.aiProviderList ?? []).some((item) => item.id === providerId && item.enabled === true),
  );
  /**
   * Follow-up hint source: PERSISTED platform model rows only.
   *
   * `aiProviderModelList` is the merged view — it carries the enabled model-bank defaults even
   * when this provider has zero rows in the platform catalog, so a first ChatGPT/Grok
   * connect would claim "live" while the runtime (which reads published rows) sees a model-less
   * provider and drops it. `enabledAiModels` comes from the admin runtime state, which is built
   * from the persisted draft models of enabled providers, so it cannot lie in that direction.
   */
  const hasPersistedEnabledModel = useAiInfraStore((s) =>
    (s.enabledAiModels ?? []).some((model) => model.providerId === providerId),
  );

  return { hasPersistedEnabledModel, providerEnabled, showEnforcementHint, takeover };
};
