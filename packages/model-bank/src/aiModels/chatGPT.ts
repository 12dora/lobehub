import { gptImage2Schema } from '../const/imageParameters';
import type { ModelParamsSchema } from '../standard-parameters';
import type { AIChatModelCard, AIImageModelCard } from '../types/aiModel';
import { openaiChatModels } from './openai';

const CHATGPT_MODEL_IDS = new Set(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5']);

/**
 * Codex `/images` accepts up to 5 reference images and the gpt-image-2 knobs
 * (size / quality / background). Platform `gptImage2Schema` only allows 1 ref
 * and has no quality/background — adapt it rather than reuse as-is.
 */
const chatGPTImage2Schema: ModelParamsSchema = {
  ...gptImage2Schema,
  background: {
    default: 'auto',
    enum: ['opaque', 'transparent', 'auto'],
  },
  imageUrls: { default: [], maxCount: 5, maxFileSize: 5 * 1024 * 1024 },
  quality: {
    default: 'auto',
    enum: ['low', 'medium', 'high', 'auto'],
  },
};

/**
 * Models available through ChatGPT subscription authentication use the Codex
 * backend rather than the usage-billed OpenAI Platform API. Reuse the OpenAI
 * model metadata, but omit per-token pricing and cap the context window to the
 * current Codex catalog limit.
 */
const chatGPTChatModels: AIChatModelCard[] = openaiChatModels
  .filter(({ id }) => CHATGPT_MODEL_IDS.has(id))
  .map(({ pricing: _pricing, ...model }) => ({
    ...model,
    abilities: {
      ...model.abilities,
      files: true,
    },
    contextWindowTokens: 272_000,
    settings: {
      ...model.settings,
      extendParams: [...(model.settings?.extendParams || []), 'preserveThinking'],
    },
  }));

/**
 * Image generation goes through Codex JSON `/images/generations` and
 * `/images/edits` — not the OpenAI Platform Images API. Omit usage-billed
 * pricing the same way chat cards do.
 */
const chatGPTImageModels: AIImageModelCard[] = [
  {
    description:
      "OpenAI's next-generation multimodal image model with native reasoning, up to 4K resolution, near-perfect text rendering, and high-fidelity multilingual support.",
    displayName: 'GPT Image 2',
    enabled: true,
    id: 'gpt-image-2',
    parameters: chatGPTImage2Schema,
    releasedAt: '2026-04-21',
    type: 'image',
  },
];

export default [...chatGPTChatModels, ...chatGPTImageModels];
