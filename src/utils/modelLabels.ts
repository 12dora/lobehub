import { HETEROGENEOUS_TYPE_LABELS } from '@lobechat/heterogeneous-agents';
import { findBuiltinProviderName } from '@lobechat/utils/modelDisplayName';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * App-side labels for raw `model` / `provider` identifiers.
 *
 * `@lobechat/utils/modelDisplayName` only knows model-bank, which is the whole story for models
 * but not for providers: a row produced by a heterogeneous agent stores `codex` / `claude-code`
 * as its provider, and those live in `@lobechat/heterogeneous-agents` (a package the shared utils
 * deliberately do not depend on). This module is the single place that layers the two, so every
 * surface that renders a provider id agrees on what it is called.
 */

export { getModelDisplayName } from '@lobechat/utils/modelDisplayName';

/**
 * The name a human recognizes for one provider id: builtin provider card → heterogeneous agent
 * label → the raw id for anything else (a custom provider, a gateway, a value from a newer build).
 *
 * Untranslated — use `useProviderLabel` inside components so locales that rename a provider win.
 */
export const getProviderLabel = (providerId: string | null | undefined): string => {
  if (!providerId) return '';

  return findBuiltinProviderName(providerId) ?? HETEROGENEOUS_TYPE_LABELS[providerId] ?? providerId;
};

/**
 * `getProviderLabel` with the localized provider name preferred when one exists (e.g. ChatGPT Web
 * reads "ChatGPT 网页版" in zh-CN). Providers without a `<id>.name` key keep their card name.
 */
export const useProviderLabel = () => {
  const { t } = useTranslation('providers');

  return useCallback(
    (providerId: string | null | undefined): string => {
      const fallback = getProviderLabel(providerId);
      if (!providerId) return fallback;

      const key = `${providerId}.name`;
      const translated = t(key as never, { defaultValue: fallback });

      // Guard the "missing key returns the key itself" behaviour: a raw `openai.name` on screen
      // would be worse than the untranslated card name.
      return translated === key ? fallback : translated;
    },
    [t],
  );
};
