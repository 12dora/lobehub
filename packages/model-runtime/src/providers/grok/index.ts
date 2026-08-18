import type { ChatModelCard } from '@lobechat/types';
import type { ExtendParamsType } from 'model-bank';
import { ModelProvider } from 'model-bank';
import OpenAI, { type ClientOptions } from 'openai';

import { deriveConversationSessionId, deriveGrokAgentId, isUuidV4 } from '../../browserProfile';
import { createOpenAICompatibleRuntime } from '../../core/openaiCompatibleFactory';
import type { ChatStreamPayload } from '../../types';
import { AgentRuntimeErrorType } from '../../types/error';
import { MODEL_LIST_CONFIGS, processModelList } from '../../utils/modelParse';
import type { XAIModelCard } from '../xai';
import { handleXAIChatCompletionPayload, handleXAIResponsesPayload } from '../xai';

/**
 * Grok Build CLI version the proxy expects.
 */
export const GROK_CLIENT_VERSION = '1.0.4';
export const GROK_CLIENT_IDENTIFIER = 'grok-shell';
export const GROK_CLIENT_MODE = 'headless';
export const GROK_TOKEN_AUTH = 'xai-grok-cli';
export const GROK_AUTHENTICATE_RESPONSE = 'authenticate-response';
export const GROK_DEFAULT_USER_AGENT_PLATFORM = 'linux; x86_64';

const GROK_CLI_CHAT_PROXY_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
const GROK_DIRECT_CONVERSATION_KEY = 'grok:direct-runtime-default-conversation';
export const GROK_IDENTITY_MISSING_MESSAGE = 'Grok installation identity missing';

/**
 * Thrown instead of sending a request that would carry a made-up device id.
 * Mapped to `ProviderBizError` by the factory's `chatCompletion.handleError`
 * below, so the caller sees a provider-level failure rather than a bare crash.
 */
export class GrokIdentityMissingError extends Error {
  constructor() {
    super(GROK_IDENTITY_MISSING_MESSAGE);
    this.name = 'GrokIdentityMissingError';
  }
}

/**
 * Every `x-stainless-*` header the pinned OpenAI SDK can emit, nulled out in
 * `defaultHeaders` (the SDK drops a header whose value is `null`).
 *
 * NOT a guarantee for the future: this is an explicit denylist of the names the
 * SDK sends today (`node_modules/openai/client.js` + `internal/headers.js`), not
 * a wildcard. A new SDK version can add a new `x-stainless-*` name, and a name
 * set through `options.headers` at the call site would survive anyway, because
 * the SDK merges `options.headers` AFTER `defaultHeaders`. The `/v1/models`
 * test asserts the exact header key set at the fetch boundary — that assertion,
 * not this list, is what catches an SDK upgrade that starts leaking again.
 */
const STAINLESS_HEADERS = [
  'x-stainless-arch',
  'x-stainless-custom-poll-interval',
  'x-stainless-helper-method',
  'x-stainless-lang',
  'x-stainless-os',
  'x-stainless-package-version',
  'x-stainless-poll-helper',
  'x-stainless-retry-count',
  'x-stainless-runtime',
  'x-stainless-runtime-version',
  'x-stainless-timeout',
] as const;

type OpenAIDefaultHeaders = NonNullable<ClientOptions['defaultHeaders']>;

export interface GrokClientOptions {
  /** Stable per-conversation key supplied by the server/runtime seam. */
  conversationKey?: string;
  /**
   * When this conversation was first seen, in epoch ms. It becomes the 48-bit
   * timestamp of the UUIDv7-shaped session id, so it must be a REAL time (the
   * topic's `createdAt`, or the first sighting of the conversation) — never a
   * synthetic constant, which would stamp every session of an installation with
   * one frozen creation time. Defaults to "now", i.e. a session that starts now.
   */
  firstSeenMs?: number;
  /**
   * Installation-wide UUIDv4 persisted by the platform. REQUIRED for every
   * request that carries the CLI header block: it derives `x-grok-agent-id`,
   * the value the proxy reads as "which machine is this". There is deliberately
   * no default — a compiled-in fallback would make every AIHub deployment on
   * earth present the same device.
   */
  installationId?: string;
  /**
   * 1-based turn index inside the conversation. Normally derived from the payload's
   * user-message count (replica-stable); an explicit value is for tests / replay.
   */
  turnIndex?: number;
  /** Platform segment used by the Grok CLI User-Agent. */
  userAgentPlatform?: string;
}

type GrokReasoningEffortParam = 'grok4_20ReasoningEffort' | 'grok4_5ReasoningEffort';

type GrokReasoningEffortItem = string | { id?: unknown };

interface GrokProxyModelCard extends XAIModelCard {
  api_backend?: string;
  context_window?: number;
  contextWindowTokens?: number;
  description?: string;
  displayName?: string;
  name?: string;
  reasoning?: boolean;
  reasoning_efforts?: GrokReasoningEffortItem[];
  search?: boolean;
  settings?: ChatModelCard['settings'];
  supports_backend_search?: boolean;
  supports_reasoning_effort?: boolean;
}

const GROK_REASONING_EFFORT_PARAMS = new Set<ExtendParamsType>([
  'grok4_20ReasoningEffort',
  'grok4_5ReasoningEffort',
]);

const extractGrokEffortIds = (efforts: GrokProxyModelCard['reasoning_efforts']): string[] => {
  if (!Array.isArray(efforts)) return [];

  return efforts.flatMap((item) => {
    if (typeof item === 'string' && item) return [item];
    if (item && typeof item === 'object' && typeof item.id === 'string' && item.id) {
      return [item.id];
    }
    return [];
  });
};

// Pick from the effort list the proxy reports, not the model id: xhigh is
// grok-4.20's extra step, everything else in this family is grok-4.5's trio.
const resolveGrokReasoningEffortParam = (
  effortIds: string[],
): GrokReasoningEffortParam | undefined => {
  if (effortIds.length === 0) return undefined;

  return effortIds.includes('xhigh') ? 'grok4_20ReasoningEffort' : 'grok4_5ReasoningEffort';
};

const mapGrokProxyModel = (model: GrokProxyModelCard): GrokProxyModelCard => {
  const effortIds = extractGrokEffortIds(model.reasoning_efforts);
  const effortParam = resolveGrokReasoningEffortParam(effortIds);
  const settings = { ...model.settings };

  if (model.supports_backend_search === true) {
    settings.searchImpl = 'params';
  }

  if (effortParam) {
    settings.extendParams = [effortParam];
  }

  return {
    ...model,
    contextWindowTokens: model.contextWindowTokens ?? model.context_window,
    description: model.description,
    displayName: model.displayName ?? model.name,
    reasoning:
      model.supports_reasoning_effort === true || effortIds.length > 0
        ? true
        : model.supports_reasoning_effort === false
          ? false
          : undefined,
    search:
      typeof model.supports_backend_search === 'boolean'
        ? model.supports_backend_search
        : undefined,
    settings: Object.keys(settings).length > 0 ? settings : undefined,
  };
};

const applyLiveGrokReasoningEffort = (
  card: ChatModelCard,
  effortParam?: GrokReasoningEffortParam,
): ChatModelCard => {
  if (!effortParam) return card;

  const extendParams = [
    ...(card.settings?.extendParams ?? []).filter(
      (param) => !GROK_REASONING_EFFORT_PARAMS.has(param),
    ),
    effortParam,
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
 * Grok Build / SuperGrok subscription access to Grok models.
 *
 * Talks to the Grok Build CLI proxy (`cli-chat-proxy.grok.com`) over the
 * OpenAI Responses API, authenticated with an xAI OAuth access token (the
 * same rotating pair as SuperGrok / the Grok Build CLI). Payload handling is
 * shared with `xai` / `supergrok`; the proxy additionally requires the CLI
 * version headers injected via `customClient`.
 *
 * Chat only: image/video generation is not exposed through this proxy.
 */
const handleGrokChatCompletionPayload = (payload: ChatStreamPayload) => ({
  ...handleXAIChatCompletionPayload(payload),
  // Force Responses even when the client sends apiMode:'chatCompletion'
  // (Grok has no enableResponseApi toggle; the factory honours that flag
  // before useResponse:true, but switches on the *handled* payload).
  apiMode: 'responses' as const,
});

const handleGrokResponsesPayload = (payload: ChatStreamPayload) => {
  const handled = handleXAIResponsesPayload(payload);
  const { service_tier: _serviceTier, reasoning, ...rest } = handled;

  return {
    ...rest,
    reasoning: {
      ...reasoning,
      summary: reasoning?.summary ?? 'auto',
    },
  };
};

const randomHex = (byteLength: number) => {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const createTraceparent = () => `00-${randomHex(16)}-${randomHex(8)}-01`;

/**
 * Turn index of this request inside the conversation.
 *
 * It is the number of user messages the payload carries, because that is the only
 * value every replica derives IDENTICALLY from the request itself. A server-side
 * counter would read higher, but it lives in one process: a restart, a second replica
 * or an evicted entry resets it, which is a worse lie than the known one below.
 *
 * Known deviation: truncating history (or replacing it with a summary) makes the count
 * DROP, where a real CLI's index only grows. Fixing that needs a persisted per-topic
 * counter — documented in docs/enterprise/browser-device-profile.md.
 *
 * An explicit `turnIndex` (tests, replay) wins when it is ahead.
 */
const resolveTurnIndex = (turnIndex: unknown, input: unknown): number => {
  const tracked =
    typeof turnIndex === 'number' && Number.isFinite(turnIndex) && turnIndex > 0
      ? Math.floor(turnIndex)
      : 0;

  return Math.max(tracked, getUserMessageCount(input));
};

const getUserMessageCount = (input: unknown) =>
  Array.isArray(input)
    ? Math.max(
        1,
        input.filter((item) => {
          if (!item || typeof item !== 'object') return false;
          return 'role' in item && item.role === 'user';
        }).length,
      )
    : 1;

const decodeBase64UrlJson = (value: string): unknown => {
  try {
    const padded = `${value}${'='.repeat((4 - (value.length % 4)) % 4)}`;
    const normalized = padded.replaceAll('-', '+').replaceAll('_', '/');
    if (typeof atob !== 'function') return undefined;
    const decoded = atob(normalized);

    return JSON.parse(decoded);
  } catch {
    return undefined;
  }
};

const getGrokUserIdFromToken = (apiKey?: string) => {
  const payload = apiKey?.split('.')[1];
  if (!payload) return undefined;

  const claims = decodeBase64UrlJson(payload);
  if (!claims || typeof claims !== 'object') return undefined;

  const principalId = 'principal_id' in claims ? claims.principal_id : undefined;
  const subject = 'sub' in claims ? claims.sub : undefined;

  return typeof principalId === 'string' && principalId
    ? principalId
    : typeof subject === 'string' && subject
      ? subject
      : undefined;
};

export interface GrokIdentity {
  agentId: string;
  sessionId: string;
}

/**
 * Fails CLOSED. Without the installation's persisted id there is no honest
 * `x-grok-agent-id` to send, and the only alternatives — a package constant or a
 * per-process random — are both worse than not sending the request: the first
 * makes every deployment one device, the second makes every restart a new one.
 *
 * Client-side (BYOK) construction cannot reach this: the Grok provider card sets
 * `disableBrowserRequest: true`, so `isProviderFetchOnClient('grok')` is false and
 * chat/model calls always run on the server, where the profile is resolved.
 */
const resolveGrokIdentity = (options: GrokClientOptions): GrokIdentity => {
  const installationId = options.installationId?.trim();
  if (!installationId || !isUuidV4(installationId)) throw new GrokIdentityMissingError();

  const conversationKey = options.conversationKey?.trim() || GROK_DIRECT_CONVERSATION_KEY;
  const firstSeenMs =
    typeof options.firstSeenMs === 'number' && Number.isFinite(options.firstSeenMs)
      ? options.firstSeenMs
      : Date.now();

  return {
    agentId: deriveGrokAgentId(installationId),
    sessionId: deriveConversationSessionId(conversationKey, firstSeenMs),
  };
};

const getGrokResponsesHeaders = (
  payload: { input?: unknown; model?: string; stream?: unknown },
  options: GrokClientOptions & { apiKey?: string },
  { agentId, sessionId }: GrokIdentity,
): Record<string, string> => {
  const userId = getGrokUserIdFromToken(options.apiKey);
  // The factory sends `stream: true` when streaming and drops the key otherwise
  // (structured output and tool calling are always buffered). A real CLI declares
  // SSE only on the call it streams; declaring it on a buffered call would make
  // the client JSON.parse an event stream.
  const streaming = payload.stream === true;

  return {
    'accept': streaming ? 'text/event-stream' : 'application/json',
    'traceparent': createTraceparent(),
    'user-agent': `grok-shell/${GROK_CLIENT_VERSION} (${
      options.userAgentPlatform || GROK_DEFAULT_USER_AGENT_PLATFORM
    })`,
    'x-authenticateresponse': GROK_AUTHENTICATE_RESPONSE,
    'x-grok-agent-id': agentId,
    'x-grok-client-identifier': GROK_CLIENT_IDENTIFIER,
    'x-grok-client-mode': GROK_CLIENT_MODE,
    'x-grok-client-version': GROK_CLIENT_VERSION,
    'x-grok-conv-id': sessionId,
    'x-grok-doom-loop-check': '1024',
    'x-grok-model-override': payload.model || '',
    'x-grok-req-id': crypto.randomUUID(),
    'x-grok-session-id': sessionId,
    'x-grok-turn-idx': String(resolveTurnIndex(options.turnIndex, payload.input)),
    ...(userId && { 'x-grok-user-id': userId }),
    'x-xai-token-auth': GROK_TOKEN_AUTH,
  };
};

const suppressStainlessHeaders = (): Record<string, null> =>
  Object.fromEntries(STAINLESS_HEADERS.map((header) => [header, null]));

/**
 * Wire shape of the CLI's system prompt (E4 §A.1): `{type:'message', role:'system',
 * content}` as `input[0]`, never an `instructions` field. The shared converter emits
 * bare `EasyInputMessage`s, and the factory maps a system prompt to `developer` for
 * the OpenAI Responses API — a role the Grok CLI never sends. Both are normalized
 * here, for EVERY system item, not just `input[0]`: a payload that mixes `developer`
 * and `system` is a shape no CLI produces.
 */
const normalizeGrokInput = (input: unknown) => {
  if (!Array.isArray(input)) return [];

  return input.map((item) => {
    if (!item || typeof item !== 'object' || !('role' in item)) return item;
    const role = (item as { role?: unknown }).role;
    if (role !== 'developer' && role !== 'system') return item;

    return { ...(item as Record<string, unknown>), role: 'system', type: 'message' };
  });
};

export const LobeGrokAI = createOpenAICompatibleRuntime<GrokClientOptions>({
  baseURL: GROK_CLI_CHAT_PROXY_BASE_URL,
  chatCompletion: {
    /**
     * A request without the installation identity is refused BEFORE it leaves, so the
     * failure has to reach the caller as a provider error rather than an unmapped
     * crash (`handleOpenAIError` would otherwise label it a generic runtime error).
     */
    handleError: (error) =>
      error instanceof GrokIdentityMissingError
        ? {
            error: { message: error.message },
            errorType: AgentRuntimeErrorType.ProviderBizError,
            message: error.message,
          }
        : undefined,
    handlePayload: handleGrokChatCompletionPayload,
    useResponse: true,
  },
  customClient: {
    createClient: (options) =>
      new OpenAI({
        ...options,
        defaultHeaders: {
          ...options.defaultHeaders,
          ...suppressStainlessHeaders(),
          'Accept': '*/*',
          'User-Agent': `grok-shell/${GROK_CLIENT_VERSION} (${
            options.userAgentPlatform || GROK_DEFAULT_USER_AGENT_PLATFORM
          })`,
        } as OpenAIDefaultHeaders,
      }),
  },
  debug: {
    chatCompletion: () => process.env.DEBUG_GROK_CHAT_COMPLETION === '1',
    responses: () => process.env.DEBUG_GROK_RESPONSES === '1',
  },
  models: async ({ client }) => {
    const modelsPage = (await client.models.list()) as { data?: GrokProxyModelCard[] };
    const modelList = Array.isArray(modelsPage.data) ? modelsPage.data : [];
    const effortParamById = new Map(
      modelList.map((model) => [
        model.id,
        resolveGrokReasoningEffortParam(extractGrokEffortIds(model.reasoning_efforts)),
      ]),
    );

    const cards = await processModelList(
      modelList.map(mapGrokProxyModel),
      MODEL_LIST_CONFIGS.xai,
      'grok',
    );

    return cards.map((card) => applyLiveGrokReasoningEffort(card, effortParamById.get(card.id)));
  },
  // Structured output must take the SAME wire path as chat: `generateObject` does not
  // inherit `chatCompletion.useResponse`, so without this it would go to
  // /v1/chat/completions with none of the CLI headers (the proxy only ever sees the
  // Responses endpoint from a real CLI).
  // `preserveCustomMappedErrors`: the identity refusal below is mapped by THIS provider,
  // so structured output must surface it as the same ProviderBizError chat does instead of
  // rethrowing the raw class (opt-in — the factory default is unchanged for everyone else).
  generateObject: { preserveCustomMappedErrors: true, useResponse: true },
  provider: ModelProvider.Grok,
  responses: {
    handlePayload: handleGrokResponsesPayload,
    prepareRequest: (payload, options) => {
      const {
        input,
        instructions: _instructions,
        metadata: _metadata,
        safety_identifier: _safetyIdentifier,
        user: _user,
        ...rest
      } = payload as typeof payload & {
        instructions?: unknown;
        metadata?: unknown;
        user?: unknown;
      };
      const preparedPayload = {
        ...rest,
        input: normalizeGrokInput(input),
      };
      // Resolved once per request: the session id must be identical in the headers
      // and in `prompt_cache_key`, and the fallback first-seen time is "now".
      const identity = resolveGrokIdentity(options);

      return {
        headers: getGrokResponsesHeaders(preparedPayload, options, identity),
        payload: {
          ...preparedPayload,
          prompt_cache_key: identity.sessionId,
          store: false,
        },
      };
    },
  },
});
