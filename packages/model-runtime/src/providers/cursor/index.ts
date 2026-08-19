import type { ChatModelCard } from '@lobechat/types';
import createDebug from 'debug';
import { cursor as cursorChatModels } from 'model-bank';

import { deriveCursorConversationId, isUuidV4 } from '../../browserProfile';
import type { LobeRuntimeAI } from '../../core/BaseAI';
import { CursorStream } from '../../core/streams/cursor';
import type { ChatMethodOptions, ChatStreamPayload } from '../../types';
import { AgentRuntimeErrorType } from '../../types/error';
import { AgentRuntimeError } from '../../utils/createError';
import { debugStream } from '../../utils/debugStream';
import { StreamingResponse } from '../../utils/response';
import { isCursorToolsActive } from './toolProtocol';
import { buildCursorTurn } from './turn';

const log = createDebug('lobe-cursor:runtime');

export const CURSOR_TRANSPORT_ORIGIN = 'https://cursor.local';

/**
 * Private runtime→transport header (never leaves this process: the transport strips it
 * before spawning the CLI). Carries the stable per-conversation chat id that becomes
 * `cursor-agent --new-session-id <uuid>`, so every turn of one AIHub conversation is
 * one Cursor session instead of a brand-new chat per turn.
 */
export const CURSOR_CONVERSATION_HEADER = 'x-aihub-conversation';

const DEFAULT_PROVIDER = 'cursor';
const DEBUG_FLAG = 'DEBUG_CURSOR_CHAT_COMPLETION';
const TRANSPORT_UNAVAILABLE = 'Cursor Agent transport unavailable';
const CURSOR_CATALOG = new Map(cursorChatModels.map((model) => [model.id, model]));

type CursorCatalogEntry = (typeof cursorChatModels)[number];

/** Map a model-bank entry onto a chat card. Settings are shallow-cloned. */
export const toCursorKnownModelCard = (
  id: string,
  remoteName: string | undefined,
  known: Pick<CursorCatalogEntry, 'abilities' | 'contextWindowTokens' | 'displayName' | 'settings'>,
): ChatModelCard => {
  const displayName = known.displayName || remoteName || id;
  const reasoning = known.abilities?.reasoning;
  return {
    abilities: known.abilities,
    contextWindowTokens: known.contextWindowTokens,
    displayName,
    enabled: false,
    functionCall: known.abilities?.functionCall,
    id,
    reasoning,
    settings: known.settings ? { ...known.settings } : undefined,
    type: 'chat',
    vision: known.abilities?.vision,
  };
};

export interface LobeCursorAIParams {
  apiKey?: string;
  baseURL?: string;
  /** Stable per-conversation key supplied by the server/runtime seam. */
  conversationKey?: string;
  fetch?: typeof fetch;
  id?: string;
  /** Installation-wide UUIDv4; scopes the derived chat id to this deployment. */
  installationId?: string;
}

interface CursorModelsResponse {
  models?: Array<{ id?: string; name?: string }>;
}

interface CursorErrorBody {
  error?: { code?: string; message?: string };
}

const isAbortError = (error: unknown): boolean =>
  (error as { name?: unknown } | undefined)?.name === 'AbortError';

const isRuntimeError = (error: unknown): boolean =>
  !!error && typeof error === 'object' && 'errorType' in error;

export class LobeCursorAI implements LobeRuntimeAI {
  baseURL: string;
  provider: string;

  private readonly apiKey?: string;
  private readonly conversationId?: string;
  private readonly fetchImpl: typeof fetch;

  constructor({
    apiKey,
    baseURL,
    conversationKey,
    fetch: customFetch,
    id,
    installationId,
  }: LobeCursorAIParams = {}) {
    this.apiKey = apiKey;
    this.baseURL = (baseURL ?? CURSOR_TRANSPORT_ORIGIN).replace(/\/+$/, '');
    this.provider = id || DEFAULT_PROVIDER;
    this.fetchImpl = customFetch ?? ((input, init) => globalThis.fetch(input, init));
    // Both halves are required: without the installation id two deployments sharing one
    // Cursor account could derive the same chat id, and without a conversation key there
    // is no conversation to be stable across. Missing or malformed → no header, and the
    // CLI mints its own id exactly as before.
    this.conversationId =
      installationId && isUuidV4(installationId) && conversationKey
        ? deriveCursorConversationId(installationId, conversationKey)
        : undefined;
  }

  async chat(payload: ChatStreamPayload, options?: ChatMethodOptions): Promise<Response> {
    const inputStartAt = Date.now();
    const body = buildCursorTurn({
      messages: payload.messages,
      model: payload.model,
      tool_choice: payload.tool_choice,
      tools: payload.tools,
    });

    const response = await this.request(`${this.baseURL}/v1/turn`, {
      body: JSON.stringify(body),
      headers: {
        'Accept': 'text/event-stream',
        'Content-Type': 'application/json',
        ...(this.conversationId ? { [CURSOR_CONVERSATION_HEADER]: this.conversationId } : {}),
      },
      method: 'POST',
      signal: options?.signal,
    });

    if (!response.body) {
      throw this.toRuntimeError(
        AgentRuntimeErrorType.ProviderBizError,
        'Cursor Agent returned an empty stream',
      );
    }

    let responseBody = response.body;
    if (process.env[DEBUG_FLAG] === '1') {
      const [prod, useForDebug] = responseBody.tee();
      debugStream(useForDebug).catch(console.error);
      responseBody = prod;
    }

    const stream = CursorStream(responseBody, {
      callbacks: options?.callback,
      inputStartAt,
      model: payload.model,
      parseToolCalls: isCursorToolsActive(payload.tools, payload.tool_choice),
      provider: this.provider,
    });

    return StreamingResponse(stream, { headers: options?.headers });
  }

  async models(): Promise<ChatModelCard[]> {
    const response = await this.request(`${this.baseURL}/v1/models`, {
      headers: { Accept: 'application/json' },
      method: 'GET',
    });

    let json: CursorModelsResponse;
    try {
      json = (await response.json()) as CursorModelsResponse;
    } catch {
      throw this.toRuntimeError(
        AgentRuntimeErrorType.ProviderBizError,
        'Cursor Agent models response was not JSON',
      );
    }

    const models = Array.isArray(json.models) ? json.models : [];
    return models
      .filter(
        (model): model is { id: string; name?: string } =>
          typeof model?.id === 'string' && model.id.length > 0,
      )
      .map((model) => {
        const id = model.id;
        const known = CURSOR_CATALOG.get(id);
        if (known) return toCursorKnownModelCard(id, model.name, known);
        const displayName = model.name || id;
        return {
          abilities: undefined,
          contextWindowTokens: /1m/i.test(displayName) ? 1_000_000 : undefined,
          displayName,
          enabled: false,
          id,
          reasoning: undefined,
          type: 'chat' as const,
        } as ChatModelCard;
      });
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers: {
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          ...init.headers,
        },
      });
    } catch (error) {
      if (isAbortError(error) || isRuntimeError(error)) throw error;
      log('transport request failed: %s', error instanceof Error ? error.name : typeof error);
      throw this.toRuntimeError(AgentRuntimeErrorType.ProviderBizError, TRANSPORT_UNAVAILABLE);
    }

    if (!response.ok) throw await this.toHttpError(response);
    return response;
  }

  private async toHttpError(response: Response) {
    const text = await response.text().catch(() => '');
    let body: CursorErrorBody = {};
    if (text) {
      try {
        body = JSON.parse(text) as CursorErrorBody;
      } catch {
        body = { error: { message: text.slice(0, 500) } };
      }
    }

    const code = body.error?.code;
    const message = body.error?.message || `Cursor Agent request failed (${response.status})`;
    const errorType =
      code === 'unauthorized' || response.status === 401
        ? AgentRuntimeErrorType.OAuthAuthorizationExpired
        : AgentRuntimeErrorType.ProviderBizError;

    throw this.toRuntimeError(errorType, message, { code, status: response.status });
  }

  private toRuntimeError(
    errorType: (typeof AgentRuntimeErrorType)[keyof typeof AgentRuntimeErrorType],
    message: string,
    error: Record<string, unknown> = {},
  ) {
    return AgentRuntimeError.chat({
      error: { message, ...error },
      errorType,
      message,
      provider: this.provider,
    });
  }
}
