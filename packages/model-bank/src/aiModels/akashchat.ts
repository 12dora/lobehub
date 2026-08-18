import type { AIChatModelCard } from '../types/aiModel';

// Catalog + USD / 1M-token rates from https://akashml.com/docs/platform/models.md
const akashChatModels: AIChatModelCard[] = [
  {
    contextWindowTokens: 131_072,
    displayName: 'DeepSeek V4 Flash',
    enabled: true,
    family: 'deepseek',
    generation: 'deepseek-v4',
    id: 'deepseek-ai/DeepSeek-V4-Flash-0731',
    pricing: {
      units: [
        { name: 'textInput', rate: 0.14, strategy: 'fixed', unit: 'millionTokens' },
        { name: 'textOutput', rate: 0.28, strategy: 'fixed', unit: 'millionTokens' },
        { name: 'textInput_cacheRead', rate: 0.02, strategy: 'fixed', unit: 'millionTokens' },
      ],
    },
    type: 'chat',
  },
  {
    contextWindowTokens: 131_072,
    displayName: 'Llama 3.3 70B Instruct',
    enabled: true,
    family: 'llama',
    generation: 'llama-3.3',
    id: 'meta-llama/Llama-3.3-70B-Instruct',
    pricing: {
      units: [
        { name: 'textInput', rate: 0.13, strategy: 'fixed', unit: 'millionTokens' },
        { name: 'textOutput', rate: 0.4, strategy: 'fixed', unit: 'millionTokens' },
      ],
    },
    type: 'chat',
  },
  {
    abilities: {
      reasoning: true,
    },
    contextWindowTokens: 131_072,
    displayName: 'GPT-OSS 120B',
    enabled: true,
    family: 'gpt-oss',
    generation: 'gpt-oss',
    id: 'openai/gpt-oss-120b',
    pricing: {
      units: [
        { name: 'textInput', rate: 0.037, strategy: 'fixed', unit: 'millionTokens' },
        { name: 'textOutput', rate: 0.49, strategy: 'fixed', unit: 'millionTokens' },
      ],
    },
    settings: {
      extendParams: ['reasoningEffort'],
    },
    type: 'chat',
  },
  {
    abilities: {
      reasoning: true,
    },
    contextWindowTokens: 131_072,
    displayName: 'GPT-OSS 20B',
    family: 'gpt-oss',
    generation: 'gpt-oss',
    id: 'openai/gpt-oss-20b',
    pricing: {
      units: [
        { name: 'textInput', rate: 0.03, strategy: 'fixed', unit: 'millionTokens' },
        { name: 'textOutput', rate: 0.13, strategy: 'fixed', unit: 'millionTokens' },
      ],
    },
    settings: {
      extendParams: ['reasoningEffort'],
    },
    type: 'chat',
  },
  {
    contextWindowTokens: 262_144,
    displayName: 'Qwen3.5 35B A3B',
    family: 'qwen',
    generation: 'qwen3.5',
    id: 'Qwen/Qwen3.5-35B-A3B',
    pricing: {
      units: [
        { name: 'textInput', rate: 0.14, strategy: 'fixed', unit: 'millionTokens' },
        { name: 'textOutput', rate: 1, strategy: 'fixed', unit: 'millionTokens' },
        { name: 'textInput_cacheRead', rate: 0.05, strategy: 'fixed', unit: 'millionTokens' },
      ],
    },
    type: 'chat',
  },
  {
    contextWindowTokens: 262_144,
    displayName: 'Qwen3.6 35B A3B',
    family: 'qwen',
    generation: 'qwen3.6',
    id: 'Qwen/Qwen3.6-35B-A3B',
    pricing: {
      units: [
        { name: 'textInput', rate: 0.14, strategy: 'fixed', unit: 'millionTokens' },
        { name: 'textOutput', rate: 1, strategy: 'fixed', unit: 'millionTokens' },
        { name: 'textInput_cacheRead', rate: 0.05, strategy: 'fixed', unit: 'millionTokens' },
      ],
    },
    type: 'chat',
  },
  {
    contextWindowTokens: 97_000,
    displayName: 'GLM-5.2',
    enabled: true,
    family: 'glm',
    generation: 'glm-5.2',
    id: 'zai-org/GLM-5.2',
    pricing: {
      units: [
        {
          name: 'textInput',
          originalRate: 1.4,
          rate: 0.77,
          strategy: 'fixed',
          unit: 'millionTokens',
        },
        {
          name: 'textInput_cacheRead',
          originalRate: 0.26,
          rate: 0.143,
          strategy: 'fixed',
          unit: 'millionTokens',
        },
        {
          name: 'textOutput',
          originalRate: 4.4,
          rate: 2.42,
          strategy: 'fixed',
          unit: 'millionTokens',
        },
      ],
    },
    type: 'chat',
  },
];
export const allModels = [...akashChatModels];

export default allModels;
