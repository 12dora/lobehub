import type { TFunction } from 'i18next';
import { DEFAULT_MODEL_PROVIDER_LIST } from 'model-bank/modelProviders';
import { useTranslation } from 'react-i18next';

import { aiProviderSelectors, useScopedAiInfraStore } from '@/store/aiInfra';

/**
 * Card names of the builtins, resolved once at module load. Membership is the point: it is
 * what lets a builtin id skip the store scan below (its name can only come from the card),
 * so a long picker does not pay a linear search per rendered row.
 */
const BUILTIN_PROVIDER_NAMES = new Map(
  DEFAULT_MODEL_PROVIDER_LIST.map((card) => [card.id, card.name] as const),
);

/**
 * Display name of a provider, localized when the `providers` namespace opts the id in.
 *
 * Provider names are brand names and stay untranslated by default: `packages/locales/src/default/providers.ts`
 * only emits a `<id>.name` key for the handful of providers whose name is descriptive rather
 * than a brand (today: `chatgptweb` → 「ChatGPT 网页版」). Everything else falls through to
 * `fallbackName` → the model-bank card name → the raw id, so this is safe to call for custom
 * providers too.
 *
 * Non-hook variant, for code that already holds a `t` bound to the `providers` namespace.
 *
 * @param fallbackName - name already known to the caller (e.g. a custom provider's own name).
 *   Passing it also skips the model-bank lookup, which matters in long list renderers.
 */
export const getProviderDisplayName = (
  provider: string,
  t: TFunction<'providers'>,
  fallbackName?: string,
): string => {
  const defaultValue =
    fallbackName ||
    DEFAULT_MODEL_PROVIDER_LIST.find((card) => card.id === provider)?.name ||
    provider;

  // Callers rely on an empty result to mean "nothing to name" (see OAuthExpiredError): never
  // hand i18next an empty key/defaultValue pair and risk getting the raw key back.
  if (!defaultValue) return '';

  return t(`${provider}.name`, { defaultValue });
};

export const useProviderName = (provider: string, fallbackName?: string) => {
  const { t } = useTranslation('providers');

  return getProviderDisplayName(provider, t, fallbackName);
};

/**
 * Display name of a provider that also knows CUSTOM (database) providers.
 *
 * `useProviderName` alone cannot: a custom provider is not in the model-bank, so it falls
 * through to the raw id and a picker ends up showing `internal_proxy` where the row's own
 * name says "Internal Gateway". The stored name lives only in the aiInfra store, and it is
 * user-authored — so it is passed through verbatim, never handed to i18next.
 *
 * @returns the name, or `undefined` when the provider has none anywhere (an unknown id, or a
 *   custom row the store has not loaded yet). Callers decide what an unnamed provider means:
 *   most render nothing rather than an id no one recognises.
 */
export const useProviderDisplayName = (provider?: string): string | undefined => {
  const { t } = useTranslation('providers');
  /**
   * Scoped, so the admin console's injected store answers for platform providers instead of
   * the viewer's own. Builtin ids never reach the store lookup, so an unloaded list only ever
   * costs custom providers their name — never a wrong one.
   */
  const storedName = useScopedAiInfraStore(
    aiProviderSelectors.providerNameById(
      provider && !BUILTIN_PROVIDER_NAMES.has(provider) ? provider : undefined,
    ),
  );

  if (!provider) return undefined;

  // A builtin is named by its card, localized only where the namespace opts the id in.
  const builtinName = BUILTIN_PROVIDER_NAMES.get(provider);
  if (builtinName) return t(`${provider}.name`, { defaultValue: builtinName });

  // Everything else is user-authored copy: verbatim, or nothing at all — never the raw id,
  // which is what made `internal_proxy` show up next to a correctly loaded description.
  return storedName?.trim() || undefined;
};
