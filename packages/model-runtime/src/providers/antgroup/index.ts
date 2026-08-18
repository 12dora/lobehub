import { ModelProvider } from 'model-bank';

import type { OpenAICompatibleFactoryOptions } from '../../core/openaiCompatibleFactory';
import { createOpenAICompatibleRuntime } from '../../core/openaiCompatibleFactory';

export const params = {
  // Documented host; tbox.cn fronts the same Ling chat gateway but has no /models route.
  baseURL: 'https://api.ant-ling.com/v1',
  chatCompletion: {
    handlePayload: (payload) => {
      const { enabledSearch, reasoning_effort, ...rest } = payload;

      return {
        ...rest,
        ...(reasoning_effort && { reasoning: { effort: reasoning_effort } }),
        ...(enabledSearch && {
          enable_search: true,
          // search_options: { forced_search: true },
        }),
      } as any;
    },
  },
  debug: {
    chatCompletion: () => process.env.DEBUG_ANTGROUP_CHAT_COMPLETION === '1',
  },
  models: async ({ client }) => {
    const list = await client.models.list();
    // The OpenAI SDK does not throw on HTTP 200 with a non-list body, so the
    // factory default would TypeError on `list.data.filter`. Keep the guard
    // even though the documented host has a real /models route.
    if (!Array.isArray(list?.data)) {
      throw new Error('Ant Group models endpoint did not answer with a model list');
    }

    return list.data
      .filter((model) => typeof model?.id === 'string')
      .map((model) => ({ id: model.id }));
  },
  provider: ModelProvider.AntGroup,
} satisfies OpenAICompatibleFactoryOptions;

export const LobeAntGroupAI = createOpenAICompatibleRuntime(params);
