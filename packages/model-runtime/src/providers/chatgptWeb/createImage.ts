import createDebug from 'debug';

import { AgentRuntimeErrorType } from '../../types/error';
import type {
  CreateImageMethodOptions,
  CreateImagePayload,
  CreateImageResponse,
} from '../../types/image';
import { bytesToBase64 } from './binary';
import type { ChatGPTWebClient } from './client';
import {
  errorLabel,
  fail,
  IMAGE_OVERALL_BUDGET_MS,
  isCreateImageErrorPayload,
  publicMessage,
  timeoutFailure,
} from './createImage.errors';
import type { PhaseOptions } from './createImage.references';
import { boundedTimeout, uploadReferences } from './createImage.references';
import { ChatGPTWebError, isChatGPTWebError, toAgentRuntimeErrorType } from './errors';
import { createTurnRequestIdentity, type TurnRequestIdentity } from './headers';
import { composeSignals, timeoutSignal } from './http';
import { pollImageResults } from './imagePoll';
import type { ImagePointer } from './imageResolve';
import { mergePointers, resolveImages } from './imageResolve';
import { buildImageConversationBodies } from './requestBuilders';
import type { ChatRequirements } from './types';

const log = createDebug('lobe-chatgptweb:image');

/** The only image model id this runtime serves. */
export const IMAGE_MODEL_ID = 'gpt-image-2';

/**
 * Upstream slug the `picture_v2` turn actually runs on — `gpt-image-2` is a
 * public alias that chatgpt.com never sees.
 */
export const IMAGE_UPSTREAM_MODEL = 'gpt-5-5';

export const MAX_REFERENCE_IMAGES = 4;

export { IMAGE_OVERALL_BUDGET_MS };
export { MAX_REFERENCE_BYTES } from './createImage.references';

/** SSE-only cap; intentionally a separate budget from the poll (E3 §6, smell 1). */
export const IMAGE_SSE_HARD_CAP_MS = 120_000;

/** Hiding the conversation is cosmetic: a small cap, clamped by what is left. */
const HIDE_TIMEOUT_MS = 5000;

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
    turnIdentity: TurnRequestIdentity;
  },
): Promise<StreamOutcome> => {
  const outcome: StreamOutcome = { blocked: false, pointers: [], text: '' };

  try {
    for await (const event of client.streamConversation(body, {
      conduitToken: options.conduitToken,
      hardCapMs: options.hardCapMs,
      requirements: options.requirements,
      signal: options.signal,
      turnIdentity: options.turnIdentity,
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
    const turnIdentity = createTurnRequestIdentity();
    const bodies = buildImageConversationBodies({
      browserProfile: client.browserProfile,
      model: IMAGE_UPSTREAM_MODEL,
      prompt,
      references,
    });

    ensureBudget('handshake');
    const { conduitToken } = await client.prepareConversation(bodies.prepare, {
      requirements,
      signal: budget.signal,
      turnIdentity,
    });

    ensureBudget('generation');
    const stream = await runConversation(client, bodies.conversation, {
      conduitToken,
      hardCapMs: boundedTimeout(IMAGE_SSE_HARD_CAP_MS, remaining),
      requirements,
      signal: budget.signal,
      turnIdentity,
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
