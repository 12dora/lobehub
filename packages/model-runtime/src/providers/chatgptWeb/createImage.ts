import { ssrfSafeFetch } from '@lobechat/ssrf-safe-fetch';
import createDebug from 'debug';

import { AgentRuntimeErrorType } from '../../types/error';
import type {
  CreateImageMethodOptions,
  CreateImagePayload,
  CreateImageResponse,
} from '../../types/image';
import type { CreateImageErrorPayload } from '../../types/type';
import { AgentRuntimeError } from '../../utils/createError';
import { parseDataUri } from '../../utils/uriParser';
import { base64ToBytes, bytesToBase64 } from './binary';
import type { ChatGPTWebClient } from './client';
import { readBoundedBody } from './client';
import { ChatGPTWebError, isChatGPTWebError, toAgentRuntimeErrorType } from './errors';
import { composeSignals, timeoutSignal } from './http';
import { readImageDimensions } from './imageDimensions';
import { pollImageResults } from './imagePoll';
import type { ImagePointer } from './imageResolve';
import { mergePointers, resolveImages } from './imageResolve';
import { buildImageConversationBodies } from './requestBuilders';
import type { AttachmentRef, ChatRequirements } from './types';

const log = createDebug('lobe-chatgptweb:image');

/** The only image model id this runtime serves. */
export const IMAGE_MODEL_ID = 'gpt-image-2';

/**
 * Upstream slug the `picture_v2` turn actually runs on — `gpt-image-2` is a
 * public alias that chatgpt.com never sees.
 */
export const IMAGE_UPSTREAM_MODEL = 'gpt-5-5';

export const MAX_REFERENCE_IMAGES = 4;

/**
 * Decoded ceiling for one reference image, mirroring the model card's
 * `maxFileSize`. The card only constrains the UI — an API caller can post
 * anything, so the runtime enforces it again.
 */
export const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;

/**
 * Whole-call budget. The async image task is killed at 298s
 * (`ASYNC_TASK_TIMEOUT`) and the caller still has to download, probe and upload
 * the result afterwards, so we stop well before that.
 *
 * It is enforced by ONE `AbortController` armed at entry whose signal is
 * threaded through every phase — a per-phase timeout alone would let four
 * uploads plus a stream plus a poll add up to several minutes.
 */
export const IMAGE_OVERALL_BUDGET_MS = 200_000;

/** SSE-only cap; intentionally a separate budget from the poll (E3 §6, smell 1). */
export const IMAGE_SSE_HARD_CAP_MS = 120_000;

/** Per-reference network cap; still bounded by whatever the budget has left. */
const REFERENCE_FETCH_TIMEOUT_MS = 30_000;

/** Hiding the conversation is cosmetic: a small cap, clamped by what is left. */
const HIDE_TIMEOUT_MS = 5000;

const MIME_EXTENSIONS: Record<string, string> = {
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** Upstream strings that must never reach an end user (E3 §6). */
const LEAKY_MARKERS = [
  'backend-api/',
  'status=',
  'body=',
  'chatgpt.com',
  // the reference client's own error class name; it stringifies path + body
  'upstreamhttperror',
];

const GENERIC_FAILURE = 'The image generation request failed. Please try again later.';

const publicMessage = (message: string | undefined, fallback = GENERIC_FAILURE): string => {
  const text = (message ?? '').trim();
  if (!text) return fallback;
  const lowered = text.toLowerCase();
  return LEAKY_MARKERS.some((marker) => lowered.includes(marker)) ? fallback : text;
};

const isCreateImageErrorPayload = (value: unknown): value is CreateImageErrorPayload =>
  typeof value === 'object' &&
  value !== null &&
  'errorType' in value &&
  'provider' in value &&
  !(value instanceof Error);

const fail = (
  provider: string,
  errorType: CreateImageErrorPayload['errorType'],
  message: string,
): CreateImageErrorPayload =>
  AgentRuntimeError.createImage({ error: { message }, errorType, provider });

/**
 * Timeout-shaped failure payload.
 *
 * `apps/server/src/routers/async/imageError.ts` only reaches its `TaskTimeout`
 * branch through `error.message?.includes('timeout')` on the TOP-LEVEL payload,
 * and only after every `errorType` branch has missed. So the payload must
 * (a) carry an `errorType` none of those branches claims — `ProviderNetworkError`,
 * which is also what `errors.ts` maps a `timeout` kind to — and (b) spell the
 * literal word "timeout" in `message` (`"timed out"` would NOT match).
 */
const timeoutFailure = (provider: string, phase: string): CreateImageErrorPayload =>
  ({
    error: {
      message: `ChatGPT Web did not finish the image ${phase} within the ${Math.round(
        IMAGE_OVERALL_BUDGET_MS / 1000,
      )}s timeout.`,
    },
    errorType: AgentRuntimeErrorType.ProviderNetworkError,
    message: `ChatGPT Web image ${phase} hit the request timeout.`,
    provider,
  }) as CreateImageErrorPayload;

/** Host only — a presigned reference URL carries its credential in the query. */
const safeHost = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown-host';
  }
};

/** Error identity without its message: node-fetch bakes the full URL into it. */
const errorLabel = (error: unknown): string => {
  if (isChatGPTWebError(error)) return `ChatGPTWebError(${error.kind})`;
  return error instanceof Error ? error.name : typeof error;
};

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

interface PhaseOptions {
  /** Milliseconds left in the whole-call budget. */
  remaining: () => number;
  signal: AbortSignal;
}

/** Milliseconds this request may take: its own cap, clamped by the budget. */
const boundedTimeout = (preferred: number, remaining: () => number): number =>
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

const uploadReferences = async (
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

/**
 * The requirements handshake is the request Cloudflare challenges most often,
 * and a fresh PoW usually clears it. One retry, no loop.
 */
const getRequirementsWithRetry = async (
  client: ChatGPTWebClient,
  signal?: AbortSignal,
): Promise<ChatRequirements> => {
  try {
    return await client.getChatRequirements({ signal });
  } catch (error) {
    if (!isChatGPTWebError(error) || error.kind !== 'cloudflare') throw error;
    log('requirements handshake was challenged, retrying once');
    return client.getChatRequirements({ signal });
  }
};

interface StreamOutcome {
  blocked: boolean;
  conversationId?: string;
  pointers: ImagePointer[];
  text: string;
  toolInvoked?: boolean;
  turnUseCase?: string;
}

/** `turn_use_case` values that mark the turn as an asynchronous image task. */
const isImageUseCase = (useCase: string | undefined): boolean => {
  if (!useCase) return false;
  const lowered = useCase.toLowerCase();
  return lowered === 'image gen' || lowered === 'image_gen' || lowered.includes('image');
};

const runConversation = async (
  client: ChatGPTWebClient,
  body: object,
  options: {
    conduitToken?: string;
    hardCapMs: number;
    requirements: ChatRequirements;
    signal?: AbortSignal;
  },
): Promise<StreamOutcome> => {
  const outcome: StreamOutcome = { blocked: false, pointers: [], text: '' };

  try {
    for await (const event of client.streamConversation(body, {
      conduitToken: options.conduitToken,
      hardCapMs: options.hardCapMs,
      requirements: options.requirements,
      signal: options.signal,
      useFPath: true,
    })) {
      // deltas are far too chatty to trace; everything else is one line a turn
      if (event.type !== 'text.delta' && event.type !== 'reasoning.delta')
        log('event %s', event.type);

      switch (event.type) {
        case 'conversation.start': {
          outcome.conversationId = event.conversationId;
          break;
        }
        case 'image.pointer': {
          outcome.pointers = mergePointers(outcome.pointers, [
            { fileId: event.fileId, kind: event.pointerKind },
          ]);
          break;
        }
        case 'metadata': {
          if (event.toolInvoked !== undefined) outcome.toolInvoked = event.toolInvoked;
          if (event.turnUseCase) outcome.turnUseCase = event.turnUseCase;
          break;
        }
        case 'moderation': {
          if (event.blocked) outcome.blocked = true;
          break;
        }
        case 'text.delta': {
          outcome.text = event.text;
          break;
        }
        case 'done': {
          outcome.conversationId ??= event.conversationId;
          break;
        }
        default: {
          break;
        }
      }
    }
  } catch (error) {
    // A capped/idle stream is not fatal: the turn keeps running upstream and the
    // conversation document will carry the result.
    const recoverable = isChatGPTWebError(error) && error.kind === 'timeout';
    if (!recoverable || !outcome.conversationId) throw error;
    log('stream ended early (%s); falling back to polling', error.kind);
  }

  return outcome;
};

/** Best effort, bounded, and never allowed to fail a successful generation. */
const hideConversation = async (
  client: ChatGPTWebClient,
  conversationId: string,
  { remaining, signal }: PhaseOptions,
) => {
  const left = remaining();
  // Cosmetic cleanup must never push an already-successful call past the budget
  // it advertises: with nothing left, drop it entirely.
  if (left <= 0) {
    log('skipping the cleanup of conversation %s: the call budget is spent', conversationId);
    return;
  }

  const deadline = timeoutSignal(Math.min(HIDE_TIMEOUT_MS, left));
  const composed = composeSignals([signal, deadline.signal]);
  try {
    await client.hideConversation(conversationId, composed.signal);
  } catch (error) {
    log('failed to hide conversation %s: %s', conversationId, errorLabel(error));
  } finally {
    deadline.cleanup();
    composed.cleanup();
  }
};

export interface ChatGPTWebImageContext {
  client: ChatGPTWebClient;
  options?: CreateImageMethodOptions;
  provider: string;
}

/**
 * `picture_v2` image generation / editing over the chatgpt.com web protocol.
 *
 * One call = one conversation = one image. Reference images make it an edit.
 * The result comes back as a `data:` URL because the signed upstream URLs are
 * short-lived and the server re-fetches provider URLs without our credentials.
 */
export async function createChatGPTWebImage(
  payload: CreateImagePayload,
  ctx: ChatGPTWebImageContext,
): Promise<CreateImageResponse> {
  const { client, provider } = ctx;

  if (payload.model !== IMAGE_MODEL_ID)
    throw fail(
      provider,
      AgentRuntimeErrorType.ModelNotFound,
      `ChatGPT Web only supports the "${IMAGE_MODEL_ID}" image model, received "${payload.model}".`,
    );

  const prompt = String(payload.params.prompt ?? '').trim();
  if (!prompt)
    throw fail(provider, AgentRuntimeErrorType.ProviderBizError, 'An image prompt is required.');

  // an EMPTY `imageUrls` must not suppress the legacy single `imageUrl`: model
  // defaults commonly ship `imageUrls: []`, which would silently turn an edit
  // into a fresh generation
  const { imageUrl, imageUrls } = payload.params;
  const referenceUrls = (imageUrls?.length ? imageUrls : imageUrl ? [imageUrl] : []).slice(
    0,
    MAX_REFERENCE_IMAGES,
  );
  const isEdit = referenceUrls.length > 0;

  const deadline = Date.now() + IMAGE_OVERALL_BUDGET_MS;
  const remaining = () => deadline - Date.now();

  // ONE controller for the whole call. Every phase below receives its signal, so
  // a stalled upload/handshake/download is cut off instead of adding its own
  // timeout on top of the ones that already ran.
  const budget = new AbortController();
  const budgetTimer = setTimeout(
    () =>
      budget.abort(
        new ChatGPTWebError(
          'timeout',
          `image generation exceeded its ${IMAGE_OVERALL_BUDGET_MS}ms`,
        ),
      ),
    IMAGE_OVERALL_BUDGET_MS,
  );
  const phase: PhaseOptions = { remaining, signal: budget.signal };

  /** Never start a phase we already know cannot finish. */
  const ensureBudget = (name: string) => {
    if (remaining() <= 0) throw timeoutFailure(provider, name);
  };

  try {
    ensureBudget('reference upload');
    const references = await uploadReferences(client, referenceUrls, phase);

    ensureBudget('handshake');
    const requirements = await getRequirementsWithRetry(client, budget.signal);
    const bodies = buildImageConversationBodies({
      model: IMAGE_UPSTREAM_MODEL,
      prompt,
      references,
    });

    ensureBudget('handshake');
    const { conduitToken } = await client.prepareConversation(bodies.prepare, {
      requirements,
      signal: budget.signal,
    });

    ensureBudget('generation');
    const stream = await runConversation(client, bodies.conversation, {
      conduitToken,
      hardCapMs: boundedTimeout(IMAGE_SSE_HARD_CAP_MS, remaining),
      requirements,
      signal: budget.signal,
    });

    let pointers = stream.pointers;
    let taskErrorMessage: string | undefined;
    let timedOut = false;

    /** The turn declared itself an asynchronous image task. */
    const imageTurn = stream.toolInvoked === true || isImageUseCase(stream.turnUseCase);

    // A plain text answer to a generation prompt is final: `tool_invoked: false`
    // with a non-image `turn_use_case` means no asynchronous image task exists,
    // so polling for one would burn the whole budget to learn nothing. Edits,
    // confirmed image turns and turns whose metadata never arrived still poll.
    const textOnly =
      !isEdit &&
      pointers.length === 0 &&
      !stream.blocked &&
      stream.toolInvoked === false &&
      !imageTurn;

    if (textOnly)
      throw fail(
        provider,
        AgentRuntimeErrorType.ProviderNoImageGenerated,
        publicMessage(stream.text, 'ChatGPT Web answered with text instead of an image.'),
      );

    // Even when the stream already handed us pointers we take one look at the
    // conversation document: the settle policy waits ~2s and merges anything the
    // stream missed, then returns on the first hit. Without a conversation id
    // there is nothing to poll and the stream pointers are all we have.
    if (stream.conversationId) {
      ensureBudget('generation');
      const polled = await pollImageResults({
        client,
        conversationId: stream.conversationId,
        deadline,
        initialPointers: pointers,
        signal: budget.signal,
      });
      pointers = polled.pointers;
      taskErrorMessage = polled.taskErrorMessage;
      timedOut = polled.timedOut;
    }

    if (pointers.length === 0) {
      if (taskErrorMessage || stream.blocked)
        throw fail(
          provider,
          AgentRuntimeErrorType.ProviderContentPolicyViolation,
          publicMessage(
            taskErrorMessage || stream.text,
            'The image request was rejected by the upstream content policy.',
          ),
        );

      // Ran out of budget with nothing to show. That is a timeout — UNLESS the
      // assistant already answered in prose and never confirmed an image task,
      // in which case the text is the real (and more useful) explanation.
      if (timedOut && (imageTurn || !stream.text.trim()))
        throw timeoutFailure(provider, 'generation');

      throw fail(
        provider,
        AgentRuntimeErrorType.ProviderNoImageGenerated,
        publicMessage(stream.text, 'ChatGPT Web finished the turn without producing an image.'),
      );
    }

    ensureBudget('download');
    const images = await resolveImages({
      client,
      conversationId: stream.conversationId,
      deadline,
      pointers,
      signal: budget.signal,
    });

    const image = images[0];
    if (!image)
      throw fail(
        provider,
        AgentRuntimeErrorType.ProviderNoImageGenerated,
        publicMessage(stream.text, 'The generated image could not be downloaded.'),
      );

    if (stream.conversationId) await hideConversation(client, stream.conversationId, phase);

    return {
      height: image.height,
      imageUrl: `data:${image.mimeType};base64,${bytesToBase64(image.bytes)}`,
      width: image.width,
    };
  } catch (error) {
    if (isCreateImageErrorPayload(error)) throw error;

    // never `%O` a ChatGPTWebError: its `body` can carry signed upload metadata
    log('image generation failed: %s', errorLabel(error));
    if (isChatGPTWebError(error))
      log('failure detail kind=%s status=%s code=%s', error.kind, error.status, error.code);

    // our own budget firing surfaces as a timeout, not as a generic provider error
    if (isChatGPTWebError(error) && error.kind === 'timeout')
      throw timeoutFailure(provider, 'generation');

    const message = error instanceof Error ? error.message : String(error);

    // 401 here means the stored OAuth token is dead; the image pipeline surfaces
    // `InvalidProviderAPIKey` as "reconnect this provider", which is the action.
    const errorType =
      isChatGPTWebError(error) && error.kind === 'auth'
        ? AgentRuntimeErrorType.InvalidProviderAPIKey
        : toAgentRuntimeErrorType(error);

    throw fail(provider, errorType, publicMessage(message));
  } finally {
    clearTimeout(budgetTimer);
  }
}
