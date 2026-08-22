import type { OwnDeploymentOrigins } from '@lobechat/utils';
import { isRecord } from '@lobechat/utils/object';
import debug from 'debug';
import type { ChatModelCard } from 'model-bank';
import { ModelProvider } from 'model-bank';
import OpenAI from 'openai';

import { degradeFileUrlPartsToText } from '../../core/contextBuilders';
import { createOpenAICompatibleRuntime } from '../../core/openaiCompatibleFactory';
import type { ChatMethodOptions, ChatStreamPayload } from '../../types';
import { AgentRuntimeErrorType } from '../../types/error';
import { MODEL_LIST_CONFIGS, processModelList } from '../../utils/modelParse';
import { handleXAIChatCompletionPayload, handleXAIResponsesPayload } from '../xai';
import { createXAIImage } from '../xai/createImage';
import { createXAIVideo } from '../xai/createVideo';
import type { XAIModelCard } from '../xai/mapXAIModel';
import { mapXAIModel } from '../xai/mapXAIModel';
import {
  collectErrorStrings,
  isXaiZdrFileUnsupportedError,
  toXaiZdrBizError,
  xaiZdrErrorBody,
} from '../xai/zdr';

const log = debug('lobe-supergrok:zdr');

const SUPERGROK_GENERATION_TYPES = new Set(['image', 'video']);
const SUPERGROK_FILE_MAX_BYTES = 48 * 1024 * 1024;
const SUPERGROK_FILE_EXPIRES_AFTER_SECONDS = 86_400;

export const SUPERGROK_ZDR_FILE_UNSUPPORTED_MESSAGE =
  'This SuperGrok account has zero-data-retention enabled; native file attachments are refused by xAI';

export interface SuperGrokClientOptions {
  /**
   * Deployment origins used when inlining own-origin file URLs. The factory's
   * `withOwnOrigins` copies this onto `inlineFile`.
   */
  ownOrigins?: OwnDeploymentOrigins | Promise<OwnDeploymentOrigins>;
}

interface SuperGrokUploadContext {
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * POST /v1/files as multipart. `expires_after` must precede `file` or xAI
 * answers 400. Uses the runtime's `fetch` when the constructor supplied one.
 */
const uploadSuperGrokFile = async (
  input: { bytes: Uint8Array; filename: string; mimeType: string },
  context: SuperGrokUploadContext = {},
): Promise<{ fileId: string }> => {
  const baseURL = (context.baseURL || 'https://api.x.ai/v1').replace(/\/$/, '');
  const form = new FormData();
  form.append('expires_after', String(SUPERGROK_FILE_EXPIRES_AFTER_SECONDS));
  form.append('purpose', 'assistants');
  form.append(
    'file',
    new Blob([input.bytes as BlobPart], {
      type: input.mimeType || 'application/octet-stream',
    }),
    input.filename,
  );

  const fetchImpl = context.fetch ?? globalThis.fetch;
  const response = await fetchImpl(`${baseURL}/files`, {
    body: form,
    headers: { Authorization: `Bearer ${context.apiKey ?? ''}` },
    method: 'POST',
    signal: context.signal,
  });

  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const texts: string[] = [];
    collectErrorStrings(payload, texts);
    throw Object.assign(new Error(texts[0] || `File upload failed (${response.status})`), {
      body: payload,
      error: payload,
      status: response.status,
    });
  }

  const id = isRecord(payload) && typeof payload.id === 'string' ? payload.id : undefined;
  if (!id) throw new Error('File upload did not return an id');
  return { fileId: id };
};

/**
 * `/v1/models` is chat-oriented and may omit imagine image/video slugs (or list
 * them without `parameters`). Always union the static bank generation cards by
 * id so admin sync / empty gated lists keep `grok-imagine-image` and
 * `grok-imagine-video`.
 */
const unionSuperGrokBankGenerationModels = async (
  processed: ChatModelCard[],
): Promise<ChatModelCard[]> => {
  const { supergrok } = await import('model-bank');
  const bankCards = supergrok.filter((model) => SUPERGROK_GENERATION_TYPES.has(model.type));
  if (bankCards.length === 0) return processed;

  // The static bank card is the trusted, complete shape (type + parameters).
  // `processModelList` keeps `parameters` only for image cards, so a live
  // `/v1/models` entry that collides by id would otherwise shadow the video
  // card with a parameter-less copy. Static wins by id; the rest of the live
  // list is preserved in order.
  const bankById = new Map(bankCards.map((card) => [card.id, card as ChatModelCard]));
  const merged = processed.map((card) => bankById.get(card.id) ?? card);
  const seen = new Set(processed.map((card) => card.id));
  const missing = bankCards.filter((model) => !seen.has(model.id)) as ChatModelCard[];
  return [...merged, ...missing];
};

/**
 * SuperGrok / X Premium subscription access to Grok models.
 *
 * Talks to the exact same OpenAI-compatible `https://api.x.ai/v1` endpoint as
 * the `xai` provider (payload handling, image, and video are shared), but
 * authenticates with an OAuth access token instead of an API key. The token is
 * refreshed and injected server-side (see `apps/server` oauthDeviceFlow refresh
 * service) — this runtime stays a stateless bearer client, receiving the fresh
 * token as `apiKey`. Documents are uploaded to `/v1/files` and referenced as
 * Responses `input_file.file_id` (api.x.ai does not document `file_data`).
 */
const LobeSuperGrokAIBase = createOpenAICompatibleRuntime<SuperGrokClientOptions>({
  baseURL: 'https://api.x.ai/v1',
  chatCompletion: {
    forceFileBase64: true,
    handleError: (error) => {
      if (isXaiZdrFileUnsupportedError(error)) {
        return {
          error: xaiZdrErrorBody(error, SUPERGROK_ZDR_FILE_UNSUPPORTED_MESSAGE),
          errorType: AgentRuntimeErrorType.ProviderBizError,
          message: SUPERGROK_ZDR_FILE_UNSUPPORTED_MESSAGE,
        };
      }
      return undefined;
    },
    handlePayload: handleXAIChatCompletionPayload,
    inlineFile: { maxBytes: SUPERGROK_FILE_MAX_BYTES, ownOriginOnly: true },
    uploadFile: uploadSuperGrokFile,
    useResponse: true,
  },
  createImage: createXAIImage,
  createVideo: createXAIVideo,
  customClient: {
    createClient: ({ ownOrigins: _ownOrigins, ...options }) => new OpenAI(options),
  },
  handlePollVideoStatus: async (inferenceId, options) => {
    const { pollXAIVideoStatus } = await import('../xai/createVideo');
    return pollXAIVideoStatus(inferenceId, {
      apiKey: options.apiKey,
      baseURL: options.baseURL || '',
    });
  },
  debug: {
    chatCompletion: () => process.env.DEBUG_SUPERGROK_CHAT_COMPLETION === '1',
    responses: () => process.env.DEBUG_SUPERGROK_RESPONSES === '1',
  },
  models: async ({ client }) => {
    const modelsPage = (await client.models.list()) as { data?: XAIModelCard[] };
    if (!Array.isArray(modelsPage?.data)) {
      throw new TypeError('SuperGrok models payload was not a list');
    }

    const processed = await processModelList(
      modelsPage.data.map(mapXAIModel),
      MODEL_LIST_CONFIGS.xai,
      'supergrok',
    );

    return unionSuperGrokBankGenerationModels(processed);
  },
  promptCacheKeyModels: [/^grok-/],
  provider: ModelProvider.SuperGrok,
  responses: {
    handlePayload: handleXAIResponsesPayload,
  },
});

/**
 * Wraps factory `chat` so a ZDR file refusal retries the same turn once with
 * extracted text. `beforeChat` lives on ModelRuntime, outside this class, so
 * the retry does not re-run attachment inlining (or any other outer hook).
 */
export class LobeSuperGrokAI extends LobeSuperGrokAIBase {
  async chat(payload: ChatStreamPayload, options?: ChatMethodOptions) {
    try {
      return await super.chat(payload, options);
    } catch (error) {
      if (!isXaiZdrFileUnsupportedError(error)) throw error;

      const { degraded, messages } = degradeFileUrlPartsToText(payload.messages ?? []);
      if (degraded === 0) {
        throw toXaiZdrBizError(
          error,
          SUPERGROK_ZDR_FILE_UNSUPPORTED_MESSAGE,
          ModelProvider.SuperGrok,
        );
      }

      log('ZDR account refused native files; retried with extracted text');
      try {
        return await super.chat({ ...payload, messages }, options);
      } catch (retryError) {
        if (isXaiZdrFileUnsupportedError(retryError)) {
          throw toXaiZdrBizError(
            retryError,
            SUPERGROK_ZDR_FILE_UNSUPPORTED_MESSAGE,
            ModelProvider.SuperGrok,
          );
        }
        throw retryError;
      }
    }
  }
}
