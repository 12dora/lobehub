import createDebug from 'debug';

import { citationsFromMessage, isAnswerMessage, isVisibleAssistantMessage } from '../citations';
import { ASSET_POINTER_PREFIXES } from '../constants';
import { extractSandboxFiles } from '../interpreterFiles';
import type { Citation, ConversationEvent } from '../types';
import { sanitizeAnnotations } from './annotations';
import { inspectBentoText } from './bento';
import {
  asRecord,
  isImageToolMessage,
  messagePartsText,
  messageText,
  pointerKind,
  reasoningText,
  stripHistory,
  toHandoffOptions,
} from './messageFields';
import { applyPatchEvent, createPatchState, type PatchState } from './patch';

export { stripHistory };

const log = createDebug('lobe-chatgptweb:events');

interface MessageState {
  citationCount: number;
  /** a divergent (non prefix-compatible) replay was already reported once */
  divergenceLogged: boolean;
  /** sandbox paths already reported as `file.pointer` for this message */
  emittedFiles: Set<string>;
  emittedPointers: Set<string>;
  endTurn?: boolean;
  /** the current snapshot is NOTHING but the history we replayed — an echo */
  historyOnly: boolean;
  ignored: boolean;
  /** the message is (or was) the user-visible answer of the turn */
  isAnswer: boolean;
  /** HIGH-WATER mark of the reasoning already surfaced — never shrinks */
  reasoning: string;
  reasoningDone: boolean;
  status?: string;
  /** HIGH-WATER mark of the sanitized text already surfaced — never shrinks */
  text: string;
}

export interface EventRouterOptions {
  /**
   * Assistant turns we replayed in the request body. The upstream echoes them
   * back as complete assistant messages before the real answer starts; skip
   * them instead of streaming the whole history to the user again.
   */
  echoHistory?: string[];
}

/**
 * Turns the raw SSE payload strings into the provider-agnostic
 * {@link ConversationEvent} union. Stateful — one instance per stream.
 */
export class ConversationEventRouter {
  private readonly echoHistory: string[];
  /** The concatenation the upstream echoes back — see {@link stripHistory}. */
  private readonly historyText: string;
  private readonly messages = new Map<string, MessageState>();
  private readonly patch: PatchState = createPatchState();
  private conversationId?: string;
  private endTurn = false;
  private historyIndex = 0;
  private resumeTokenValue?: string;
  private started = false;

  constructor({ echoHistory }: EventRouterOptions = {}) {
    this.echoHistory = echoHistory ?? [];
    this.historyText = this.echoHistory.join('');
  }

  get currentConversationId(): string | undefined {
    return this.conversationId;
  }

  /**
   * The `resume_conversation_token` JWT, when the upstream handed this turn off
   * to its background pipeline. It is the credential for
   * `POST /backend-api/f/conversation/resume`.
   */
  get resumeToken(): string | undefined {
    return this.resumeTokenValue;
  }

  feed(payload: string): ConversationEvent[] {
    if (!payload) return [];
    if (payload === '[DONE]') {
      // Generated files must be reported BEFORE `done`: the consumer resolves
      // them inside the stream, while the conversation is still readable.
      const events: ConversationEvent[] = [];
      for (const [messageId, state] of this.messages)
        this.emitSandboxFiles(messageId, state, events);
      events.push({ conversationId: this.conversationId, endTurn: this.endTurn, type: 'done' });
      return events;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return [{ payload, type: 'raw' }];
    }

    // "v1" and friends are protocol markers, not events.
    const event = asRecord(parsed);
    if (!event) return [];

    const events: ConversationEvent[] = [];
    this.captureConversationId(event, events);

    switch (event.type) {
      case 'moderation': {
        const blocked = asRecord(event.moderation_response)?.blocked === true;
        if (blocked) events.push({ blocked: true, type: 'moderation' });
        return events;
      }
      case 'server_ste_metadata': {
        const metadata = asRecord(event.metadata) ?? {};
        events.push({
          modelSlug: typeof metadata.model_slug === 'string' ? metadata.model_slug : undefined,
          toolInvoked:
            typeof metadata.tool_invoked === 'boolean' ? metadata.tool_invoked : undefined,
          turnUseCase:
            typeof metadata.turn_use_case === 'string' ? metadata.turn_use_case : undefined,
          type: 'metadata',
        });
        return events;
      }
      case 'resume_conversation_token': {
        // Not an output event — but the token is what lets us pick the turn back
        // up on `/f/conversation/resume` once the upstream hands it off.
        if (typeof event.token === 'string' && event.token) this.resumeTokenValue = event.token;
        return events;
      }
      case 'stream_handoff': {
        events.push({
          conversationId:
            typeof event.conversation_id === 'string' ? event.conversation_id : this.conversationId,
          options: toHandoffOptions(event.options),
          resumeToken: this.resumeTokenValue,
          turnExchangeId:
            typeof event.turn_exchange_id === 'string' ? event.turn_exchange_id : undefined,
          type: 'handoff',
        });
        return events;
      }
      case 'input_message':
      case 'message_marker':
      case 'title_generation': {
        // Internal bookkeeping only. `input_message` in particular carries the
        // user's uploaded attachment pointers, which are NOT generated output.
        return events;
      }
      default: {
        break;
      }
    }

    if (!applyPatchEvent(this.patch, event)) return events;

    const root = asRecord(this.patch.root);
    this.captureConversationId(root ?? {}, events);
    const message = asRecord(root?.message);
    if (!message) return events;

    this.deriveMessageEvents(message, events);
    return events;
  }

  private captureConversationId(source: Record<string, any>, events: ConversationEvent[]) {
    const candidate =
      (typeof source.conversation_id === 'string' && source.conversation_id) ||
      (typeof asRecord(source.v)?.conversation_id === 'string' &&
        (asRecord(source.v)!.conversation_id as string));
    if (!candidate || this.conversationId) return;
    this.conversationId = candidate;
    if (!this.started) {
      this.started = true;
      events.push({ conversationId: candidate, type: 'conversation.start' });
    }
  }

  private stateFor(id: string): MessageState {
    let state = this.messages.get(id);
    if (!state) {
      state = {
        citationCount: 0,
        divergenceLogged: false,
        emittedFiles: new Set<string>(),
        emittedPointers: new Set<string>(),
        historyOnly: false,
        ignored: false,
        isAnswer: false,
        reasoning: '',
        reasoningDone: false,
        text: '',
      };
      this.messages.set(id, state);
    }
    return state;
  }

  /**
   * Positive tool / hidden / non-answer signals. Thoughts, reasoning recaps and
   * image-gen tool messages must keep flowing (later patches carry more deltas
   * or asset pointers), so they are not latched. Internal `analysis` *text* is
   * latched: a later `channel=final` patch or same-id replay must not emit it.
   */
  private shouldLatchIgnored(message: Record<string, any>): boolean {
    if (isImageToolMessage(message)) return false;
    const contentType = String(asRecord(message.content)?.content_type ?? '');
    if (contentType === 'thoughts' || contentType === 'reasoning_recap') return false;
    if (contentType === 'code') return true;
    return !isVisibleAssistantMessage(message);
  }

  private deriveMessageEvents(message: Record<string, any>, events: ConversationEvent[]) {
    const messageId = typeof message.id === 'string' ? message.id : '__current__';
    const state = this.stateFor(messageId);
    if (state.ignored) return;

    const content = asRecord(message.content);
    const contentType = content?.content_type;

    if (isImageToolMessage(message)) this.emitPointers(message, messageId, state, events);

    if (contentType === 'system_error') {
      events.push({
        code: typeof content?.name === 'string' ? content.name : undefined,
        message: messageText(message) || 'upstream reported a system error',
        type: 'error',
      });
      return;
    }

    this.emitReasoningDelta(message, messageId, state, events);
    this.emitReasoningDone(message, messageId, state, events);

    // Once a snapshot is *definitively* not user-facing, latch so later patches
    // on this id cannot emit text. Missing recipient/channel is NOT a latch:
    // live streams omit them on ordinary answers.
    if (this.shouldLatchIgnored(message)) {
      state.ignored = true;
    } else if (isAnswerMessage(message)) {
      state.isAnswer = true;
      this.emitText(message, messageId, state, events);
      this.emitCitations(message, state, events);
    }

    this.emitStatus(message, messageId, state, events);

    const status = typeof message.status === 'string' ? message.status : undefined;
    const endTurn = typeof message.end_turn === 'boolean' ? message.end_turn : undefined;
    // A finished answer can be scanned for interpreter files: its text will not
    // grow any further, so a `sandbox:` link in it is complete.
    if (endTurn === true || (status !== undefined && status !== 'in_progress'))
      this.emitSandboxFiles(messageId, state, events);
  }

  private emitReasoningDelta(
    message: Record<string, any>,
    messageId: string,
    state: MessageState,
    events: ConversationEvent[],
  ) {
    if (asRecord(message.content)?.content_type !== 'thoughts') return;

    const { summary, text } = reasoningText(message);
    // Same additive high-water contract as the answer text — see `emitText`.
    if (text.length > state.reasoning.length && text.startsWith(state.reasoning)) {
      const delta = text.slice(state.reasoning.length);
      state.reasoning = text;
      events.push({ delta, messageId, summary, type: 'reasoning.delta' });
    } else if (text && !state.reasoning.startsWith(text)) {
      this.logDivergence(state, messageId, 'reasoning');
    }
  }

  private emitReasoningDone(
    message: Record<string, any>,
    messageId: string,
    state: MessageState,
    events: ConversationEvent[],
  ) {
    const content = asRecord(message.content);
    const contentType = content?.content_type;
    const metadata = asRecord(message.metadata) ?? {};

    if (contentType === 'reasoning_recap' && !state.reasoningDone) {
      state.reasoningDone = true;
      const recap = typeof content?.content === 'string' ? content.content : messageText(message);
      events.push({
        durationSec:
          typeof metadata.finished_duration_sec === 'number'
            ? metadata.finished_duration_sec
            : undefined,
        recap: recap || undefined,
        type: 'reasoning.done',
      });
    } else if (
      !state.reasoningDone &&
      contentType === 'thoughts' &&
      (metadata.reasoning_status === 'reasoning_ended' ||
        typeof metadata.finished_duration_sec === 'number')
    ) {
      state.reasoningDone = true;
      events.push({
        durationSec:
          typeof metadata.finished_duration_sec === 'number'
            ? metadata.finished_duration_sec
            : undefined,
        type: 'reasoning.done',
      });
    }
  }

  private emitStatus(
    message: Record<string, any>,
    messageId: string,
    state: MessageState,
    events: ConversationEvent[],
  ) {
    const status = typeof message.status === 'string' ? message.status : undefined;
    const endTurn = typeof message.end_turn === 'boolean' ? message.end_turn : undefined;
    // ONLY the current user-visible final answer may complete the turn. The
    // upstream also replays our own history (`end_turn: true` and all) and emits
    // `thoughts` / tool / system messages with their own status; promoting any of
    // those makes a handed-off turn look finished, so the resume leg that
    // actually carries the answer is never followed.
    if (endTurn === true && !state.ignored && !state.historyOnly && isAnswerMessage(message))
      this.endTurn = true;
    if (status !== state.status || endTurn !== state.endTurn) {
      state.status = status;
      state.endTurn = endTurn;
      if (status || endTurn !== undefined)
        events.push({ endTurn, messageId, status, type: 'message.status' });
    }
  }

  /**
   * Report the code-interpreter files an answer links to as `sandbox:` paths.
   *
   * Deduplicated per (message, path) for the whole turn, so a resume leg that
   * replays the same answer — or the `[DONE]` sweep after the message already
   * finished — never reports the same file twice.
   *
   * Only ever called when the text cannot grow any further within this leg (the
   * message reached a final status, or the leg hit `[DONE]`), so the supported
   * BARE form counts too — a bare mention is how the model reports a file it
   * did not link. The one shape a cut-off leg can fake, the tail of a markdown
   * link whose `)` never arrived, is rejected by {@link extractSandboxFiles}.
   */
  private emitSandboxFiles(messageId: string, state: MessageState, events: ConversationEvent[]) {
    if (!state.isAnswer || state.ignored || state.historyOnly || !state.text) return;

    for (const file of extractSandboxFiles(state.text)) {
      if (state.emittedFiles.has(file.path)) continue;
      state.emittedFiles.add(file.path);
      events.push({
        conversationId: this.conversationId,
        messageId,
        name: file.name,
        sandboxPath: file.path,
        type: 'file.pointer',
      });
    }
  }

  private emitText(
    message: Record<string, any>,
    messageId: string,
    state: MessageState,
    events: ConversationEvent[],
  ) {
    const contentType = asRecord(message.content)?.content_type;
    if (contentType && !['text', 'multimodal_text'].includes(String(contentType))) return;

    // Answer text lives in string `parts`. `content.text` is the `code` payload
    // and must never be treated as the user-facing answer (it can arrive before
    // `content_type: "code"` is patched in).
    const raw = messagePartsText(message);
    if (!raw) return;

    // `<replayed history><new text>` → `<new text>` (reference `strip_history`).
    const stripped = stripHistory(raw, this.historyText);
    // nothing left once the replay is removed ⇒ this snapshot is a pure echo of
    // a turn we sent, not an answer (so its `end_turn` means nothing either)
    state.historyOnly = !stripped && !!this.historyText;

    // A whole replayed turn coming back as its own message: skip it entirely.
    if (
      !state.text &&
      this.historyIndex < this.echoHistory.length &&
      stripped === this.echoHistory[this.historyIndex]
    ) {
      this.historyIndex += 1;
      state.ignored = true;
      return;
    }

    const finished =
      message.end_turn === true ||
      (typeof message.status === 'string' && message.status !== 'in_progress');

    // An echo that is still streaming in looks like a prefix of the history;
    // hold it back until it either completes (and strips to nothing) or
    // diverges, rather than replaying the old turn to the user one char at a
    // time.
    if (
      !finished &&
      !state.text &&
      stripped.length > 0 &&
      stripped.length < this.historyText.length &&
      this.historyText.startsWith(stripped)
    )
      return;

    // While the turn is still running, hold back the tail a later chunk could
    // still rewrite (an annotation marker and the whitespace before it), so the
    // deltas a consumer concatenates always equal `text`.
    const sanitized = sanitizeAnnotations(stripped, { streaming: !finished });

    // Image-search / bento tool calls stream `{"layout":"bento",…}` *before*
    // recipient/channel classify the message. Withhold while the candidate can
    // still be that object; drop a complete object (and the following blank
    // line) if prose follows in the same message.
    const bento = inspectBentoText(sanitized, { streaming: !finished });
    if (bento.withhold) {
      if (bento.ignored && finished) state.ignored = true;
      return;
    }
    const candidate = bento.text;

    // HIGH-WATER contract. A resume leg replays the turn from offset 0, so the
    // very same message id arrives again from `H`, `He`, … Emitting those would
    // duplicate the answer downstream, because the event contract is ADDITIVE
    // (the consumer concatenates every delta and can never take text back).
    //
    // So: withhold any snapshot that is a prefix of — or equal to — what we have
    // already surfaced, and emit only the suffix once it grows past the mark.
    // A snapshot that DIVERGES (upstream rewrote the answer) cannot be expressed
    // additively at all, so it is withheld too until it grows past the mark AND
    // extends it; the divergence is logged once.
    if (candidate.length <= state.text.length) {
      if (!state.text.startsWith(candidate)) this.logDivergence(state, messageId, 'text');
      return;
    }
    if (!candidate.startsWith(state.text)) {
      this.logDivergence(state, messageId, 'text');
      return;
    }

    const delta = candidate.slice(state.text.length);
    state.text = candidate;
    if (delta) events.push({ delta, messageId, text: candidate, type: 'text.delta' });
  }

  /** One line per message, whatever how many divergent snapshots follow. */
  private logDivergence(state: MessageState, messageId: string, channel: 'text' | 'reasoning') {
    if (state.divergenceLogged) return;
    state.divergenceLogged = true;
    log(
      'withholding a divergent %s replay for %s (the delta contract is additive)',
      channel,
      messageId,
    );
  }

  private emitCitations(
    message: Record<string, any>,
    state: MessageState,
    events: ConversationEvent[],
  ) {
    const citations: Citation[] = citationsFromMessage(message);
    if (citations.length === 0 || citations.length === state.citationCount) return;
    state.citationCount = citations.length;
    events.push({ citations, type: 'citations' });
  }

  private emitPointers(
    message: Record<string, any>,
    messageId: string,
    state: MessageState,
    events: ConversationEvent[],
  ) {
    const parts = Array.isArray(asRecord(message.content)?.parts)
      ? asRecord(message.content)!.parts
      : [];
    for (const rawPart of parts) {
      const part = asRecord(rawPart);
      const pointer = typeof part?.asset_pointer === 'string' ? part.asset_pointer : '';
      const kind = pointer ? pointerKind(pointer) : undefined;
      if (!kind || state.emittedPointers.has(pointer)) continue;
      state.emittedPointers.add(pointer);
      const fileId = pointer.slice(
        ASSET_POINTER_PREFIXES[kind === 'file-service' ? 'fileService' : 'sediment'].length,
      );
      events.push({
        assetPointer: pointer,
        fileId,
        messageId,
        pointerKind: kind,
        type: 'image.pointer',
      });
    }
  }
}
