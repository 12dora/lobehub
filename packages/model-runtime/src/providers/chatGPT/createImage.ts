import { BRANDING_NAME } from '@lobechat/business-const';
import { CURRENT_VERSION } from '@lobechat/const';
import { imageUrlToBase64 } from '@lobechat/utils';
import { isRecord } from '@lobechat/utils/object';
import debug from 'debug';
import OpenAI from 'openai';

import type { CreateImageOptions } from '../../core/openaiCompatibleFactory';
import type { CreateImageErrorPayload, CreateImagePayload, CreateImageResponse } from '../../types';
import { AgentRuntimeErrorType } from '../../types';
import { AgentRuntimeError } from '../../utils/createError';
import { parseDataUri } from '../../utils/uriParser';

const log = debug('lobe-image:chatgpt');

export const IMAGE_MODEL = 'gpt-image-2';
export const MAX_REFERENCE_IMAGES = 5;
/** Mirrors the model card `maxFileSize` — the card only constrains the UI. */
export const MAX_REFERENCE_BYTES = 5 * 1024 * 1024;

const CHATGPT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const USER_AGENT = `${BRANDING_NAME}/${CURRENT_VERSION}`;

const QUALITY_VALUES = new Set(['low', 'medium', 'high', 'auto']);
const BACKGROUND_VALUES = new Set(['transparent', 'opaque', 'auto']);

type ChatGPTCreateImageOptions = CreateImageOptions & {
  chatgptAccountId?: string;
};

interface CodexImageData {
  b64_json?: string | null;
}

interface CodexImageResponse {
  background?: string;
  created?: number;
  data?: CodexImageData[];
  quality?: string;
  size?: string;
}

const isCreateImageErrorPayload = (value: unknown): value is CreateImageErrorPayload =>
  isRecord(value) &&
  typeof value.errorType === 'string' &&
  typeof value.provider === 'string' &&
  !(value instanceof Error);

const asNonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const getHttpStatus = (error: unknown): number | undefined => {
  if (!isRecord(error)) return undefined;
  if (typeof error.status === 'number') return error.status;
  if (typeof error.statusCode === 'number') return error.statusCode;
  return undefined;
};

const getUpstreamMessage = (error: unknown): string | undefined => {
  if (typeof error === 'string' && error.length > 0) return error;
  if (!isRecord(error)) return undefined;

  if (isRecord(error.error)) {
    const nested = asNonEmptyString(error.error.message);
    if (nested) return nested;
  }

  return asNonEmptyString(error.message);
};

const fail = (
  provider: string,
  errorType: CreateImageErrorPayload['errorType'],
  message: string,
  extra?: Record<string, unknown>,
): CreateImageErrorPayload =>
  AgentRuntimeError.createImage({
    error: { message, ...extra },
    errorType,
    provider,
  });

const mapCreateImageError = (error: unknown, provider: string): CreateImageErrorPayload => {
  if (isCreateImageErrorPayload(error)) return error;

  const status = getHttpStatus(error);
  const message = getUpstreamMessage(error) ?? 'ChatGPT image request failed';

  if (status === 401) {
    return fail(provider, AgentRuntimeErrorType.InvalidProviderAPIKey, message, { status });
  }

  if (status === 403) {
    return fail(provider, AgentRuntimeErrorType.PermissionDenied, message, { status });
  }

  if (status === 400) {
    return fail(provider, AgentRuntimeErrorType.InvalidRequestFormat, message, { status });
  }

  return fail(provider, AgentRuntimeErrorType.ProviderBizError, message, {
    ...(status !== undefined ? { status } : {}),
  });
};

const collectReferenceUrls = (params: CreateImagePayload['params']): string[] => {
  const urls: string[] = [];
  if (typeof params.imageUrl === 'string' && params.imageUrl.length > 0) {
    urls.push(params.imageUrl);
  }
  if (Array.isArray(params.imageUrls)) {
    for (const url of params.imageUrls) {
      if (typeof url === 'string' && url.length > 0) urls.push(url);
    }
  }
  return urls;
};

/**
 * Convert a caller URL to a base64 data URL. Codex cannot fetch our file hosts,
 * so http(s) references are inlined server-side with a bounded SSRF-safe fetch.
 */
const toBase64DataUrl = async (imageUrl: string): Promise<string> => {
  const { type, base64, mimeType } = parseDataUri(imageUrl);

  if (type === 'base64') {
    if (!base64) {
      throw new TypeError('Reference image data URL is missing base64 data');
    }
    return `data:${mimeType || 'image/png'};base64,${base64}`;
  }

  if (type === 'url') {
    const { base64: urlBase64, mimeType: urlMimeType } = await imageUrlToBase64(imageUrl, {
      maxBytes: MAX_REFERENCE_BYTES,
    });
    return `data:${urlMimeType || 'image/png'};base64,${urlBase64}`;
  }

  throw new TypeError('Reference image is neither a data URI nor an absolute URL');
};

const parseWxH = (size: string | undefined): { height?: number; width?: number } => {
  if (!size) return {};
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) return {};
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return {};
  }
  return { height, width };
};

const readPngSize = (b64: string): { height?: number; width?: number } => {
  try {
    const prefix = b64.slice(0, 48);
    const bytes = Uint8Array.from(Buffer.from(prefix, 'base64'));
    // 8-byte PNG signature, 4 length, "IHDR", then width/height as BE u32
    if (bytes.length < 24) return {};
    if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
      return {};
    }
    const width = ((bytes[16] << 24) >>> 0) + (bytes[17] << 16) + (bytes[18] << 8) + bytes[19];
    const height = ((bytes[20] << 24) >>> 0) + (bytes[21] << 16) + (bytes[22] << 8) + bytes[23];
    if (!width || !height) return {};
    return { height, width };
  } catch {
    return {};
  }
};

const optionalEnum = (value: unknown, allowed: Set<string>): string | undefined => {
  if (typeof value !== 'string' || !allowed.has(value)) return undefined;
  return value;
};

const resolveClient = (options: ChatGPTCreateImageOptions): OpenAI => {
  if (options.client) return options.client;

  return new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL || CHATGPT_CODEX_BASE_URL,
    defaultHeaders: {
      ...options.defaultHeaders,
      ...(options.chatgptAccountId && { 'ChatGPT-Account-Id': options.chatgptAccountId }),
      'User-Agent': USER_AGENT,
      'originator': 'lobehub',
      'session-id': crypto.randomUUID(),
      'version': CURRENT_VERSION,
    },
  });
};

/**
 * Codex image generation is a JSON POST to `/images/generations` or `/images/edits`.
 * The OpenAI SDK Images API (multipart generate/edit) is the wrong protocol.
 */
export async function createChatGPTImage(
  payload: CreateImagePayload,
  options: ChatGPTCreateImageOptions,
): Promise<CreateImageResponse> {
  const { provider } = options;
  const { model, params } = payload;
  const requestModel = model || IMAGE_MODEL;

  try {
    const referenceUrls = collectReferenceUrls(params);
    if (referenceUrls.length > MAX_REFERENCE_IMAGES) {
      throw fail(
        provider,
        AgentRuntimeErrorType.InvalidRequestFormat,
        `ChatGPT image edits accept at most ${MAX_REFERENCE_IMAGES} reference images`,
      );
    }

    const isEdit = referenceUrls.length > 0;
    const path = isEdit ? '/images/edits' : '/images/generations';

    const body: Record<string, unknown> = {
      model: requestModel,
      prompt: params.prompt,
    };

    if (typeof params.size === 'string' && params.size.length > 0) {
      body.size = params.size;
    }

    const quality = optionalEnum(params.quality, QUALITY_VALUES);
    if (quality) body.quality = quality;

    const background = optionalEnum(params.background, BACKGROUND_VALUES);
    if (background) body.background = background;

    if (isEdit) {
      body.images = (await Promise.all(referenceUrls.map((url) => toBase64DataUrl(url)))).map(
        (imageUrl) => ({ image_url: imageUrl }),
      );
    }

    const client = resolveClient(options);
    const headers = {
      'originator': 'lobehub',
      'x-codex-image-turn-id': crypto.randomUUID(),
    };

    log('POST %s model=%s edit=%s', path, requestModel, isEdit);

    const response = await client.post<CodexImageResponse>(path, { body, headers });

    const imageData = response?.data?.[0];
    const b64 = asNonEmptyString(imageData?.b64_json);
    if (!b64) {
      throw fail(
        provider,
        AgentRuntimeErrorType.ProviderBizError,
        'Invalid image response: missing or empty data array',
      );
    }

    const dimensions = parseWxH(asNonEmptyString(response.size)) ?? {};
    const pngSize = dimensions.width && dimensions.height ? dimensions : readPngSize(b64);

    return {
      imageUrl: `data:image/png;base64,${b64}`,
      ...(pngSize.width ? { width: pngSize.width } : {}),
      ...(pngSize.height ? { height: pngSize.height } : {}),
    };
  } catch (error) {
    log('createImage failed: %O', error);
    throw mapCreateImageError(error, provider);
  }
}
