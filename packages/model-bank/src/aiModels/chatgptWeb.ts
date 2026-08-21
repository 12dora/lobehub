import type { AIChatModelCard, AIImageModelCard, AiModelSettings } from '../types/aiModel';

/**
 * Models exposed by the chatgpt.com web backend. They are the same checkpoints a
 * ChatGPT subscriber gets in the web app, so there is no per-token pricing and
 * no function calling — the web backend runs its own built-in tools (web search,
 * image generation, file analysis) instead of accepting caller-supplied tools.
 */
const baseAbilities = {
  files: true,
  functionCall: false,
  imageOutput: true,
  search: true,
  vision: true,
} as const;

const baseSettings: AiModelSettings = {
  searchImpl: 'params',
  searchProvider: 'chatgptweb',
};

/** `*-thinking` SKUs expose standard / extended / max. */
const thinkingSettings: AiModelSettings = {
  ...baseSettings,
  extendParams: ['chatgptWebThinkingEffort'],
};

/** `*-pro` SKUs expose a single-level Standard control; wire always sends standard. */
const proSettings: AiModelSettings = {
  ...baseSettings,
  extendParams: ['chatgptWebProThinkingEffort'],
};

/**
 * The slug list matches what `/backend-api/models` returns for a live ChatGPT
 * account (2026-08). `auto` is NOT advertised there but is accepted as a model
 * and is what the web app sends by default, so it stays first.
 * Watermarked (`*-wm`) and `research` slugs are deliberately absent — they do
 * not serve a normal chat turn.
 */
const chatgptWebChatModels: AIChatModelCard[] = [
  {
    abilities: { ...baseAbilities, reasoning: true },
    contextWindowTokens: 128_000,
    description:
      'Lets ChatGPT pick the best model for each message, switching to a thinking model when the request needs it.',
    displayName: 'Auto (ChatGPT Web)',
    enabled: true,
    family: 'gpt',
    id: 'auto',
    maxOutput: 32_768,
    settings: baseSettings,
    type: 'chat',
  },
  {
    abilities: baseAbilities,
    contextWindowTokens: 128_000,
    description: 'The current ChatGPT default model, balancing answer quality and speed.',
    displayName: 'GPT-5.6 (ChatGPT Web)',
    enabled: true,
    family: 'gpt',
    generation: 'gpt-5.6',
    id: 'gpt-5-6',
    maxOutput: 32_768,
    settings: baseSettings,
    type: 'chat',
  },
  {
    abilities: { ...baseAbilities, reasoning: true },
    contextWindowTokens: 128_000,
    description: 'GPT-5.6 with extended thinking, for harder reasoning and multi-step work.',
    displayName: 'GPT-5.6 Thinking (ChatGPT Web)',
    enabled: true,
    family: 'gpt',
    generation: 'gpt-5.6',
    id: 'gpt-5-6-thinking',
    maxOutput: 32_768,
    settings: thinkingSettings,
    type: 'chat',
  },
  {
    abilities: baseAbilities,
    contextWindowTokens: 128_000,
    description: 'GPT-5.6 tuned for fast answers, without a thinking pass.',
    displayName: 'GPT-5.6 Instant (ChatGPT Web)',
    enabled: true,
    family: 'gpt',
    generation: 'gpt-5.6',
    id: 'gpt-5-6-instant',
    maxOutput: 32_768,
    settings: baseSettings,
    type: 'chat',
  },
  {
    abilities: { ...baseAbilities, reasoning: true },
    contextWindowTokens: 128_000,
    description: 'The research-grade GPT-5.6 tier; slowest, for the hardest problems.',
    displayName: 'GPT-5.6 Pro (ChatGPT Web)',
    enabled: true,
    family: 'gpt',
    generation: 'gpt-5.6',
    id: 'gpt-5-6-pro',
    maxOutput: 32_768,
    settings: proSettings,
    type: 'chat',
  },
  {
    abilities: baseAbilities,
    contextWindowTokens: 128_000,
    description: 'A faster, lighter GPT-5.6 variant used when usage limits are reached.',
    displayName: 'GPT-5.6 mini (ChatGPT Web)',
    enabled: false,
    family: 'gpt',
    generation: 'gpt-5.6',
    id: 'gpt-5-6-mini',
    maxOutput: 32_768,
    settings: baseSettings,
    type: 'chat',
  },
  {
    abilities: baseAbilities,
    contextWindowTokens: 128_000,
    description: 'The previous-generation ChatGPT default model.',
    displayName: 'GPT-5.5 (ChatGPT Web)',
    enabled: false,
    family: 'gpt',
    generation: 'gpt-5.5',
    id: 'gpt-5-5',
    knowledgeCutoff: '2025-12',
    maxOutput: 32_768,
    settings: baseSettings,
    type: 'chat',
  },
  {
    abilities: { ...baseAbilities, reasoning: true },
    contextWindowTokens: 128_000,
    description: 'GPT-5.5 with extended thinking.',
    displayName: 'GPT-5.5 Thinking (ChatGPT Web)',
    enabled: false,
    family: 'gpt',
    generation: 'gpt-5.5',
    id: 'gpt-5-5-thinking',
    knowledgeCutoff: '2025-12',
    maxOutput: 32_768,
    settings: thinkingSettings,
    type: 'chat',
  },
  {
    abilities: baseAbilities,
    contextWindowTokens: 128_000,
    description: 'GPT-5.5 tuned for fast answers, without a thinking pass.',
    displayName: 'GPT-5.5 Instant (ChatGPT Web)',
    enabled: false,
    family: 'gpt',
    generation: 'gpt-5.5',
    id: 'gpt-5-5-instant',
    knowledgeCutoff: '2025-12',
    maxOutput: 32_768,
    settings: baseSettings,
    type: 'chat',
  },
  {
    abilities: { ...baseAbilities, reasoning: true },
    contextWindowTokens: 128_000,
    description: 'The research-grade GPT-5.5 tier.',
    displayName: 'GPT-5.5 Pro (ChatGPT Web)',
    enabled: false,
    family: 'gpt',
    generation: 'gpt-5.5',
    id: 'gpt-5-5-pro',
    knowledgeCutoff: '2025-12',
    maxOutput: 32_768,
    settings: proSettings,
    type: 'chat',
  },
  {
    abilities: baseAbilities,
    contextWindowTokens: 128_000,
    description: 'A faster, lighter GPT-5.5 variant used when usage limits are reached.',
    displayName: 'GPT-5.5 mini (ChatGPT Web)',
    enabled: false,
    family: 'gpt',
    generation: 'gpt-5.5',
    id: 'gpt-5-5-mini',
    knowledgeCutoff: '2025-12',
    maxOutput: 32_768,
    settings: baseSettings,
    type: 'chat',
  },
  {
    abilities: baseAbilities,
    contextWindowTokens: 128_000,
    description: 'A faster, lighter GPT-5.3 variant kept for older conversations.',
    displayName: 'GPT-5.3 mini (ChatGPT Web)',
    enabled: false,
    family: 'gpt',
    generation: 'gpt-5.3',
    id: 'gpt-5-3-mini',
    maxOutput: 32_768,
    settings: baseSettings,
    type: 'chat',
  },
  {
    abilities: { ...baseAbilities, reasoning: true },
    contextWindowTokens: 128_000,
    description: 'The o-series reasoning model, still offered inside ChatGPT.',
    displayName: 'o3 (ChatGPT Web)',
    enabled: false,
    family: 'o-series',
    generation: 'o3',
    id: 'o3',
    knowledgeCutoff: '2024-06',
    maxOutput: 32_768,
    releasedAt: '2025-04-16',
    settings: baseSettings,
    type: 'chat',
  },
];

/**
 * Image generation goes through the same conversation backend, so the only
 * knobs the web app exposes are the prompt and up to four reference images —
 * no size / quality / seed parameters. `parameters` must stay declared so the
 * card never falls back to the OpenAI Platform `gpt-image-2` schema.
 */
const chatgptWebImageModels: AIImageModelCard[] = [
  {
    description:
      'Image generation and editing through ChatGPT, driven by the prompt and optional reference images.',
    displayName: 'GPT Image 2 (ChatGPT Web)',
    enabled: true,
    id: 'gpt-image-2',
    parameters: {
      imageUrls: { default: [], maxCount: 4, maxFileSize: 10 * 1024 * 1024 },
      prompt: { default: '' },
    },
    releasedAt: '2026-04-21',
    type: 'image',
  },
];

export const allModels = [...chatgptWebChatModels, ...chatgptWebImageModels];

export default allModels;
