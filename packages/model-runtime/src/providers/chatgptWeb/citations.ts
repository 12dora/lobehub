import type { Citation, ConversationDocument, ConversationDocumentNode } from './types';

/** Trailing ASCII + CJK punctuation the model likes to glue onto URLs. */
const trimUrl = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/[,.;、。；]+$/, '');
};

const asRecord = (value: unknown): Record<string, any> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, any>)
    : undefined;

/**
 * The stream's visibility gate, shared with the event router so a post-turn read
 * of the conversation document cannot pick a message the stream would never have
 * shown (a `thoughts` channel message, a `recipient: "web"` tool call, …).
 */
export const isVisibleAssistantMessage = (message: Record<string, any>): boolean => {
  if (String(asRecord(message.author)?.role ?? '').toLowerCase() !== 'assistant') return false;
  if (asRecord(message.metadata)?.is_visually_hidden_from_conversation === true) return false;

  // Tool calls are assistant messages addressed to a recipient such as "web".
  const recipient = String(message.recipient ?? '')
    .trim()
    .toLowerCase();
  if (recipient && recipient !== 'all') return false;

  // Reasoning and other internal channels must not leak into the text output.
  const channel = String(message.channel ?? '')
    .trim()
    .toLowerCase();
  return !(channel && channel !== 'final');
};

/** Content types that can carry a user-facing answer. */
const ANSWER_CONTENT_TYPES = new Set(['text', 'multimodal_text']);

export const isAnswerMessage = (message: Record<string, any>): boolean => {
  if (!isVisibleAssistantMessage(message)) return false;
  const contentType = asRecord(message.content)?.content_type;
  // an absent content_type is the plain-text default
  return contentType === undefined || ANSWER_CONTENT_TYPES.has(String(contentType));
};

const pushUnique = (into: Citation[], citation: Citation | undefined) => {
  if (!citation?.url) return;
  const existing = into.find((item) => item.url === citation.url);
  if (!existing) {
    into.push(citation);
    return;
  }
  // enrich a previously harvested bare URL
  existing.title ||= citation.title;
  existing.snippet ||= citation.snippet;
  existing.attribution ||= citation.attribution;
  existing.startIx ??= citation.startIx;
  existing.endIx ??= citation.endIx;
  existing.groupType ||= citation.groupType;
};

const toCitation = (
  item: Record<string, any>,
  groupType?: string,
  offsets?: { endIx?: number; startIx?: number },
): Citation | undefined => {
  const url = trimUrl(item.url ?? item.link ?? item.source_url);
  if (!url) return undefined;
  return {
    attribution: item.attribution ?? item.attribution_segments?.[0],
    endIx: offsets?.endIx ?? item.end_idx ?? item.end_ix,
    groupType,
    pubDate: item.pub_date ?? item.publication_date,
    snippet: item.snippet ?? item.text ?? item.description,
    startIx: offsets?.startIx ?? item.start_idx ?? item.start_ix,
    title: item.title ?? item.name ?? item.source,
    url,
  };
};

/**
 * Structured read of `metadata.content_references` + `metadata.citations` on a
 * single assistant message.
 */
export const citationsFromMessage = (message: unknown): Citation[] => {
  const record = asRecord(message);
  const metadata = asRecord(record?.metadata);
  if (!metadata) return [];

  const citations: Citation[] = [];

  const references = Array.isArray(metadata.content_references) ? metadata.content_references : [];
  for (const rawReference of references) {
    const reference = asRecord(rawReference);
    if (!reference) continue;
    const groupType = typeof reference.type === 'string' ? reference.type : undefined;
    const offsets = {
      endIx: reference.end_idx ?? reference.end_ix,
      startIx: reference.start_idx ?? reference.start_ix,
    };
    const items = Array.isArray(reference.items) ? reference.items : [];
    if (items.length > 0) {
      for (const rawItem of items) {
        const item = asRecord(rawItem);
        if (item) pushUnique(citations, toCitation(item, groupType, offsets));
      }
      continue;
    }
    pushUnique(citations, toCitation(reference, groupType, offsets));
  }

  const legacy = Array.isArray(metadata.citations) ? metadata.citations : [];
  for (const rawCitation of legacy) {
    const citation = asRecord(rawCitation);
    const inner = asRecord(citation?.metadata);
    if (!inner) continue;
    pushUnique(
      citations,
      toCitation(inner, typeof inner.type === 'string' ? inner.type : undefined, {
        endIx: citation?.end_ix,
        startIx: citation?.start_ix,
      }),
    );
  }

  return citations;
};

const walkForUrls = (value: unknown, into: Citation[], depth = 0): void => {
  if (depth > 8) return;
  if (Array.isArray(value)) {
    for (const item of value) walkForUrls(item, into, depth + 1);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  pushUnique(into, toCitation(record));
  for (const nested of Object.values(record)) walkForUrls(nested, into, depth + 1);
};

const messageCreateTime = (message: Record<string, any>): number => {
  const raw = message.create_time;
  return typeof raw === 'number' ? raw : Number(raw ?? 0) || 0;
};

/**
 * The newest *user-visible* assistant message in a fetched conversation
 * document.
 *
 * The gates are the stream's: without them the newest node is frequently a
 * `thoughts` / `analysis` message (E6 §1.5) or a `recipient: "web"` tool call,
 * and the turn's citations would be read off the wrong message.
 */
export const latestAssistantMessage = (
  document: ConversationDocument | undefined,
): Record<string, any> | undefined => {
  const mapping = document?.mapping;
  if (!mapping) return undefined;

  let latest: Record<string, any> | undefined;
  for (const node of Object.values(mapping)) {
    const message = asRecord(node?.message);
    if (!message || !isAnswerMessage(message)) continue;
    if (!latest || messageCreateTime(message) >= messageCreateTime(latest)) latest = message;
  }
  return latest;
};

export interface TurnAnswerOptions {
  /** Accept an answer created after this epoch-seconds mark, whatever its branch. */
  since?: number;
  /** The id we generated for THIS turn's user message. */
  userMessageId?: string;
}

/** Walk `mapping[node].parent` upwards, looking for `ancestorId`. */
const descendsFrom = (
  mapping: NonNullable<ConversationDocument['mapping']>,
  nodeId: string,
  ancestorId: string,
): boolean => {
  let current: string | undefined = nodeId;
  // conversations are shallow; the bound only guards a corrupt/cyclic mapping
  for (let hop = 0; current && hop < 200; hop += 1) {
    const node: ConversationDocumentNode | undefined = mapping[current];
    // the node key is normally the message id, but do not rely on it
    if (current === ancestorId || asRecord(node?.message)?.id === ancestorId) return true;
    current = node?.parent;
  }
  return false;
};

/**
 * The assistant answer belonging to **this** turn.
 *
 * Every ChatGPT Web request replays the whole history, so the document is full
 * of finished assistant messages from previous turns; picking the newest one
 * (`latestAssistantMessage`) would happily return a historical answer as if it
 * were the new one. Correlate instead: the answer must descend from the user
 * message we just sent, or at least have been created after we sent it.
 */
export const turnAnswerMessage = (
  document: ConversationDocument | undefined,
  { since, userMessageId }: TurnAnswerOptions = {},
): Record<string, any> | undefined => {
  const mapping = document?.mapping;
  if (!mapping) return undefined;
  // without any correlation signal there is nothing to distinguish a replay from
  // the new answer — refuse rather than guess
  if (!userMessageId && since === undefined) return undefined;

  let latest: Record<string, any> | undefined;
  for (const [nodeId, node] of Object.entries(mapping)) {
    const message = asRecord(node?.message);
    if (!message || !isAnswerMessage(message)) continue;

    const correlated =
      (!!userMessageId && descendsFrom(mapping, nodeId, userMessageId)) ||
      (since !== undefined && messageCreateTime(message) > since);
    if (!correlated) continue;

    if (!latest || messageCreateTime(message) >= messageCreateTime(latest)) latest = message;
  }
  return latest;
};

/**
 * Citations for a finished turn: structured `content_references` first, and only
 * when that yields nothing, the blind url-key harvest the reference
 * implementation relies on.
 */
export const extractCitations = (
  document: ConversationDocument | undefined,
  /** When given, the citations are read off THIS turn's answer only. */
  turn?: TurnAnswerOptions,
): Citation[] => {
  const message = turn ? turnAnswerMessage(document, turn) : latestAssistantMessage(document);
  if (!message) return [];

  const structured = citationsFromMessage(message);
  if (structured.length > 0) return structured;

  const harvested: Citation[] = [];
  walkForUrls(message, harvested);
  return harvested;
};
