import { BRANDING_NAME } from '@lobechat/business-const';
import { CURRENT_VERSION } from '@lobechat/const';
import { isRecord } from '@lobechat/utils/object';
import type { ChatModelCard } from 'model-bank';
import { ModelProvider } from 'model-bank';
import OpenAI from 'openai';

import { createOpenAICompatibleRuntime } from '../../core/openaiCompatibleFactory';
import type { EffortControlKey } from '../../utils/effortControlRegistry';
import { EFFORT_CONTROL_REGISTRY, isEffortControlKey } from '../../utils/effortControlRegistry';
import type { ProcessableModelCard } from '../../utils/modelParse';
import { MODEL_LIST_CONFIGS, processModelList } from '../../utils/modelParse';
import { params as openAIParams } from '../openai';

const CHATGPT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const CHATGPT_RESPONSES_LITE_HEADER = 'x-openai-internal-codex-responses-lite';
const CHATGPT_RESPONSES_LITE_MODEL_IDS = new Set(['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra']);
const USER_AGENT = `${BRANDING_NAME}/${CURRENT_VERSION}`;

interface ChatGPTClientOptions {
  chatgptAccountId?: string;
}

interface ChatGPTAdditionalToolsInput {
  role: 'developer';
  tools: OpenAI.Responses.Tool[];
  type: 'additional_tools';
}

const isResponsesLiteModel = (model: string | undefined) =>
  !!model && CHATGPT_RESPONSES_LITE_MODEL_IDS.has(model);

/**
 * Codex `/models` is gated by `client_version`: older values (e.g. `0.50.0`) return
 * `{ models: [] }`. Bump this when Codex CLI ships newer models gated by
 * `minimal_client_version`.
 */
export const CODEX_CLIENT_VERSION = '0.146.0';

/** Codex `/models` is undocumented — only "this route is not there" is a catalog fallback. */
const CODEX_MODELS_MISSING_STATUSES = new Set([404, 405, 501]);

/**
 * Catalog sync reads this after `processModelList` has already turned every
 * capability into a boolean. Empty object = live payload sent none of them.
 */
export const UPSTREAM_REPORTED_ABILITIES = 'upstreamReportedAbilities';

const UPSTREAM_ABILITY_KEYS = [
  'files',
  'functionCall',
  'imageOutput',
  'reasoning',
  'search',
  'video',
  'vision',
] as const;

const AUTH_ERROR_TYPE = /authentication|authorization|permission/i;
const AUTH_ERROR_CODE =
  /invalid[_-]?(?:token|api[_-]?key)|unauthorized|forbidden|token[_-]?expired|access[_-]?denied/i;

const collectErrorSignals = (value: unknown, into: string[]): void => {
  if (!isRecord(value)) return;
  if (typeof value.code === 'string') into.push(value.code);
  if (typeof value.type === 'string') into.push(value.type);
  if ('error' in value) collectErrorSignals(value.error, into);
  if ('body' in value) collectErrorSignals(value.body, into);
};

/** A 404/405/501 is "route missing" only when the payload does not say otherwise. */
const isCodexModelsEndpointMissing = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false;
  const status =
    (error as { status?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode;
  if (typeof status !== 'number' || !CODEX_MODELS_MISSING_STATUSES.has(status)) return false;
  const signals: string[] = [];
  collectErrorSignals(error, signals);
  return !signals.some((signal) => AUTH_ERROR_TYPE.test(signal) || AUTH_ERROR_CODE.test(signal));
};

const asFiniteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const asNonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/**
 * ChatGPT / Codex tags that `applyModelExtendParams` serializes as
 * `reasoning_effort`. Searching the full registry would exact-match
 * `opus47Effort` (Anthropic `effort`) for low/medium/high/xhigh/max.
 */
export const CHATGPT_REASONING_EFFORT_CANDIDATES = [
  'gpt5ReasoningEffort',
  'gpt5_1ReasoningEffort',
  'gpt5_2ReasoningEffort',
  'gpt5_2ProReasoningEffort',
  'gpt5_6ReasoningEffort',
  'codexMaxReasoningEffort',
  'reasoningEffort',
] as const satisfies readonly EffortControlKey[];

/**
 * Map a live `supported_reasoning_levels` set onto the best candidate
 * effort-control tag. Exact set match wins (candidate order breaks ties).
 * Otherwise pick the smallest candidate level-set that is a superset of the
 * live set. No match → leave the card untouched.
 */
export const matchEffortControlForLevels = (
  levels: readonly string[],
  candidates: readonly EffortControlKey[] = CHATGPT_REASONING_EFFORT_CANDIDATES,
): EffortControlKey | undefined => {
  const live = new Set(levels.filter((level) => level.length > 0));
  if (live.size === 0) return undefined;

  for (const key of candidates) {
    const registryLevels = EFFORT_CONTROL_REGISTRY[key].levels;
    if (registryLevels.length === live.size && registryLevels.every((level) => live.has(level))) {
      return key;
    }
  }

  let bestKey: EffortControlKey | undefined;
  let bestSize = Number.POSITIVE_INFINITY;
  for (const key of candidates) {
    const registryLevels = EFFORT_CONTROL_REGISTRY[key].levels;
    if (registryLevels.length >= bestSize) continue;
    if (![...live].every((level) => (registryLevels as readonly string[]).includes(level))) {
      continue;
    }
    bestKey = key;
    bestSize = registryLevels.length;
  }
  return bestKey;
};

/** Observed Codex wire items are strings or `{ effort }`. */
const extractSupportedReasoningLevels = (raw: unknown): string[] | undefined => {
  if (!Array.isArray(raw)) return undefined;

  return raw.flatMap((item) => {
    if (typeof item === 'string' && item.length > 0) return [item];
    if (isRecord(item)) {
      const effort = asNonEmptyString(item.effort);
      return effort ? [effort] : [];
    }
    return [];
  });
};

/**
 * Generalized `applyLiveGrokReasoningEffort`: drop every effort-control tag
 * (same family) and append the live-derived one. Non-effort tags stay.
 * No-op when live discovery found nothing.
 */
const applyLiveEffortExtendParam = (
  card: ChatModelCard,
  liveTag: EffortControlKey | undefined,
): ChatModelCard => {
  if (!liveTag) return card;

  const extendParams = [
    ...(card.settings?.extendParams ?? []).filter((param) => !isEffortControlKey(param)),
    liveTag,
  ];

  return {
    ...card,
    settings: {
      ...card.settings,
      extendParams,
    },
  };
};

/**
 * Live Codex payload is `{ models: [...] }` with `slug` / `display_name` /
 * `context_window` — not the OpenAI `{ data: [{ id }] }` shape.
 */
const mapCodexCatalog = (
  rawModels: unknown[],
): { cards: ProcessableModelCard[]; liveEffortById: Map<string, EffortControlKey> } => {
  const mapped: Array<ProcessableModelCard & { priority: number }> = [];
  const liveEffortById = new Map<string, EffortControlKey>();

  for (const raw of rawModels) {
    if (!isRecord(raw) || raw.visibility === 'hide') continue;
    const id = asNonEmptyString(raw.slug);
    if (!id) continue;

    const inputModalities = Array.isArray(raw.input_modalities) ? raw.input_modalities : undefined;
    const reasoningLevels = Array.isArray(raw.supported_reasoning_levels)
      ? raw.supported_reasoning_levels
      : undefined;
    const extractedLevels = extractSupportedReasoningLevels(raw.supported_reasoning_levels);
    const liveEffort = extractedLevels
      ? matchEffortControlForLevels(extractedLevels, CHATGPT_REASONING_EFFORT_CANDIDATES)
      : undefined;
    const displayName = asNonEmptyString(raw.display_name);
    const description = asNonEmptyString(raw.description);
    const contextWindowTokens = asFiniteNumber(raw.context_window);

    if (liveEffort) liveEffortById.set(id, liveEffort);

    mapped.push({
      id,
      functionCall: true,
      priority: asFiniteNumber(raw.priority) ?? Number.POSITIVE_INFINITY,
      ...(displayName ? { displayName } : {}),
      ...(description ? { description } : {}),
      ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
      ...(inputModalities ? { vision: inputModalities.includes('image') } : {}),
      ...(reasoningLevels ? { reasoning: reasoningLevels.length > 0 } : {}),
      ...(liveEffort ? { settings: { extendParams: [liveEffort] } } : {}),
    });
  }

  mapped.sort((left, right) => left.priority - right.priority);
  return {
    cards: mapped.map(({ priority: _priority, ...card }) => card),
    liveEffortById,
  };
};

const attachUpstreamAbilityProvenance = (
  cards: ChatModelCard[],
  rawModels: unknown[],
): ChatModelCard[] => {
  const reportedById = new Map<string, Record<string, boolean>>();
  for (const raw of rawModels) {
    if (!isRecord(raw) || typeof raw.id !== 'string') continue;
    const reported: Record<string, boolean> = {};
    for (const key of UPSTREAM_ABILITY_KEYS) {
      const value = raw[key];
      if (typeof value === 'boolean') reported[key] = value;
    }
    reportedById.set(raw.id, reported);
  }
  return cards.map((card) => {
    const reported = reportedById.get(card.id);
    if (!reported) return card;
    return { ...card, [UPSTREAM_REPORTED_ABILITIES]: reported };
  });
};

export const LobeChatGPTAI = createOpenAICompatibleRuntime<ChatGPTClientOptions>({
  baseURL: CHATGPT_CODEX_BASE_URL,
  chatCompletion: {
    useResponse: true,
  },
  customClient: {
    createClient: ({ chatgptAccountId, ...options }) =>
      new OpenAI({
        ...options,
        defaultHeaders: {
          ...options.defaultHeaders,
          ...(chatgptAccountId && { 'ChatGPT-Account-Id': chatgptAccountId }),
          'User-Agent': USER_AGENT,
          'originator': 'lobehub',
          'session-id': crypto.randomUUID(),
          'version': CURRENT_VERSION,
        },
      }),
  },
  debug: {
    chatCompletion: () => process.env.DEBUG_CHATGPT_CHAT_COMPLETION === '1',
    responses: () => process.env.DEBUG_CHATGPT_RESPONSES === '1',
  },
  // Codex `/models` requires `client_version` and returns `{ models: [...] }`.
  // 404/405/501 (route missing) fall back to model-bank. Auth, rate-limit, and
  // transport failures must surface — those are the errors an operator can act on.
  models: async ({ client }) => {
    try {
      const payload: unknown = await client.get('/models', {
        query: { client_version: CODEX_CLIENT_VERSION },
      });
      if (!isRecord(payload)) {
        throw new TypeError('ChatGPT Codex models payload was not a list');
      }

      // Live Codex shape. An empty `models` array is a real answer (old client
      // versions are gated to none) — do not fall back to model-bank.
      if (Array.isArray(payload.models)) {
        const { cards: modelList, liveEffortById } = mapCodexCatalog(payload.models);
        const processed = await processModelList(modelList, MODEL_LIST_CONFIGS.openai, 'chatgpt');
        return attachUpstreamAbilityProvenance(
          processed.map((card) => applyLiveEffortExtendParam(card, liveEffortById.get(card.id))),
          modelList,
        );
      }

      // Defensive: if the endpoint ever returns the public OpenAI list shape.
      if (Array.isArray(payload.data)) {
        const modelList = payload.data.filter(
          (item): item is ProcessableModelCard => isRecord(item) && typeof item.id === 'string',
        );
        return attachUpstreamAbilityProvenance(
          await processModelList(modelList, MODEL_LIST_CONFIGS.openai, 'chatgpt'),
          modelList,
        );
      }

      throw new TypeError('ChatGPT Codex models payload was not a list');
    } catch (error) {
      if (!(error instanceof TypeError) && !isCodexModelsEndpointMissing(error)) {
        throw error;
      }

      const { chatgpt } = await import('model-bank');

      return processModelList(chatgpt, MODEL_LIST_CONFIGS.openai, 'chatgpt');
    }
  },
  provider: ModelProvider.ChatGPT,
  responses: {
    handlePayload: (payload) => {
      const handledPayload = openAIParams.responses?.handlePayload?.(payload) || payload;
      const { service_tier: _serviceTier, ...rest } = handledPayload;

      // The ChatGPT Codex backend manages output limits from the subscription
      // model catalog and rejects the public API's max_output_tokens field.
      return {
        ...rest,
        include: ['reasoning.encrypted_content'],
        max_tokens: undefined,
      };
    },
    prepareRequest: (payload) => {
      const { safety_identifier: _safetyIdentifier, ...subscriptionPayload } = payload;

      if (!isResponsesLiteModel(payload.model)) {
        return { payload: subscriptionPayload };
      }

      // Codex GPT-5.6 models use Responses Lite: tools move into the input
      // sequence, reasoning spans all turns, and the protocol header is required.
      const {
        input,
        instructions,
        parallel_tool_calls: _parallelToolCalls,
        reasoning,
        tool_choice: toolChoice,
        tools,
        ...rest
      } = subscriptionPayload;
      const additionalTools: ChatGPTAdditionalToolsInput = {
        role: 'developer',
        tools: tools || [],
        type: 'additional_tools',
      };
      const developerInstructions =
        instructions && typeof instructions === 'string'
          ? [
              {
                content: [{ text: instructions, type: 'input_text' as const }],
                role: 'developer' as const,
                type: 'message' as const,
              },
            ]
          : [];

      return {
        headers: { [CHATGPT_RESPONSES_LITE_HEADER]: 'true' },
        payload: {
          ...rest,
          input: [
            additionalTools as OpenAI.Responses.ResponseInputItem,
            ...developerInstructions,
            ...(Array.isArray(input) ? input : []),
          ],
          parallel_tool_calls: false,
          reasoning: { ...reasoning, context: 'all_turns' },
          tool_choice: toolChoice || 'auto',
        },
      };
    },
  },
});
