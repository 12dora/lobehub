import type { AIChatModelCard, AIImageModelCard, AIVideoModelCard } from '../types/aiModel';
import { xaiImageModels, xaiVideoModels } from './xai';

// Grok models available through the SuperGrok / X Premium subscription.
// Same model ids as the `xai` provider, but without pricing: usage is
// covered by the flat-rate subscription, so per-token / per-image / per-second
// cost would mislead.
// Only the latest generation is listed by default — older models can still
// be pulled in via the remote model list.
// ref: https://docs.x.ai/docs/models
const superGrokChatModels: AIChatModelCard[] = [
  {
    abilities: {
      functionCall: true,
      reasoning: true,
      search: true,
      structuredOutput: true,
      vision: true,
    },
    contextWindowTokens: 500_000,
    description:
      "xAI's latest frontier model — configurable reasoning effort (low/medium/high/xhigh).",
    displayName: 'Grok 4.6',
    enabled: true,
    family: 'grok',
    generation: 'grok-4.6',
    id: 'grok-4.6',
    releasedAt: '2026-08-01',
    settings: {
      extendParams: ['grok4_20ReasoningEffort'],
      searchImpl: 'params',
    },
    type: 'chat',
  },
  {
    abilities: {
      functionCall: true,
      reasoning: true,
      search: true,
      structuredOutput: true,
      vision: true,
    },
    contextWindowTokens: 500_000,
    description:
      "SpaceXAI's flagship model for coding, agentic tasks, and knowledge work — configurable reasoning (low/medium/high, always on).",
    displayName: 'Grok 4.5',
    enabled: true,
    family: 'grok',
    generation: 'grok-4.5',
    id: 'grok-4.5',
    releasedAt: '2026-07-08',
    settings: {
      extendParams: ['grok4_5ReasoningEffort'],
      searchImpl: 'params',
    },
    type: 'chat',
  },
];

const superGrokImageModels: AIImageModelCard[] = xaiImageModels.map(
  ({ pricing: _pricing, ...model }) => model,
);

const superGrokVideoModels: AIVideoModelCard[] = xaiVideoModels.map(
  ({ pricing: _pricing, ...model }) => model,
);

export const allModels = [...superGrokChatModels, ...superGrokImageModels, ...superGrokVideoModels];

export default allModels;
