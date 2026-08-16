import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

/**
 * The provider title to render as TEXT, or `null` to keep the brand wordmark.
 *
 * Provider headers are drawn with `ProviderCombine`, a graphic wordmark whose label is
 * baked in English (see `src/const/brandIcons.tsx`) — which is right for a logo and wrong
 * for the handful of providers whose name is descriptive and really is translated
 * (`chatgptweb` → 「ChatGPT 网页版」, opted in by `packages/locales/src/default/providers.ts`).
 *
 * So the decision is made from the translation itself rather than from an id list: a name
 * only becomes text when the `providers` namespace hands back something DIFFERENT from the
 * card name the wordmark already shows. Every other provider — and every locale where the
 * key is missing or untranslated — falls through to the wordmark unchanged.
 *
 * Non-hook variant, for code that already holds a `t` bound to the `providers` namespace.
 */
export const getLocalizedProviderTitle = (
  provider: string,
  t: TFunction<'providers'>,
  fallbackName?: string,
): string | null => {
  // Never hand i18next an empty defaultValue: it would return the raw key.
  const localized = t(`${provider}.name`, { defaultValue: '' });
  if (!localized) return null;

  return localized === (fallbackName ?? '') ? null : localized;
};

export const useLocalizedProviderTitle = (provider: string, fallbackName?: string) => {
  const { t } = useTranslation('providers');

  return getLocalizedProviderTitle(provider, t, fallbackName);
};
