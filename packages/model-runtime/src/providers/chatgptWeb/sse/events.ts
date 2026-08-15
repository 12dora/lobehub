import { citationsFromMessage, isVisibleAssistantMessage } from '../citations';
import { ASSET_POINTER_PREFIXES } from '../constants';
import type { AssetPointerKind, Citation, ConversationEvent, StreamHandoffOption } from '../types';
import { sanitizeAnnotations } from './annotations';
import { applyPatchEvent, createPatchState, type PatchState } from './patch';

interface MessageState {
  citationCount: number;
  emittedPointers: Set<string>;
  endTurn?: boolean;
  ignored: boolean;
  reasoning: string;
  reasoningDone: boolean;
  status?: string;
  /** sanitized text already surfaced to the consumer */
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

const asRecord = (value: unknown): Record<string, any> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, any>)
    : undefined;

/**
 * Port of the reference `strip_history`: the upstream replays the assistant
 * turns we sent, so a full message can arrive as `<history><new text>`. Strip
 * the concatenated history prefix repeatedly (a repeated echo strips twice).
 */
export const stripHistory = (text: string, historyText: string): string => {
  if (!historyText) return text;
  let out = text;
  while (out.startsWith(historyText)) out = out.slice(historyText.length);
  return out;
};

const messageText = (message: Record<string, any>): string => {
  const content = asRecord(message.content);
  if (!content) return '';
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const joined = parts.filter((part: unknown) => typeof part === 'string').join('');
  if (joined) return joined;
  // content_type "code" keeps its payload in `text` rather than `parts`
  return typeof content.text === 'string' ? content.text : '';
};

const reasoningText = (message: Record<string, any>): { summary?: string; text: string } => {
  const content = asRecord(message.content);
  const thoughts = Array.isArray(content?.thoughts) ? content!.thoughts : [];
  const chunks: string[] = [];
  let summary: string | undefined;
  for (const rawThought of thoughts) {
    const thought = asRecord(rawThought);
    if (!thought) continue;
    if (typeof thought.summary === 'string' && thought.summary) summary = thought.summary;
    const body = [thought.summary, thought.content]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join('\n');
    if (body) chunks.push(body);
  }
  return { summary, text: chunks.join('\n\n') };
};

const toHandoffOptions = (value: unknown): StreamHandoffOption[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const options = value
    .map((raw) => asRecord(raw))
    .filter((option): option is Record<string, any> => !!option)
    .map((option) => ({
      topicId: typeof option.topic_id === 'string' ? option.topic_id : undefined,
      type: typeof option.type === 'string' ? option.type : undefined,
    }));
  return options.length > 0 ? options : undefined;
};

const pointerKind = (pointer: string): AssetPointerKind | undefined => {
  if (pointer.startsWith(ASSET_POINTER_PREFIXES.fileService)) return 'file-service';
  if (pointer.startsWith(ASSET_POINTER_PREFIXES.sediment)) return 'sediment';
  return undefined;
};

const isImageToolMessage = (message: Record<string, any>): boolean => {
  if (String(asRecord(message.author)?.role ?? '').toLowerCase() !== 'tool') return false;
  if (asRecord(message.metadata)?.async_task_type === 'image_gen') return true;

  const content = asRecord(message.content);
  if (content?.content_type !== 'multimodal_text') return false;
  const parts = Array.isArray(content.parts) ? content.parts : [];
  return parts.some((rawPart: unknown) => {
    const part = asRecord(rawPart);
    if (!part) return false;
    return (
      part.content_type === 'image_asset_pointer' || !!pointerKind(String(part.asset_pointer ?? ''))
    );
  });
};

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
    if (payload === '[DONE]')
      return [{ conversationId: this.conversationId, endTurn: this.endTurn, type: 'done' }];

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
        emittedPointers: new Set<string>(),
        ignored: false,
        reasoning: '',
        reasoningDone: false,
        text: '',
      };
      this.messages.set(id, state);
    }
    return state;
  }

  private deriveMessageEvents(message: Record<string, any>, events: ConversationEvent[]) {
    const messageId = typeof message.id === 'string' ? message.id : '__current__';
    const state = this.stateFor(messageId);
    if (state.ignored) return;

    const content = asRecord(message.content);
    const contentType = content?.content_type;
    const metadata = asRecord(message.metadata) ?? {};

    if (isImageToolMessage(message)) this.emitPointers(message, messageId, state, events);

    if (contentType === 'system_error') {
      events.push({
        code: typeof content?.name === 'string' ? content.name : undefined,
        message: messageText(message) || 'upstream reported a system error',
        type: 'error',
      });
      return;
    }

    if (contentType === 'thoughts') {
      const { summary, text } = reasoningText(message);
      if (text.length > state.reasoning.length && text.startsWith(state.reasoning)) {
        const delta = text.slice(state.reasoning.length);
        state.reasoning = text;
        events.push({ delta, messageId, summary, type: 'reasoning.delta' });
      } else if (text && text !== state.reasoning) {
        state.reasoning = text;
        events.push({ delta: text, messageId, summary, type: 'reasoning.delta' });
      }
    }

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

    if (isVisibleAssistantMessage(message)) {
      this.emitText(message, messageId, state, events);
      this.emitCitations(message, state, events);
    }

    const status = typeof message.status === 'string' ? message.status : undefined;
    const endTurn = typeof message.end_turn === 'boolean' ? message.end_turn : undefined;
    if (endTurn === true) this.endTurn = true;
    if (status !== state.status || endTurn !== state.endTurn) {
      state.status = status;
      state.endTurn = endTurn;
      if (status || endTurn !== undefined)
        events.push({ endTurn, messageId, status, type: 'message.status' });
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

    const raw = messageText(message);
    if (!raw) return;

    // `<replayed history><new text>` → `<new text>` (reference `strip_history`).
    const stripped = stripHistory(raw, this.historyText);

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
    if (sanitized === state.text) return;

    const delta = sanitized.startsWith(state.text) ? sanitized.slice(state.text.length) : sanitized;
    state.text = sanitized;
    if (delta) events.push({ delta, messageId, text: sanitized, type: 'text.delta' });
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
