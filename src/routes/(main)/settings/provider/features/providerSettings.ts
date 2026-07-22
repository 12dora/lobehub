import { type AiProviderSDKType, type AiProviderSettings } from '@/types/aiProvider';

/**
 * Synthetic "请求格式" (request format) option: the OpenAI SDK driven through the
 * Responses API spec. It is not a real {@link AiProviderSDKType}; it maps to
 * `sdkType: 'openai'` plus `config.enableResponseApi: true` — the same mechanism as the
 * built-in OpenAI provider's "使用 Responses API 规范" toggle.
 */
export const OPENAI_RESPONSES_SDK_OPTION = 'openai-responses';

export type RequestFormatOptionValue = AiProviderSDKType | typeof OPENAI_RESPONSES_SDK_OPTION;

/**
 * Resolve a request-format dropdown selection into the real `settings.sdkType` and,
 * for the two OpenAI variants, the `config.enableResponseApi` flag that switches between
 * Chat Completions and the Responses API. Returns `enableResponseApi: undefined` for every
 * other SDK so an existing manual toggle (e.g. on a `router`/New API provider) is preserved.
 */
export const resolveRequestFormat = (
  selected?: RequestFormatOptionValue,
): { enableResponseApi?: boolean; sdkType?: AiProviderSDKType } => {
  if (selected === OPENAI_RESPONSES_SDK_OPTION)
    return { enableResponseApi: true, sdkType: 'openai' };
  if (selected === 'openai') return { enableResponseApi: false, sdkType: 'openai' };
  return { sdkType: selected };
};

/** Reverse map for seeding the request-format dropdown when editing an existing provider. */
export const toRequestFormatOption = (
  sdkType?: AiProviderSDKType,
  enableResponseApi?: boolean,
): RequestFormatOptionValue | undefined => {
  if (sdkType === 'openai' && enableResponseApi === true) return OPENAI_RESPONSES_SDK_OPTION;
  return sdkType;
};

const RESPONSE_API_SUPPORTED_SDK_TYPES = new Set<AiProviderSDKType>(['openai', 'router']);

export const isResponsesApiSupportedSdkType = (sdkType?: AiProviderSDKType) => {
  if (!sdkType) return false;

  return RESPONSE_API_SUPPORTED_SDK_TYPES.has(sdkType);
};

interface NormalizeProviderSettingsParams {
  nextSettings?: AiProviderSettings;
  previousSettings?: AiProviderSettings;
}

export const normalizeProviderSettings = ({
  nextSettings,
  previousSettings,
}: NormalizeProviderSettingsParams): AiProviderSettings | undefined => {
  const mergedSettings = {
    ...previousSettings,
    ...nextSettings,
  };

  const sdkType = mergedSettings.sdkType;

  if (isResponsesApiSupportedSdkType(sdkType)) {
    return {
      ...mergedSettings,
      supportResponsesApi: true,
    };
  }

  const { supportResponsesApi: _removedSupportResponsesApi, ...restSettings } = mergedSettings;

  if (Object.keys(restSettings).length === 0) return undefined;

  return restSettings;
};
