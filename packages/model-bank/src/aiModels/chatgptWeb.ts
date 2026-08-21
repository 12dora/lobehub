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

/**
 * GPT-5.x family cards expose the web-style Instant / Medium / High / Extra high
 * / Pro picker. Distinct from `gpt5_6ReasoningEffort` (OpenAI Platform gpt-5.6-sol).
 */
const familySettings: AiModelSettings = {
  ...baseSettings,
  extendParams: ['chatgptWebReasoningEffort'],
};

/**
 * The advertised list matches what chatgpt.com itself shows: three models
 * (GPT-5.6 Sol, GPT-5.5, o3) plus image generation. Instant / thinking / Pro
 * SKUs are not advertised — the family picker maps a level onto the wire slug
 * and `thinking_effort`. Legacy SKU ids still work at runtime via pass-through.
 * Watermarked (`*-wm`) and `research` slugs are deliberately absent.
 */
const chatgptWebChatModels: AIChatModelCard[] = [
  {
    abilities: { ...baseAbilities, reasoning: true },
    contextWindowTokens: 128_000,
    description:
      "ChatGPT's current default model family. Pick Instant through Pro in the thinking-effort control — Instant is the fast slug, Medium / High / Extra high run the thinking slug, and Pro is the research-grade tier.",
    displayName: 'GPT-5.6 Sol (ChatGPT Web)',
    enabled: true,
    family: 'gpt',
    generation: 'gpt-5.6',
    id: 'gpt-5-6',
    maxOutput: 32_768,
    settings: familySettings,
    type: 'chat',
  },
  {
    abilities: { ...baseAbilities, reasoning: true },
    contextWindowTokens: 128_000,
    description:
      'The previous-generation ChatGPT model family, with the same Instant through Pro thinking-effort picker as GPT-5.6 Sol.',
    displayName: 'GPT-5.5 (ChatGPT Web)',
    enabled: true,
    family: 'gpt',
    generation: 'gpt-5.5',
    id: 'gpt-5-5',
    knowledgeCutoff: '2025-12',
    maxOutput: 32_768,
    settings: familySettings,
    type: 'chat',
  },
  {
    abilities: { ...baseAbilities, reasoning: true },
    contextWindowTokens: 128_000,
    description:
      'The o-series reasoning model, still offered inside ChatGPT. No effort picker — ChatGPT serves o3 at a single medium setting.',
    displayName: 'o3 (ChatGPT Web)',
    enabled: true,
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
