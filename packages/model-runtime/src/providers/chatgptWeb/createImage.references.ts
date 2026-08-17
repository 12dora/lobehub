/**
 * Reference-image ingestion for ChatGPT Web image generation: bounded fetch,
 * exact base64 sizing, and upload of up to the runtime's per-call set.
 */

import { ssrfSafeFetch } from '@lobechat/ssrf-safe-fetch';
import createDebug from 'debug';

import { parseDataUri } from '../../utils/uriParser';
import { base64ToBytes } from './binary';
import type { ChatGPTWebClient } from './client';
import { readBoundedBody } from './client';
import { errorLabel, MIME_EXTENSIONS, safeHost } from './createImage.errors';
import { ChatGPTWebError, isChatGPTWebError } from './errors';
import { composeSignals, timeoutSignal } from './http';
import { readImageDimensions } from './imageDimensions';
import type { AttachmentRef } from './types';

const log = createDebug('lobe-chatgptweb:image');

/**
 * Decoded ceiling for one reference image, mirroring the model card's
 * `maxFileSize`. The card only constrains the UI — an API caller can post
 * anything, so the runtime enforces it again.
 */
export const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;

/** Per-reference network cap; still bounded by whatever the budget has left. */
const REFERENCE_FETCH_TIMEOUT_MS = 30_000;

interface ReferenceBytes {
  bytes: Uint8Array;
  mimeType?: string;
}

/**
 * The whole-call budget expiring must ALWAYS surface as a `timeout` kind, no
 * matter what the aborted phase turned it into. A phase that wraps the abort in
 * a generic `Error` maps to `ProviderBizError`, and the async router then never
 * reaches its `TaskTimeout` branch.
 */
const budgetTimeout = (signal: AbortSignal, phase: string): unknown => {
  const reason = signal.reason;
  if (isChatGPTWebError(reason)) return reason;
  return new ChatGPTWebError('timeout', `the image ${phase} hit the whole-call timeout`, {
    cause: reason,
  });
};

export interface PhaseOptions {
  /** Milliseconds left in the whole-call budget. */
  remaining: () => number;
  signal: AbortSignal;
}

/** Milliseconds this request may take: its own cap, clamped by the budget. */
export const boundedTimeout = (preferred: number, remaining: () => number): number =>
  Math.max(1, Math.min(preferred, remaining()));

/**
 * Fetch an http(s) reference through the SSRF-safe transport with a hard byte
 * ceiling.
 *
 * `imageUrlToBase64()` cannot be used here: it buffers the whole body with no
 * cap, skips the status check, and `console.error`s the raw error — which for
 * `node-fetch` embeds the full request URL (query string included).
 */
const fetchReference = async (
  url: string,
  { remaining, signal }: PhaseOptions,
): Promise<ReferenceBytes> => {
  const host = safeHost(url);
  const deadline = timeoutSignal(boundedTimeout(REFERENCE_FETCH_TIMEOUT_MS, remaining));
  const composed = composeSignals([signal, deadline.signal]);

  try {
    const response = await ssrfSafeFetch(
      url,
      { signal: composed.signal },
      // one byte over the limit is enough to prove the body is too big; the
      // helper truncates silently, so `readBoundedBody` does the rejecting
      { maxContentLength: MAX_REFERENCE_BYTES + 1 },
    );
    if (!response.ok)
      throw new ChatGPTWebError('upstream', `reference fetch answered ${response.status}`, {
        status: response.status,
      });

    return {
      bytes: await readBoundedBody(response, MAX_REFERENCE_BYTES),
      mimeType: response.headers.get('content-type')?.split(';')[0].trim() || undefined,
    };
  } catch (error) {
    // The budget firing means the WHOLE CALL is out of time, not that this one
    // reference is unreadable — wrapping it below would report a provider error
    // where the caller must see a timeout.
    if (signal.aborted) throw budgetTimeout(signal, 'reference fetch');
    if (remaining() <= 0)
      throw new ChatGPTWebError('timeout', 'the image reference fetch hit the whole-call timeout', {
        cause: error,
      });

    log('reference fetch failed for host %s: %s', host, errorLabel(error));
    // TODO(chatgptweb): `ssrf-safe-fetch` itself `console.error`s the raw error,
    // and node-fetch bakes the full request URL (query signature included) into
    // that message. Nothing WE log or throw carries the URL, but the shared
    // helper has to stop logging it before a presigned reference is safe from
    // the server log.
    //
    // the cause stays in-process for debugging; only this message is ever
    // rendered for the user, and it carries the host without the query string
    throw new Error(`the reference image at ${host} could not be read`, { cause: error });
  } finally {
    deadline.cleanup();
    composed.cleanup();
  }
};

/**
 * Decoded byte count of a base64 string, exactly.
 *
 * The naive `length * 3 / 4` counts the `=` padding as data and overestimates by
 * up to two bytes, which rejects a payload of EXACTLY the limit whenever the
 * limit is not a multiple of three (10 MiB is `1 mod 3`).
 */
const decodedBase64Size = (base64: string): number => {
  const clean = base64.replaceAll(/\s/g, '');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.floor(((clean.length - padding) * 3) / 4);
};

/** data: URIs are decoded locally; http(s) URLs go through the SSRF-safe fetch. */
const readReference = async (url: string, phase: PhaseOptions): Promise<ReferenceBytes> => {
  const { base64, mimeType, type } = parseDataUri(url);
  if (type === 'base64' && base64) {
    // measure the encoded length so an oversized payload is rejected BEFORE it
    // is expanded into a second copy in memory
    const estimated = decodedBase64Size(base64);
    if (estimated > MAX_REFERENCE_BYTES)
      throw new Error(`a reference image exceeds the ${MAX_REFERENCE_BYTES} byte limit`);

    const bytes = base64ToBytes(base64);
    if (bytes.length > MAX_REFERENCE_BYTES)
      throw new Error(`a reference image exceeds the ${MAX_REFERENCE_BYTES} byte limit`);
    return { bytes, mimeType: mimeType ?? undefined };
  }

  if (type === 'url') return fetchReference(url, phase);

  throw new Error('reference image is neither a data URI nor an absolute URL');
};

export const uploadReferences = async (
  client: ChatGPTWebClient,
  urls: string[],
  phase: PhaseOptions,
): Promise<AttachmentRef[]> => {
  const attachments: AttachmentRef[] = [];

  for (const [index, url] of urls.entries()) {
    const { bytes, mimeType } = await readReference(url, phase);
    // the probed type wins: chatgpt.com validates the declared type against the
    // bytes it receives, and callers routinely mislabel jpegs as png
    const probed = readImageDimensions(bytes);
    const resolvedMime = probed?.mimeType ?? mimeType ?? 'image/png';
    const extension = MIME_EXTENSIONS[resolvedMime] ?? 'png';

    const uploaded = await client.uploadFile(
      bytes,
      {
        height: probed?.height,
        kind: 'image',
        mimeType: resolvedMime,
        name: `image_${index + 1}.${extension}`,
        width: probed?.width,
      },
      { signal: phase.signal },
    );

    attachments.push({
      height: uploaded.height,
      id: uploaded.fileId,
      kind: 'image',
      libraryFileId: uploaded.libraryFileId,
      mimeType: uploaded.mimeType,
      name: uploaded.name,
      size: uploaded.size,
      width: uploaded.width,
    });
  }

  return attachments;
};
