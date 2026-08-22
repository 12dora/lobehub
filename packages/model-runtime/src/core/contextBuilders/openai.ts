import type { ImageUrlToBase64Options } from '@lobechat/utils';
import {
  assertDecodedBase64WithinLimit,
  AttachmentFetchError,
  AttachmentInlineLimitError,
  decodedBase64ByteLength,
  DEFAULT_FILE_INLINE_MAX_BYTES,
  imageUrlToBase64,
  sanitizedUrlHost,
  videoUrlToBase64,
} from '@lobechat/utils';
import { Buffer } from 'buffer.js';
import debug from 'debug';
import type OpenAI from 'openai';
import { toFile } from 'openai';

import { disableStreamModels, systemToUserModels } from '../../providers/openai/openaiModelId';
import { isXaiZdrFileUnsupportedError } from '../../providers/xai/zdr';
import type { ChatStreamPayload, OpenAIChatMessage, UserMessageContentPart } from '../../types';
import { fileUrlPartPlaceholder, isFileUrlPart, isFileUrlTypedPart } from '../../types/chat';
import { isDeepSeekThinkingEligibleModel } from '../../utils/modelParse';
import type { SignatureScope } from '../../utils/signatureScope';
import { resolveScopedSignature } from '../../utils/signatureScope';
import { parseDataUri } from '../../utils/uriParser';
import { filesInfoWithoutUrl } from './fileParts';

export type ExtendedChatCompletionContentPart = {
  type: 'video_url';
  video_url: {
    url: string;
  };
};

/**
 * A document that could not be inlined as Responses `input_file`.
 * Follow-up work can sync these into a sandbox via `onAttachmentOverLimit`.
 */
export interface SkippedAttachment {
  content?: string;
  filename: string;
  mimeType?: string;
  reason: 'fetch_failed' | 'over_limit' | 'unsupported_type';
  size?: number;
  url: string;
}

const log = debug('lobe-model-runtime:openai-inline');

type ConvertMessageContentOptions = {
  forceFileBase64?: boolean;
  forceImageBase64?: boolean;
  forceVideoBase64?: boolean;
  /** ChatGPT/Codex passes `{ maxBytes, ownOriginOnly: true }` explicitly. */
  inlineFile?: ImageUrlToBase64Options;
  inlineImage?: ImageUrlToBase64Options;
  model?: string;
  /**
   * Seam for over-limit / non-document files that fell back to extracted-text
   * `<files_info>` (without a `url` attribute). Do not implement sandbox sync here.
   */
  onAttachmentOverLimit?: (skipped: SkippedAttachment[]) => void;
  reasoningSignatureScope?: SignatureScope;
  strictToolPairing?: boolean;
  /**
   * When set, document bytes are uploaded and the Responses part is
   * `{ type: 'input_file', file_id }` instead of inline `file_data`.
   */
  uploadFile?: (input: {
    bytes: Uint8Array;
    filename: string;
    mimeType: string;
  }) => Promise<{ fileId: string }>;
};

const DOCUMENT_MIME_TYPES = new Set([
  'application/json',
  'application/msword',
  'application/pdf',
  'application/rtf',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/xml',
  'text/csv',
  'text/html',
  'text/markdown',
  'text/plain',
  'text/xml',
]);

const DOCUMENT_EXTENSIONS = new Set([
  'csv',
  'doc',
  'docx',
  'htm',
  'html',
  'json',
  'md',
  'pdf',
  'ppt',
  'pptx',
  'rtf',
  'txt',
  'xls',
  'xlsx',
  'xml',
]);

const isDocumentFileInput = (mimeType?: string, filename?: string): boolean => {
  if (mimeType) {
    const mime = mimeType.split(';')[0]?.trim().toLowerCase();
    if (mime && (DOCUMENT_MIME_TYPES.has(mime) || mime.startsWith('text/'))) return true;
  }

  const extension = filename?.split('.').pop()?.toLowerCase();
  return !!extension && DOCUMENT_EXTENSIONS.has(extension);
};

type ResponseFilePart =
  | { file_data: string; filename: string; type: 'input_file' }
  | { file_id: string; type: 'input_file' }
  | { text: string; type: 'input_text' };

const toInputFilePart = (filename: string, mimeType: string, base64: string): ResponseFilePart => ({
  file_data: `data:${mimeType};base64,${base64}`,
  filename,
  type: 'input_file',
});

const convertFileUrlPart = async (
  part: UserMessageContentPart,
  skipped: SkippedAttachment[],
  options?: ConvertMessageContentOptions,
): Promise<ResponseFilePart | undefined> => {
  if (!isFileUrlPart(part)) return undefined;

  const { content, fileId, mimeType, name, size, url } = part.file_url;
  const inlineFile = options?.inlineFile;
  const uploadFile = options?.uploadFile;
  const maxBytes = inlineFile?.maxBytes ?? DEFAULT_FILE_INLINE_MAX_BYTES;
  const skip = (reason: SkippedAttachment['reason']): ResponseFilePart => {
    skipped.push({ content, filename: name, mimeType, reason, size, url });
    return {
      text: filesInfoWithoutUrl({ content, fileId, mimeType, name, size }),
      type: 'input_text',
    };
  };

  const toUploadedOrDataPart = async (
    filename: string,
    resolvedMime: string,
    base64: string,
  ): Promise<ResponseFilePart> => {
    if (!uploadFile) return toInputFilePart(filename, resolvedMime, base64);
    try {
      const { fileId: uploadedFileId } = await uploadFile({
        bytes: new Uint8Array(Buffer.from(base64, 'base64')),
        filename,
        mimeType: resolvedMime,
      });
      return { file_id: uploadedFileId, type: 'input_file' };
    } catch (error) {
      if (isXaiZdrFileUnsupportedError(error)) throw error;
      log(
        'input_file upload failed: host=%s error=%s',
        sanitizedUrlHost(url),
        error instanceof Error ? error.name : 'Error',
      );
      return skip('fetch_failed');
    }
  };

  if (!isDocumentFileInput(mimeType, name)) {
    return skip('unsupported_type');
  }

  if (typeof size === 'number' && size > maxBytes) {
    return skip('over_limit');
  }

  const parsed = parseDataUri(url);
  if (parsed.type === 'base64' && parsed.base64) {
    if (decodedBase64ByteLength(parsed.base64) > maxBytes) {
      return skip('over_limit');
    }
    const resolvedMime = parsed.mimeType || mimeType || 'application/octet-stream';
    return toUploadedOrDataPart(name, resolvedMime, parsed.base64);
  }

  try {
    const inlined = await imageUrlToBase64(url, inlineFile ?? { maxBytes });
    return toUploadedOrDataPart(
      name,
      inlined.mimeType || mimeType || 'application/octet-stream',
      inlined.base64,
    );
  } catch (error) {
    if (isXaiZdrFileUnsupportedError(error)) throw error;
    if (error instanceof AttachmentInlineLimitError) {
      return skip('over_limit');
    }
    log(
      'input_file inline failed: host=%s error=%s status=%s',
      sanitizedUrlHost(url),
      error instanceof Error ? error.name : 'Error',
      error instanceof AttachmentFetchError ? (error.status ?? '-') : '-',
    );
    return skip('fetch_failed');
  }
};

const isDeepSeekModel = (model: string | undefined) =>
  typeof model === 'string' && model.toLowerCase().includes('deepseek');

type OpenAICompatibleContentPart =
  ExtendedChatCompletionContentPart | OpenAI.ChatCompletionContentPart | UserMessageContentPart;

const isInternalThinkingContentPart = (
  content: OpenAICompatibleContentPart,
): content is Extract<UserMessageContentPart, { type: 'thinking' }> => content.type === 'thinking';

export const convertMessageContent = async (
  content: OpenAI.ChatCompletionContentPart | ExtendedChatCompletionContentPart,
  options?: ConvertMessageContentOptions,
): Promise<OpenAI.ChatCompletionContentPart | ExtendedChatCompletionContentPart> => {
  // Native `file_url` parts are only understood by providers that opt into them
  // (see `isProviderNativeFileInput`). OpenAI-compatible endpoints would reject
  // the raw object, so downgrade it to a text marker instead of forwarding it.
  // Deliberately the loose check: even a malformed part must not reach the wire.
  if (isFileUrlTypedPart(content)) {
    return { text: fileUrlPartPlaceholder(content), type: 'text' };
  }

  if (content.type === 'image_url') {
    const parsed = parseDataUri(content.image_url.url);
    const maxBytes = options?.inlineImage?.maxBytes;

    if (parsed.type === 'base64' && parsed.base64 && maxBytes !== undefined) {
      assertDecodedBase64WithinLimit(parsed.base64, maxBytes);
    }

    const shouldUseBase64 =
      options?.forceImageBase64 || process.env.LLM_VISION_IMAGE_USE_BASE64 === '1';

    if (parsed.type === 'url' && shouldUseBase64) {
      const { base64, mimeType } = options?.inlineImage
        ? await imageUrlToBase64(content.image_url.url, options.inlineImage)
        : await imageUrlToBase64(content.image_url.url);

      return {
        ...content,
        image_url: { ...content.image_url, url: `data:${mimeType};base64,${base64}` },
      };
    }
  }

  if (content.type === 'video_url') {
    const { type } = parseDataUri(content.video_url.url);

    const shouldUseBase64 =
      options?.forceVideoBase64 || process.env.LLM_VISION_VIDEO_USE_BASE64 === '1';

    if (type === 'url' && shouldUseBase64) {
      try {
        const { base64, mimeType } = await videoUrlToBase64(content.video_url.url);

        return {
          ...content,
          video_url: { ...content.video_url, url: `data:${mimeType};base64,${base64}` },
        };
      } catch (error) {
        console.warn('Failed to convert video to base64:', error);
        return content;
      }
    }
  }

  return content;
};

export const convertOpenAIMessages = async (
  messages: OpenAI.ChatCompletionMessageParam[],
  options?: ConvertMessageContentOptions,
) => {
  return (await Promise.all(
    messages.map(async (message) => {
      const msg = message as any;

      // Explicitly map only valid ChatCompletionMessageParam fields
      // Exclude reasoning and reasoning_content fields as they should not be sent in requests
      const result: any = {
        content:
          typeof message.content === 'string'
            ? message.content
            : await Promise.all(
                (message.content || [])
                  .filter((c) => !isInternalThinkingContentPart(c as OpenAICompatibleContentPart))
                  .map((c) =>
                    convertMessageContent(c as OpenAI.ChatCompletionContentPart, options),
                  ),
              ),
        role: msg.role,
      };

      // Add optional fields if they exist
      if (msg.name !== undefined) result.name = msg.name;
      if (msg.tool_calls !== undefined) result.tool_calls = msg.tool_calls;
      if (msg.tool_call_id !== undefined) result.tool_call_id = msg.tool_call_id;
      if (msg.function_call !== undefined) result.function_call = msg.function_call;

      // it's compatible for DeepSeek & Moonshot
      if (msg.reasoning_content !== undefined) result.reasoning_content = msg.reasoning_content;
      // MiniMax uses reasoning_details for historical thinking, so forward it unchanged
      if (msg.reasoning_details !== undefined) result.reasoning_details = msg.reasoning_details;

      // For DeepSeek-family models routed via any OpenAI-compatible runtime
      // (including custom user providers that bypass the dedicated DeepSeek
      // handlePayload), derive reasoning_content from the structured reasoning
      // field on assistant messages and force a placeholder when the model is
      // thinking-mode eligible.
      if (msg.role === 'assistant' && isDeepSeekModel(options?.model)) {
        if (result.reasoning_content === undefined && typeof msg.reasoning?.content === 'string') {
          result.reasoning_content = msg.reasoning.content;
        }
        if (
          result.reasoning_content === undefined &&
          isDeepSeekThinkingEligibleModel(options?.model)
        ) {
          result.reasoning_content = '';
        }
      }

      return result;
    }),
  )) as OpenAI.ChatCompletionMessageParam[];
};

export const convertOpenAIResponseInputs = async (
  messages: OpenAIChatMessage[],
  options?: ConvertMessageContentOptions,
) => {
  const skippedAttachments: SkippedAttachment[] = [];
  const strictToolPairing = options?.strictToolPairing === true;
  // OpenAI Responses API rejects inputs that keep a function_call without its matching
  // function_call_output. Example from production:
  // "No tool output found for function call call_w5odMFjtXEYBBVyBUAQNMOh5."
  const validToolCallIds = new Set<string>();
  const pairedToolOutputIds = new Set<string>();

  for (const message of messages) {
    if (message.role === 'assistant' && message.tool_calls?.length) {
      message.tool_calls.forEach((tool) => {
        if (tool.id) validToolCallIds.add(tool.id);
      });
    }
  }

  for (const message of messages) {
    if (
      message.role === 'tool' &&
      message.tool_call_id &&
      validToolCallIds.has(message.tool_call_id)
    ) {
      pairedToolOutputIds.add(message.tool_call_id);
    }
  }

  const inputGroups = await Promise.all(
    messages.map(async (message) => {
      const items: OpenAI.Responses.ResponseInputItem[] = [];
      const reasoning = message.reasoning;

      /**
       * Resolve persisted Responses reasoning items for stateless replay. Encrypted
       * items must all match the current signature scope — a single foreign-scope item
       * would make OpenAI reject the whole request, so fail closed to the legacy path.
       */
      const resolveResponseItems = (): OpenAI.Responses.ResponseReasoningItem[] | undefined => {
        const responseItems = reasoning?.responseItems;
        if (!responseItems?.length) return undefined;

        const resolved: OpenAI.Responses.ResponseReasoningItem[] = [];
        for (const item of responseItems) {
          if (item.encrypted_content) {
            const encryptedContent = resolveScopedSignature(
              item.encrypted_content,
              options?.reasoningSignatureScope,
              'reasoning',
            );
            if (!encryptedContent) return undefined;

            resolved.push({
              ...item,
              encrypted_content: encryptedContent,
            } as OpenAI.Responses.ResponseReasoningItem);
          } else {
            /**
             * Without encrypted content the server cannot look the item up by id in a
             * stateless request, so drop the id and replay the visible summary only.
             */
            const { id: _id, ...rest } = item;
            resolved.push(rest as unknown as OpenAI.Responses.ResponseReasoningItem);
          }
        }

        return resolved;
      };

      const replayableResponseItems = resolveResponseItems();

      if (replayableResponseItems) {
        // Replay complete reasoning items verbatim and in original stream order.
        items.push(...replayableResponseItems);
      } else {
        const encryptedContent = resolveScopedSignature(
          reasoning?.signature,
          options?.reasoningSignatureScope,
          'reasoning',
        );

        // Preserve encrypted reasoning state for stateless Responses API requests.
        if (reasoning?.content || encryptedContent) {
          items.push({
            encrypted_content: encryptedContent,
            summary: reasoning?.content ? [{ text: reasoning.content, type: 'summary_text' }] : [],
            type: 'reasoning',
          } as OpenAI.Responses.ResponseReasoningItem);
        }
      }

      // if message is assistant messages with tool calls , transform it to function type item
      if (message.role === 'assistant' && message.tool_calls && message.tool_calls?.length > 0) {
        const toolCalls = strictToolPairing
          ? message.tool_calls.filter((tool) => !!tool.id && pairedToolOutputIds.has(tool.id))
          : message.tool_calls;

        toolCalls.forEach((tool) => {
          items.push({
            arguments: strictToolPairing ? tool.function.arguments : tool.function.name,
            call_id: tool.id,
            name: tool.function.name,
            type: 'function_call',
          });
        });

        return items;
      }

      if (message.role === 'tool') {
        if (
          strictToolPairing &&
          (!message.tool_call_id || !pairedToolOutputIds.has(message.tool_call_id))
        )
          return items;

        items.push({
          call_id: message.tool_call_id,
          output: message.content,
          type: 'function_call_output',
        } as OpenAI.Responses.ResponseFunctionToolCallOutputItem);

        return items;
      }

      if (message.role === 'system') {
        items.push({ ...message, role: 'developer' } as OpenAI.Responses.ResponseInputItem);
        return items;
      }

      // default item
      // also need handle image

      const processedContent =
        typeof message.content === 'string'
          ? message.content
          : await Promise.all(
              (message.content || []).map(async (c) => {
                if (isInternalThinkingContentPart(c as OpenAICompatibleContentPart)) {
                  return undefined;
                }

                if (c.type === 'text') {
                  // if assistant message, set type to output_text
                  // https://platform.openai.com/docs/guides/text
                  if (message.role === 'assistant') {
                    return { ...c, type: 'output_text' };
                  }
                  return { ...c, type: 'input_text' };
                }

                // Responses API only accepts output_text/refusal inside assistant history.
                // Multimodal parts are valid as model inputs, not as previous assistant outputs.
                if (message.role === 'assistant') {
                  return undefined;
                }

                if (isFileUrlTypedPart(c)) {
                  // Opt-in only: other Responses providers keep today's drop.
                  if (!options?.forceFileBase64) return undefined;
                  return convertFileUrlPart(c, skippedAttachments, options);
                }

                if (c.type === 'video_url') {
                  const video = await convertMessageContent(c, options);
                  if (!('video_url' in video) || !video.video_url?.url) {
                    return undefined;
                  }
                  return {
                    video_url: video.video_url.url,
                    type: 'input_video',
                  };
                }
                const image = await convertMessageContent(
                  c as OpenAI.ChatCompletionContentPart,
                  options,
                );
                if (!(image as OpenAI.ChatCompletionContentPartImage).image_url?.url) {
                  return undefined;
                }
                return {
                  image_url: (image as OpenAI.ChatCompletionContentPartImage).image_url?.url,
                  type: 'input_image',
                };
              }),
            );

      const content =
        typeof processedContent === 'string'
          ? processedContent
          : processedContent.filter((m) => m !== undefined);

      if (message.role === 'assistant' && Array.isArray(content) && content.length === 0) {
        return items;
      }

      const item = {
        ...message,
        content,
      } as OpenAI.Responses.ResponseInputItem;

      // remove reasoning field from the message item
      delete (item as any).reasoning;

      items.push(item);
      return items;
    }),
  );

  if (skippedAttachments.length > 0) {
    options?.onAttachmentOverLimit?.(skippedAttachments);
  }

  return inputGroups.flat();
};

export const pruneReasoningPayload = (payload: ChatStreamPayload) => {
  const shouldStream = !disableStreamModels.has(payload.model);
  const { stream_options, logprobs, top_logprobs, ...cleanedPayload } = payload as any;

  // When reasoning_effort is 'none', allow user-defined temperature/top_p
  const effort = payload.reasoning?.effort || payload.reasoning_effort;
  const isEffortNone = effort === 'none';

  return {
    ...cleanedPayload,
    frequency_penalty: 0,
    messages: payload.messages.map((message: OpenAIChatMessage) => ({
      ...message,
      role:
        message.role === 'system'
          ? systemToUserModels.has(payload.model)
            ? 'user'
            : 'developer'
          : message.role,
    })),
    presence_penalty: 0,
    stream: shouldStream,
    // Only include stream_options when stream is enabled
    ...(shouldStream && stream_options && { stream_options }),

    /**
     *  In openai docs: https://platform.openai.com/docs/guides/latest-model#gpt-5-2-parameter-compatibility
     *  Fields like `top_p`, `temperature`, `logprobs`, and `top_logprobs` are only supported by
     *  GPT-5 series (e.g. 5-mini 5-nano ) when reasoning effort is none
     */
    logprobs: isEffortNone ? logprobs : undefined,
    temperature: isEffortNone ? payload.temperature : undefined,
    top_logprobs: isEffortNone ? top_logprobs : undefined,
    top_p: isEffortNone ? payload.top_p : undefined,
  };
};

/**
 * Convert image URL (data URL or HTTP URL) to File object for OpenAI API
 */
export const convertImageUrlToFile = async (imageUrl: string) => {
  let buffer: Buffer;
  let mimeType: string;

  if (imageUrl.startsWith('data:')) {
    // a base64 image
    const [mimeTypePart, base64Data] = imageUrl.split(',');
    mimeType = mimeTypePart.split(':')[1].split(';')[0];
    buffer = Buffer.from(base64Data, 'base64');
  } else {
    // a http url
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch image from ${imageUrl}: ${response.statusText}`);
    }
    buffer = Buffer.from(await response.arrayBuffer());
    mimeType = response.headers.get('content-type') || 'image/png';
  }

  return toFile(buffer, `image.${mimeType.split('/')[1]}`, { type: mimeType });
};
