import { decodedBase64ByteLength, sanitizedUrlHost } from '@lobechat/utils';
import createDebug from 'debug';

import type { CreateImageOptions } from '../../core/openaiCompatibleFactory';
import type { CreateImagePayload, CreateImageResponse } from '../../types/image';
import { AgentRuntimeError } from '../../utils/createError';

const log = createDebug('lobe-image:xai');

const DATA_URI_PREFIX = 'data:';
const BASE64_MARKER = ';base64,';

/**
 * Metadata-only descriptions of image inputs for debug logs.
 * Never includes the URL, query string, or base64 payload.
 */
export const describeImageInputs = (urls: string[]) =>
  urls.map((url) => {
    if (url.startsWith(DATA_URI_PREFIX)) {
      const markerIndex = url.indexOf(BASE64_MARKER);
      const hasPayload = markerIndex > DATA_URI_PREFIX.length;
      const mimeType = hasPayload ? url.slice(DATA_URI_PREFIX.length, markerIndex) : 'unknown';
      const base64 = hasPayload ? url.slice(markerIndex + BASE64_MARKER.length) : '';
      let byteLength = 0;
      try {
        byteLength = decodedBase64ByteLength(base64);
      } catch {
        // Invalid base64 — still report mime type without leaking the payload.
      }
      return { byteLength, mimeType };
    }

    return { host: sanitizedUrlHost(url) };
  });

interface XAIImageRequest {
  aspect_ratio?:
    | '1:1'
    | '3:4'
    | '4:3'
    | '9:16'
    | '16:9'
    | '2:3'
    | '3:2'
    | '9:19.5'
    | '19.5:9'
    | '9:20'
    | '20:9'
    | '1:2'
    | '2:1'
    | 'auto';
  image?: {
    type: 'image_url';
    url: string;
  };
  images?: Array<{
    type: 'image_url';
    url: string;
  }>;
  mask?: {
    type: 'image_url';
    url: string;
  };
  model: string;
  n?: number;
  prompt: string;
  quality?: 'low' | 'medium' | 'high';
  resolution?: '1k' | '2k';
  response_format?: 'url' | 'b64_json';
  size?: string;
  style?: string;
  user?: string;
}

interface XAIImageData {
  b64_json?: string | null;
  revised_prompt: string;
  url?: string | null;
}

interface XAIImageResponse {
  data: XAIImageData[];
}

/**
 * Create image using XAI (Grok) API
 */
export async function createXAIImage(
  payload: CreateImagePayload,
  options: CreateImageOptions,
): Promise<CreateImageResponse> {
  const { apiKey, baseURL, provider } = options;
  const { model, params } = payload;

  try {
    const hasImageUrl = params.imageUrl && params.imageUrl !== '';
    const hasImageUrls = params.imageUrls && params.imageUrls.length > 0;
    const isImageEdit = hasImageUrl || hasImageUrls;
    const endpoint = isImageEdit ? `${baseURL}/images/edits` : `${baseURL}/images/generations`;

    const requestBody: XAIImageRequest = {
      model,
      prompt: params.prompt,
    };

    if (!isImageEdit && params.aspectRatio) {
      requestBody.aspect_ratio = params.aspectRatio as XAIImageRequest['aspect_ratio'];
    }

    if (params.resolution) {
      requestBody.resolution = params.resolution as XAIImageRequest['resolution'];
    }

    if (isImageEdit) {
      // xAI accepts a base64 data URL in `image_url` (docs.x.ai images API).
      // Pass data URIs through as-is rather than requiring http(s) — own-origin
      // `/f/<id>` URLs are inlined to data URIs server-side before this runs.
      if (hasImageUrl && params.imageUrl) {
        requestBody.image = {
          type: 'image_url',
          url: params.imageUrl,
        };
      } else if (hasImageUrls && params.imageUrls) {
        requestBody.images = params.imageUrls.map((url) => ({
          type: 'image_url',
          url,
        }));
      }
    }

    const inputUrls = [
      ...(requestBody.image?.url ? [requestBody.image.url] : []),
      ...(requestBody.images?.map((item) => item.url) ?? []),
    ];
    log(
      'Calling XAI image API: model=%s endpoint=%s imageCount=%d images=%O',
      model,
      endpoint,
      inputUrls.length,
      describeImageInputs(inputUrls),
    );

    const response = await fetch(endpoint, {
      body: JSON.stringify(requestBody),
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });

    if (!response.ok) {
      let errorData;
      try {
        errorData = await response.json();
      } catch {
        // Failed to parse JSON error response
      }

      throw new Error(
        `XAI API error (${response.status}): ${errorData?.error?.message || response.statusText}`,
      );
    }

    const data: XAIImageResponse = await response.json();

    log('Image generation response: %O', data);

    if (!data.data || data.data.length === 0) {
      throw new Error('No images generated in response');
    }

    const imageUrl = data.data[0].url;

    if (!imageUrl) {
      throw new Error('No valid image URL in response');
    }

    log('Image generated successfully: %s', imageUrl);

    return { imageUrl };
  } catch (error) {
    log('Error in createXAIImage: %O', error);

    throw AgentRuntimeError.createImage({
      error: error as any,
      errorType: 'ProviderBizError',
      provider,
    });
  }
}
