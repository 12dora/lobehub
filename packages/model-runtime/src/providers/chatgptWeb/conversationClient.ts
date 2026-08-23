import createDebug from 'debug';

import { abortableSleep } from './boundedBody';
import type { ResumeConversationOptions, StreamConversationOptions } from './clientTypes';
import { CHATGPT_BASE_URL, PATHS, TEMPLATED_ROUTES, TIMEOUTS } from './constants';
import { callerAbortReason, ChatGPTWebError, describeResponseShape } from './errors';
import {
  buildSentinelHeaders,
  buildTurnRequestHeaders,
  createTurnRequestIdentity,
  type TurnRequestIdentity,
} from './headers';
import type { ManagedResponse } from './http';
import { composeSignals, timeoutSignal } from './http';
import type { LegRequest, LegState } from './resumeLeg';
import { buildResumeLeg, isRetryableLegError, RESUME_BACKOFF_MS } from './resumeLeg';
import { ChatGPTWebSentinelClient } from './sentinelClient';
import { ConversationEventRouter } from './sse/events';
import { iterSsePayloads } from './sse/reader';
import { getDurationMs, timing } from './timing';
import type { ChatRequirements, ConversationDocument, ConversationEvent } from './types';

const log = createDebug('lobe-chatgptweb:client');

/** Chained `/f/conversation/resume` legs allowed for a single turn. */
const MAX_CHAINED_RESUMES = 3;

/** Event types that mean the leg actually produced something for the consumer. */
const OUTPUT_EVENT_TYPES = new Set<ConversationEvent['type']>([
  'text.delta',
  'reasoning.delta',
  'reasoning.done',
  'citations',
  'image.pointer',
  'file.pointer',
  'moderation',
  'error',
]);

export class ChatGPTWebConversationClient extends ChatGPTWebSentinelClient {
  // ------------------------------------------------------------- conversation

  async prepareConversation(
    body: object,
    {
      signal,
      turnIdentity = createTurnRequestIdentity(),
    }: {
      requirements?: ChatRequirements;
      signal?: AbortSignal;
      turnIdentity?: TurnRequestIdentity;
    } = {},
  ): Promise<{ conduitToken?: string }> {
    const startedAt = Date.now();
    const raw = await this.requestJson<Record<string, any>>({
      body: JSON.stringify(body),
      context: 'conversation_prepare',
      // Real Chrome prepare calls carry the turn lifecycle headers, but none of
      // the Sentinel proofs; those belong on the subsequent SSE send.
      headers: {
        'Accept': '*/*',
        'Content-Type': 'application/json',
        ...buildTurnRequestHeaders(turnIdentity, 'prepare'),
      },
      method: 'POST',
      path: PATHS.fConversationPrepare,
      signal,
    });
    timing('prepare durationMs=%d', getDurationMs(startedAt));

    // `{status:"ok", conduit_token:null}` is a NORMAL prepare response, not a
    // failure — verified live 2026-08-19 against a captured real Chrome session:
    // the browser gets the exact same null token for a Pro-tier turn and simply
    // proceeds to `/backend-api/f/conversation` with no `X-Conduit-Token` header
    // at all (buildRequestHeaders already omits it when falsy). The previous
    // behavior — throwing here and letting the caller fall back to the legacy
    // `/backend-api/conversation` endpoint — is what silently substituted a mini
    // answer for a Pro turn the legacy endpoint structurally cannot serve. A
    // missing token is therefore no longer fatal; only genuinely broken
    // responses (network/timeout/malformed JSON, handled elsewhere in
    // `requestJson`) still throw.
    const conduitToken = typeof raw?.conduit_token === 'string' ? raw.conduit_token.trim() : '';
    if (!conduitToken) {
      log(
        'conversation_prepare returned no conduit token; response shape: %s',
        describeResponseShape(raw),
      );
      return {};
    }

    return { conduitToken };
  }

  /**
   * Stream one turn, transparently following the upstream's **handoff**.
   *
   * A turn the backend decides to run in the background (thinking / pro / any
   * explicit `thinking_effort`) answers the conversation call with nothing but a
   * `resume_conversation_token`, a `stream_handoff` and `[DONE]` — the real
   * answer is then streamed by `POST /backend-api/f/conversation/resume`
   * (verified live 2026-08-15). We follow that continuation here so consumers
   * see one uninterrupted event stream instead of an empty turn.
   *
   * The resume leg replays the turn from the start; the SAME event router is fed
   * across legs so the replay is diffed against what we already emitted and only
   * genuinely new text/reasoning reaches the consumer.
   */
  async *streamConversation(
    body: object,
    {
      autoResume = true,
      conduitToken,
      echoHistory,
      hardCapMs = TIMEOUTS.streamHardCap,
      idleTimeoutMs = TIMEOUTS.streamIdle,
      maxResumes = MAX_CHAINED_RESUMES,
      onHeaders,
      requirements,
      signal,
      turnIdentity,
      useFPath,
    }: StreamConversationOptions,
  ): AsyncGenerator<ConversationEvent, void, undefined> {
    const deadline = timeoutSignal(hardCapMs);
    const composed = composeSignals([signal, deadline.signal]);
    const legOptions = {
      deadlineSignal: deadline.signal,
      idleTimeoutMs,
      signal: composed.signal,
    };
    // one router for the whole turn: it dedupes what a resume leg replays
    const router = new ConversationEventRouter({ echoHistory });

    let request: LegRequest = {
      body: JSON.stringify(body),
      context: 'conversation',
      headers: buildSentinelHeaders({
        accept: 'text/event-stream',
        conduitToken,
        requirements,
        turnIdentity,
        variant: useFPath ? 'conduit' : 'conversation',
      }),
      path: useFPath ? PATHS.fConversation : PATHS.conversation,
    };

    try {
      let conversationId: string | undefined;
      let firstTextLogged = false;

      for (let resumes = 0; ; resumes += 1) {
        const state: LegState = { sawOutput: false };
        let done: Extract<ConversationEvent, { type: 'done' }> | undefined;
        let managed: ManagedResponse | undefined;

        try {
          const openStartedAt = Date.now();
          managed = await this.openLeg(request, composed.signal);
          if (resumes === 0) onHeaders?.();
          for await (const event of this.readLeg(
            managed,
            router,
            { ...legOptions, openStartedAt },
            state,
          )) {
            // both are turn bookkeeping, not output the consumer should see
            if (event.type === 'handoff') continue;
            if (event.type === 'done') {
              done = event;
              continue;
            }
            if (!firstTextLogged && event.type === 'text.delta') {
              firstTextLogged = true;
              timing('first text.delta durationMs=%d', getDurationMs(openStartedAt));
            }
            yield event;
          }
        } catch (error) {
          // A failed RESUME is recoverable: the answer is still being written
          // upstream, so end the turn and let the caller fall back to reading
          // the conversation document. A failed FIRST leg is not.
          //
          // `recoveryRequired` is the difference between "recoverable" and
          // "clean": a leg that already emitted some text would otherwise look
          // like a finished (but silently truncated) answer to the consumer.
          if (resumes === 0 || callerAbortReason(composed.signal) !== undefined) throw error;
          log('resume leg failed (%s); falling back to document recovery', String(error));
          yield { conversationId, endTurn: false, recoveryRequired: true, type: 'done' };
          return;
        } finally {
          managed?.release();
        }

        conversationId = state.conversationId ?? conversationId;
        const resumeToken = state.handoff?.resumeToken ?? state.resumeToken;
        const resumeId = state.handoff?.conversationId ?? conversationId;
        // A finished turn keeps advertising its handoff options — resuming it
        // again only replays what we already streamed.
        const handedOff = done?.endTurn !== true && (!!state.handoff || !state.sawOutput);

        if (!autoResume || !handedOff || !resumeToken || !resumeId || resumes >= maxResumes) {
          const final = done ?? { conversationId, endTurn: false, type: 'done' as const };
          // still handed off with nowhere left to go (no token, resume budget
          // spent, following disabled): the answer lives in the document only
          yield handedOff ? { ...final, recoveryRequired: true } : final;
          return;
        }

        log('turn handed off; resuming %s (leg %d)', resumeId, resumes + 2);
        request = buildResumeLeg({ conversationId: resumeId, resumeToken });
      }
    } finally {
      deadline.cleanup();
      composed.cleanup();
    }
  }

  /**
   * `POST /backend-api/f/conversation/resume` — pick a handed-off turn back up.
   * Same JSON-patch protocol as the conversation call; the reply replays the
   * turn from `offset` (the router's visibility gates drop the replayed
   * system/user messages).
   */
  async *resumeConversation({
    conversationId,
    echoHistory,
    hardCapMs = TIMEOUTS.streamHardCap,
    idleTimeoutMs = TIMEOUTS.streamIdle,
    offset = 0,
    resumeToken,
    signal,
  }: ResumeConversationOptions): AsyncGenerator<ConversationEvent, void, undefined> {
    const deadline = timeoutSignal(hardCapMs);
    const composed = composeSignals([signal, deadline.signal]);
    let managed: ManagedResponse | undefined;

    try {
      managed = await this.openLeg(
        buildResumeLeg({ conversationId, offset, resumeToken }),
        composed.signal,
      );
      yield* this.readLeg(
        managed,
        new ConversationEventRouter({ echoHistory }),
        { deadlineSignal: deadline.signal, idleTimeoutMs, signal: composed.signal },
        { sawOutput: false },
      );
    } finally {
      managed?.release();
      deadline.cleanup();
      composed.cleanup();
    }
  }

  /**
   * Open one SSE leg. Resume legs are retried on a network hiccup / 5xx: the
   * turn is already running upstream and losing the continuation would strand a
   * finished answer.
   */
  private async openLeg(
    request: LegRequest,
    signal: AbortSignal | undefined,
  ): Promise<ManagedResponse> {
    const retries = request.retries ?? 0;
    const startedAt = Date.now();

    for (let attempt = 0; ; attempt += 1) {
      try {
        const managed = await this.request({
          accept: 'text/event-stream',
          body: request.body,
          context: request.context,
          headers: request.headers,
          method: 'POST',
          path: request.path,
          signal,
          // the stream is bounded by hardCapMs / idleTimeoutMs instead
          timeoutMs: 0,
        });
        timing('openLeg headers durationMs=%d path=%s', getDurationMs(startedAt), request.path);
        return managed;
      } catch (error) {
        // covers the caller's stop AND our own hard cap (composed signal)
        const abortReason = callerAbortReason(signal);
        if (abortReason !== undefined) throw abortReason;
        if (attempt >= retries || !isRetryableLegError(error)) throw error;
        log('%s failed (%s), retrying', request.context, String(error));
        await abortableSleep(
          RESUME_BACKOFF_MS[Math.min(attempt, RESUME_BACKOFF_MS.length - 1)],
          signal,
        );
      }
    }
  }

  /** Feed one leg's SSE payloads through the (turn-scoped) event router. */
  private async *readLeg(
    managed: ManagedResponse,
    router: ConversationEventRouter,
    {
      deadlineSignal,
      idleTimeoutMs,
      openStartedAt,
      signal,
    }: {
      deadlineSignal?: AbortSignal;
      idleTimeoutMs?: number;
      openStartedAt?: number;
      signal?: AbortSignal;
    },
    state: LegState,
  ): AsyncGenerator<ConversationEvent, void, undefined> {
    if (!managed.response.body)
      throw new ChatGPTWebError('upstream', 'conversation response carried no body');

    try {
      // `iterSsePayloads` THROWS on abort / hard cap / idle, so a truncated turn
      // can never surface as a `done` event here.
      let firstByteLogged = false;
      for await (const payload of iterSsePayloads(managed.response.body, {
        deadlineSignal,
        idleTimeoutMs,
        signal,
      })) {
        if (!firstByteLogged) {
          firstByteLogged = true;
          if (openStartedAt !== undefined)
            timing('openLeg first-byte durationMs=%d', getDurationMs(openStartedAt));
        }
        for (const event of router.feed(payload)) {
          if (event.type === 'handoff') state.handoff = event;
          if (event.type === 'conversation.start') state.conversationId = event.conversationId;
          if (OUTPUT_EVENT_TYPES.has(event.type)) state.sawOutput = true;
          yield event;
          if (event.type === 'done') return;
        }
      }
    } finally {
      state.conversationId ??= router.currentConversationId;
      state.resumeToken ??= router.resumeToken;
    }
  }

  /**
   * @param accept the image path reads this document as JSON; the search path in
   *   the reference client sends `*\/*`. Defaults to JSON.
   */
  async getConversation(
    id: string,
    signalOrOptions?: AbortSignal | { accept?: string; signal?: AbortSignal },
  ): Promise<ConversationDocument> {
    const options =
      signalOrOptions && 'aborted' in signalOrOptions
        ? { signal: signalOrOptions }
        : (signalOrOptions ?? {});

    return this.requestJson<ConversationDocument>({
      accept: options.accept ?? 'application/json',
      context: 'conversation_document',
      headers: { Referer: `${CHATGPT_BASE_URL}/c/${id}` },
      path: `${PATHS.conversation}/${id}`,
      // the web client sends the un-interpolated template here
      route: TEMPLATED_ROUTES.conversation,
      signal: options.signal,
    });
  }

  /** Soft-hide a conversation (`is_visible: false`). Best effort, never throws. */
  async hideConversation(id: string, signal?: AbortSignal): Promise<void> {
    try {
      const managed = await this.request({
        accept: '*/*',
        body: JSON.stringify({ is_visible: false }),
        context: 'conversation_hide',
        headers: {
          'Content-Type': 'application/json',
          'Referer': `${CHATGPT_BASE_URL}/c/${id}`,
        },
        method: 'PATCH',
        path: `${PATHS.conversation}/${id}`,
        route: TEMPLATED_ROUTES.conversation,
        signal,
        timeoutMs: 15_000,
      });
      managed.release();
    } catch (error) {
      log('hideConversation failed for %s: %s', id, String(error));
    }
  }

  async listTasks(conversationId: string, signal?: AbortSignal): Promise<unknown[]> {
    const raw = await this.requestJson<{ tasks?: any[] }>({
      context: 'tasks',
      path: PATHS.tasks,
      signal,
      timeoutMs: 15_000,
    });
    const tasks = Array.isArray(raw?.tasks) ? raw.tasks : [];
    // the endpoint takes no filters — filter client side
    return tasks.filter(
      (task) =>
        task?.conversation_id === conversationId ||
        task?.original_conversation_id === conversationId,
    );
  }

  // -------------------------------------------------------------------- files
}
