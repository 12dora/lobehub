import type { ChatModelCard } from '@lobechat/types';
import type OpenAI from 'openai';

import { MODEL_LIST_CONFIGS, processModelList } from '../../utils/modelParse';

interface DeepSeekModelCard {
  id: string;
}

/**
 * DeepSeek's Anthropic-compatible surface (`…/anthropic`) serves `/v1/messages` only — it has
 * no model-listing route. Chat may legitimately be routed there (that router is the fallback
 * whenever no baseURL is configured), and the Anthropic SDK client it carries DOES expose
 * `models.list()` — it just 404s against DeepSeek. Discovery therefore asks the
 * OpenAI-compatible surface directly instead of the client it was handed, or "sync upstream
 * models" fails on a provider whose chat works.
 */
const ANTHROPIC_BASE_URL_PATTERN = /\/anthropic\/?$/;

/** `https://host/anthropic` → `https://host/v1`; a custom gateway keeps its own prefix. */
const toOpenAICompatibleBaseURL = (baseURL: string): string =>
  `${baseURL.replace(ANTHROPIC_BASE_URL_PATTERN, '')}/v1`;

const listOpenAICompatibleModels = async (client: {
  apiKey?: string;
  baseURL: string;
  fetch?: typeof fetch;
}): Promise<DeepSeekModelCard[]> => {
  // Keep the client's own fetch: it carries the egress / SSRF adapter the runtime bound.
  const injectedFetch = client.fetch ?? globalThis.fetch.bind(globalThis);

  const response = await injectedFetch(`${toOpenAICompatibleBaseURL(client.baseURL)}/models`, {
    headers: {
      Accept: 'application/json',
      ...(client.apiKey ? { Authorization: `Bearer ${client.apiKey}` } : {}),
    },
    method: 'GET',
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch DeepSeek models: ${response.status} ${response.statusText}`);
  }

  const json = (await response.json()) as { data?: DeepSeekModelCard[] };

  return json.data ?? [];
};

export const fetchDeepSeekModels = async ({
  client,
}: {
  client: OpenAI | unknown;
}): Promise<ChatModelCard[]> => {
  const modelClient = client as {
    apiKey?: string;
    baseURL?: string;
    fetch?: typeof fetch;
    models?: { list?: () => Promise<{ data?: DeepSeekModelCard[] }> };
  };

  if (
    typeof modelClient.baseURL === 'string' &&
    ANTHROPIC_BASE_URL_PATTERN.test(modelClient.baseURL)
  ) {
    const modelList = await listOpenAICompatibleModels({
      apiKey: modelClient.apiKey,
      baseURL: modelClient.baseURL,
      fetch: modelClient.fetch,
    });

    return processModelList(modelList, MODEL_LIST_CONFIGS.deepseek, 'deepseek');
  }

  if (modelClient.models?.list) {
    const modelsPage = await modelClient.models.list();
    const modelList = modelsPage.data || [];

    return processModelList(modelList, MODEL_LIST_CONFIGS.deepseek, 'deepseek');
  }

  const { deepseek } = await import('model-bank');

  return processModelList(deepseek, MODEL_LIST_CONFIGS.deepseek, 'deepseek');
};
