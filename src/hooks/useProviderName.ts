import type { TFunction } from 'i18next';
import { DEFAULT_MODEL_PROVIDER_LIST } from 'model-bank/modelProviders';
import { useTranslation } from 'react-i18next';

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
