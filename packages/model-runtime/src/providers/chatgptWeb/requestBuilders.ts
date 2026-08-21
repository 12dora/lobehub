import type { RuntimeBrowserDeviceProfile } from '../../browserProfile';
import { DEFAULT_BROWSER_DEVICE_PROFILE, resolveProfileTimezone } from '../../browserProfile';
import { randomUuid } from './binary';
import {
  ASSET_POINTER_PREFIXES,
  buildClientContextualInfo,
  buildFlowClientContextualInfo,
  CLIENT_CREATED_ROOT,
  FLOW_CLIENT_PREPARE_STATE,
  MODEL_RESPONSE_CONTRACTS,
  SEARCH_SOURCE,
} from './constants';
import type { AttachmentRef, ChatGPTWebMessage, ThinkingEffort } from './types';

/**
 * Which `/backend-api/f/*` flow a body belongs to. The three differ in more than
 * their `system_hints`: `client_prepare_state`, the contextual-info block and
 * the parent-message id are all flow-specific.
 */
export type ConduitFlow = 'search' | 'picture' | 'attachments';

/**
 * The `system_hints` each flow carries when the caller does not spell them out.
 *
 * NOTE the asymmetry, which is faithful to the live traffic: on the `/f/`
 * CONVERSATION call the search hint rides on the last message
 * (`metadata.system_hints`) and the top level stays empty, while the PREPARE
 * call carries it at the top level.
 */
const FLOW_SYSTEM_HINTS: Record<ConduitFlow, string[]> = {
  attachments: [],
  picture: ['picture_v2'],
  search: ['search'],
};

/** Back-compat: infer the flow from the legacy `search` / `systemHints` inputs. */
const inferFlow = (options: { search?: boolean; systemHints?: string[] }): ConduitFlow => {
  if (options.search) return 'search';
  if (options.systemHints?.includes('picture_v2')) return 'picture';
  if (options.systemHints?.includes('search')) return 'search';
  return 'attachments';
};

/**
 * The app's effort scale mapped onto the three values chatgpt.com accepts.
 *
 * Verified live 2026-08-15: `thinking_effort` of `low` / `medium` / `high` is
 * rejected with `422 {"detail":"Invalid conversation body"}` on both
 * `/backend-api/conversation` and `/backend-api/f/conversation/prepare` — only
 * `standard`, `extended`, `max` (or omitting the field) are accepted.
 *
 * `instant` / `pro` / `none` / `minimal` / `auto` / unknown are not wire
 * values — they omit the field. Pro's `standard` is applied by
 * `resolveChatGPTWebTurn`, not by this alias table.
 */
const THINKING_EFFORT_ALIASES: Record<string, ThinkingEffort> = {
  extended: 'extended',
  high: 'extended',
  low: 'standard',
  max: 'max',
  medium: 'standard',
  standard: 'standard',
  xhigh: 'extended',
};

/**
 * `auto` / `none` / `minimal` / `instant` / `pro` / unknown ⇒ omit the field
 * entirely (that is what the web client does).
 */
export const normalizeThinkingEffort = (
  value: string | undefined | null,
): ThinkingEffort | undefined => {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!normalized) return undefined;
  return THINKING_EFFORT_ALIASES[normalized];
};

export interface BrowserEnvironmentOptions {
  browserProfile?: RuntimeBrowserDeviceProfile;
}

const resolveProfile = ({
  browserProfile = DEFAULT_BROWSER_DEVICE_PROFILE,
}: BrowserEnvironmentOptions): RuntimeBrowserDeviceProfile => browserProfile;

/**
 * `timezone` and `timezone_offset_min` travel in the same body, so the offset must be
 * the LIVE (DST-aware) one for that zone — a payload that says "America/New_York" and
 * "-300" in August contradicts itself.
 */
const timezoneFields = (options: BrowserEnvironmentOptions) => {
  const profile = resolveProfile(options);
  return {
    timezone: profile.timezone.iana,
    timezone_offset_min: resolveProfileTimezone(profile).offsetMinutes,
  };
};

/**
 * Attachment serialization. The reference implementation is inconsistent
 * (`mimeType` vs `mime_type`, `file-service://` vs `sediment://`); we pick the
 * newer snake_case shape with `file-service://` pointers everywhere, which is
 * what the current web client sends for freshly uploaded files.
 */
const toAttachmentMetadata = (attachment: AttachmentRef) => ({
  id: attachment.id,
  ...(attachment.kind === 'image'
    ? { height: attachment.height, width: attachment.width }
    : { fileTokenSize: attachment.fileTokenSize }),
  ...(attachment.libraryFileId ? { library_file_id: attachment.libraryFileId } : {}),
  mime_type: attachment.mimeType,
  name: attachment.name,
  size: attachment.size,
  source: attachment.source ?? (attachment.libraryFileId ? 'library' : 'local'),
});

const toImagePointerPart = (attachment: AttachmentRef) => ({
  asset_pointer: `${ASSET_POINTER_PREFIXES.fileService}${attachment.id}`,
  content_type: 'image_asset_pointer',
  height: attachment.height,
  size_bytes: attachment.size,
  width: attachment.width,
});

const baseMessageMetadata = () => ({
  selected_sources: [],
  serialization_metadata: { custom_symbol_offsets: [] },
});

export interface MessageMappingOptions {
  /** `system_hints` set on the LAST message's metadata (search switch). */
  lastMessageSystemHints?: string[];
  /** Include the browser-ish metadata block the `/f/` endpoints expect. */
  withRichMetadata?: boolean;
}

/** Map app messages onto upstream conversation messages. */
export const toConversationMessages = (
  messages: ChatGPTWebMessage[],
  { lastMessageSystemHints, withRichMetadata }: MessageMappingOptions = {},
): Record<string, any>[] =>
  messages.map((message, index) => {
    const images = (message.attachments ?? []).filter((item) => item.kind === 'image');
    const attachments = message.attachments ?? [];
    const isLast = index === messages.length - 1;

    // Images become pointer parts, and the text is appended LAST. Documents stay
    // plain text and live purely in `metadata.attachments`.
    const content =
      images.length > 0
        ? {
            content_type: 'multimodal_text',
            parts: [
              ...images.map(toImagePointerPart),
              ...(message.content ? [message.content] : []),
            ],
          }
        : { content_type: 'text', parts: [message.content] };

    const metadata: Record<string, any> = {
      ...(withRichMetadata ? baseMessageMetadata() : {}),
      ...(attachments.length > 0 ? { attachments: attachments.map(toAttachmentMetadata) } : {}),
      ...(isLast && lastMessageSystemHints?.length ? { system_hints: lastMessageSystemHints } : {}),
    };

    return {
      author: { role: message.role },
      content,
      id: randomUuid(),
      ...(withRichMetadata ? { create_time: Date.now() / 1000 } : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    };
  });

export interface ConversationBodyOptions extends BrowserEnvironmentOptions {
  messages: ChatGPTWebMessage[];
  model: string;
  parentMessageId?: string;
  thinkingEffort?: string;
}

/**
 * Plain `/backend-api/conversation` body. Note there is deliberately NO
 * `conversation_id`: every call starts a fresh server-side conversation and the
 * whole history is replayed.
 */
export const buildConversationBody = ({
  messages,
  model,
  parentMessageId,
  thinkingEffort,
  ...browserEnvironment
}: ConversationBodyOptions): Record<string, any> => {
  const effort = normalizeThinkingEffort(thinkingEffort);
  return {
    action: 'next',
    client_contextual_info: buildClientContextualInfo(resolveProfile(browserEnvironment)),
    conversation_mode: { kind: 'primary_assistant' },
    conversation_origin: null,
    force_paragen: false,
    force_paragen_model_slug: '',
    force_rate_limit: false,
    force_use_sse: true,
    history_and_training_disabled: true,
    messages: toConversationMessages(messages),
    model,
    parent_message_id: parentMessageId ?? randomUuid(),
    reset_rate_limits: false,
    suggestions: [],
    supported_encodings: [],
    system_hints: [],
    ...timezoneFields(browserEnvironment),
    variant_purpose: 'comparison_implicit',
    websocket_request_id: randomUuid(),
    ...(effort ? { thinking_effort: effort } : {}),
  };
};

export interface PrepareBodyOptions extends BrowserEnvironmentOptions {
  /**
   * Document-attachment flow only. The image flow must NOT send this (E3 §1.3);
   * it is ignored there.
   */
  attachmentMimeTypes?: string[];
  /** Browser dispatch lifecycle state. Pro captures send `success`, then `sent`. */
  clientPrepareState?: 'sent' | 'success';
  /** Defaults to the flow implied by `systemHints`. */
  flow?: ConduitFlow;
  model: string;
  parentMessageId?: string;
  prompt: string;
  /** e.g. `['search']` or `['picture_v2']` — TOP LEVEL on the prepare call. */
  systemHints?: string[];
  thinkingEffort?: string;
}

/** `POST /backend-api/f/conversation/prepare` — yields the conduit token. */
export const buildPrepareBody = ({
  attachmentMimeTypes,
  clientPrepareState = 'success',
  flow,
  model,
  parentMessageId,
  prompt,
  systemHints = [],
  thinkingEffort,
  ...browserEnvironment
}: PrepareBodyOptions): Record<string, any> => {
  const effort = normalizeThinkingEffort(thinkingEffort);
  const resolvedFlow = flow ?? inferFlow({ systemHints });
  // `system_hints` is mandatory on the prepare call and follows the FLOW, not
  // the caller's diligence: passing `flow: 'search'` alone used to prepare a
  // turn with no hints at all, which the upstream then served without search.
  const hints = systemHints.length > 0 ? systemHints : FLOW_SYSTEM_HINTS[resolvedFlow];
  // the image flow threads a fresh uuid; search / attachments use the sentinel
  const parent =
    parentMessageId ?? (resolvedFlow === 'picture' ? randomUuid() : CLIENT_CREATED_ROOT);

  return {
    action: 'next',
    client_contextual_info: {
      app_name: 'chatgpt.com',
      has_web_push_capabilities: true,
      web_push_notification_permission: 'default',
    },
    client_prepare_dispatch: 'immediate',
    client_prepare_source: 'context_change',
    client_prepare_state: clientPrepareState,
    conversation_mode: { kind: 'primary_assistant' },
    local_function_names: ['local.continue_in_work'],
    model,
    parent_message_id: parent,
    partial_query: {
      author: { role: 'user' },
      content: { content_type: 'text', parts: [prompt] },
      id: randomUuid(),
    },
    supported_encodings: ['v1'],
    supports_buffering: true,
    system_hints: hints,
    ...timezoneFields(browserEnvironment),
    // `attachment_mime_types` belongs to the DOCUMENT-attachment flow only
    // (E3 §1.3). The image flow ignores it, and the search flow must not carry
    // it at all — a search prepare that advertises mime types is not a body the
    // web client ever sends.
    ...(resolvedFlow === 'attachments' && attachmentMimeTypes?.length
      ? { attachment_mime_types: attachmentMimeTypes }
      : {}),
    ...(effort ? { thinking_effort: effort } : {}),
  };
};

export interface FConversationBodyOptions extends BrowserEnvironmentOptions {
  /** Defaults to the flow implied by `search` / `systemHints`. */
  flow?: ConduitFlow;
  messages: ChatGPTWebMessage[];
  model: string;
  parentMessageId?: string;
  /** Turn the upstream web-search tool on for the last user message. */
  search?: boolean;
  /** Top-level hints — `['picture_v2']` for images, `[]` for search. */
  systemHints?: string[];
  thinkingEffort?: string;
}

/**
 * `POST /backend-api/f/conversation` — the conduit path used for search,
 * attachments and image generation.
 */
export const buildFConversationBody = ({
  flow,
  messages,
  model,
  parentMessageId,
  search,
  systemHints = [],
  thinkingEffort,
  ...browserEnvironment
}: FConversationBodyOptions): Record<string, any> => {
  const effort = normalizeThinkingEffort(thinkingEffort);
  const resolvedFlow = flow ?? inferFlow({ search, systemHints });
  const isSearch = resolvedFlow === 'search';
  // the search flow keeps the TOP level empty and puts its hint on the last
  // message (live-verified); the image flow advertises `picture_v2` at both
  const topLevelHints =
    systemHints.length > 0 ? systemHints : isSearch ? [] : FLOW_SYSTEM_HINTS[resolvedFlow];
  const messageHints = isSearch ? ['search'] : topLevelHints.length > 0 ? topLevelHints : undefined;
  const parent =
    parentMessageId ?? (resolvedFlow === 'picture' ? randomUuid() : CLIENT_CREATED_ROOT);

  return {
    action: 'next',
    client_contextual_info: {
      ...buildFlowClientContextualInfo(resolveProfile(browserEnvironment))[resolvedFlow],
    },
    client_prepare_state: FLOW_CLIENT_PREPARE_STATE[resolvedFlow],
    conversation_mode: { kind: 'primary_assistant' },
    enable_message_followups: true,
    force_parallel_switch: 'auto',
    local_function_names: ['local.continue_in_work'],
    model_response_contracts: [...MODEL_RESPONSE_CONTRACTS],
    messages: toConversationMessages(messages, {
      lastMessageSystemHints: messageHints,
      withRichMetadata: true,
    }),
    model,
    paragen_cot_summary_display_override: 'allow',
    parent_message_id: parent,
    supported_encodings: ['v1'],
    supports_buffering: true,
    system_hints: topLevelHints,
    ...timezoneFields(browserEnvironment),
    ...(isSearch ? { client_reported_search_source: SEARCH_SOURCE, force_use_search: true } : {}),
    ...(effort ? { thinking_effort: effort } : {}),
  };
};

export interface ImageConversationOptions extends BrowserEnvironmentOptions {
  model: string;
  prompt: string;
  /** Reference images for an edit; empty for text-to-image. */
  references?: AttachmentRef[];
  thinkingEffort?: string;
}

/**
 * The two bodies of the `picture_v2` flow: the prepare call (prompt only — the
 * references are NOT sent there) and the SSE call.
 */
export const buildImageConversationBodies = ({
  model,
  prompt,
  references = [],
  thinkingEffort,
  ...browserEnvironment
}: ImageConversationOptions): {
  conversation: Record<string, any>;
  prepare: Record<string, any>;
} => {
  const hints = ['picture_v2'];
  return {
    conversation: buildFConversationBody({
      flow: 'picture',
      messages: [{ attachments: references, content: prompt, role: 'user' }],
      model,
      systemHints: hints,
      thinkingEffort,
      ...browserEnvironment,
    }),
    // NOTE: the image prepare deliberately carries neither the references nor
    // `attachment_mime_types` — that field belongs to the document-attachment
    // flow only (E3 §1.3).
    prepare: buildPrepareBody({
      flow: 'picture',
      model,
      prompt,
      systemHints: hints,
      thinkingEffort,
      ...browserEnvironment,
    }),
  };
};

/** File-record creation body for `POST /backend-api/files`. */
export const buildFileCreateBody = (meta: {
  browserProfile?: RuntimeBrowserDeviceProfile;
  height?: number;
  kind: 'image' | 'document';
  mimeType: string;
  name: string;
  size: number;
  width?: number;
}): Record<string, any> => {
  const timezoneOffsetMin = resolveProfileTimezone(
    meta.browserProfile ?? DEFAULT_BROWSER_DEVICE_PROFILE,
  ).offsetMinutes;
  if (meta.kind === 'image')
    return {
      file_name: meta.name,
      file_size: meta.size,
      height: meta.height,
      library_persistence_mode: 'opportunistic',
      reset_rate_limits: false,
      store_in_library: true,
      timezone_offset_min: timezoneOffsetMin,
      use_case: 'multimodal',
      width: meta.width,
    };

  return {
    file_name: meta.name,
    file_size: meta.size,
    reset_rate_limits: false,
    timezone_offset_min: timezoneOffsetMin,
    use_case: 'my_files',
  };
};
