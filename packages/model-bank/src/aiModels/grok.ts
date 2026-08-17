import type { AIChatModelCard } from '../types/aiModel';

// Grok models available through the Grok Build / SuperGrok subscription via
// the Grok Build CLI proxy (`cli-chat-proxy.grok.com`). Same model ids as
// the `xai` / `supergrok` catalogs, but without pricing: usage is covered by
// the flat-rate subscription, so per-token cost would mislead.
// ref: https://docs.x.ai/docs/models
const grokChatModels: AIChatModelCard[] = [
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

export default grokChatModels;
