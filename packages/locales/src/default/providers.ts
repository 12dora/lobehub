import { DEFAULT_MODEL_PROVIDER_LIST } from 'model-bank/modelProviders';
import LobeHubProvider from 'model-bank/modelProviders/lobehub';

const locales: Record<`${string}.description` | `${string}.name`, string> = {};

const providers = [LobeHubProvider, ...DEFAULT_MODEL_PROVIDER_LIST];

providers.forEach((provider) => {
  if (!provider.description) return;
  locales[`${provider.id}.description`] = provider.description;
});

/**
 * Provider names are brand names, so they are NOT emitted for every card: a translated
 * "Anthropic" or "DeepSeek" would be wrong. Only the ids listed here opt in, and every other
 * provider keeps its card name through the `defaultValue` in `useProviderName`.
 *
 * `ChatGPT Web` qualifies because "Web" is a plain descriptor of which ChatGPT surface this
 * provider talks to, not part of the brand — zh-CN reads it as 「ChatGPT 网页版」.
 */
locales['chatgptweb.name'] = 'ChatGPT Web';

export default locales;
