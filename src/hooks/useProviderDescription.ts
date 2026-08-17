import type { TFunction } from 'i18next';
import { DEFAULT_MODEL_PROVIDER_LIST } from 'model-bank/modelProviders';
import { useTranslation } from 'react-i18next';

import { aiProviderSelectors, useScopedAiInfraStore } from '@/store/aiInfra';

/**
 * One-line pitch of a provider, localized — "what is this group of models, and how does it
 * differ from the one above it".
 *
 * Pickers group models by provider, and the groups are told apart by nothing but a brand name
 * (xAI / SuperGrok / Grok / ChatGPT / ChatGPT Web). The description is the copy that answers
 * that, and it already exists: every builtin card ships one, and
 * `packages/locales/src/default/providers.ts` emits a `<id>.description` key for each of them,
 * so a translation lands automatically once the card does.
 *
 * A CUSTOM provider's description is user-authored and lives only in the database, so it is
 * never run through i18n — same split as the provider grid card.
 *
 * Non-hook variant, for code that already holds a `t` bound to the `providers` namespace.
 *
 * @param storedDescription - description from the store/database, used for providers the
 *   model-bank does not know (custom ones).
 * @returns the description, or `undefined` when there is nothing worth rendering — callers
 *   render no affordance at all in that case rather than an empty tooltip.
 */
/**
 * Card descriptions of the builtins, resolved once at module load. Membership is the point:
 * it is what lets a builtin id skip the store selector below, so a picker with dozens of
 * groups does not run a linear `find` over `aiProviderList` on every store update.
 */
const BUILTIN_PROVIDER_DESCRIPTIONS = new Map(
  DEFAULT_MODEL_PROVIDER_LIST.map((card) => [card.id, card.description] as const),
);

export const getProviderDescription = (
  provider: string | undefined,
  t: TFunction<'providers'>,
  storedDescription?: string | null,
): string | undefined => {
  if (!provider) return undefined;

  const builtinDescription = BUILTIN_PROVIDER_DESCRIPTIONS.get(provider);

  // Never hand i18next an empty key/defaultValue pair: it would hand back the raw key.
  if (!builtinDescription) return storedDescription?.trim() || undefined;

  return t(`${provider}.description`, { defaultValue: builtinDescription }).trim() || undefined;
};

export const useProviderDescription = (provider?: string): string | undefined => {
  const { t } = useTranslation('providers');
  /**
   * Scoped, so the admin console's injected store answers for platform providers instead of
   * the viewer's own. Builtin ids never reach the store lookup, so an unloaded list only ever
   * costs custom providers their description — never a wrong one.
   */
  const storedDescription = useScopedAiInfraStore(
    aiProviderSelectors.providerDescriptionById(
      // Not merely unused for a builtin — passing the id would make every group header
      // subscribe to a list scan whose answer is thrown away.
      provider && !BUILTIN_PROVIDER_DESCRIPTIONS.has(provider) ? provider : undefined,
    ),
  );

  return getProviderDescription(provider, t, storedDescription);
};
