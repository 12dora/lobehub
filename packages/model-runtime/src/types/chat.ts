import type {
  ModelPerformance,
  ModelReasoning,
  ModelTokensUsage,
  ModelUsage,
} from '@lobechat/types';

import type { ModelPricingContext } from './pricing';
import type { MessageToolCall, MessageToolCallChunk } from './toolsCalling';

export type LLMRoleType = 'user' | 'system' | 'assistant' | 'function' | 'tool';

export type ChatResponseFormat =
  | { type: 'json_object' }
  | {
      json_schema: {
        name: string;
        schema: Record<string, any>;
        strict?: boolean;
      };
      type: 'json_schema';
    };

interface UserMessageContentPartThinking {
  signature: string;
  thinking: string;
  type: 'thinking';
}
interface UserMessageContentPartText {
  text: string;
  type: 'text';
}

interface UserMessageContentPartImage {
  image_url: {
    detail?: 'auto' | 'low' | 'high';
    url: string;
  };
  type: 'image_url';
}

interface UserMessageContentPartVideo {
  type: 'video_url';
  video_url: { url: string };
}
interface UserMessageContentPartAudio {
  audio_url: { url: string };
  type: 'audio_url';
}

/**
 * A user-attached document carried as a native content part instead of being
 * flattened into the `<files_info>` text block. Only emitted by the context
 * engine when the target model declares `abilities.files`, so a runtime can
 * upload the real file to its upstream (e.g. ChatGPT Web).
 */
export interface UserMessageContentPartFile {
  file_url: {
    /**
     * Server-parsed text of the document, when available. Lets a runtime fall
     * back to text injection if the native upload fails.
     */
    content?: string;
    /** Id of the file record in the LobeHub file store */
    fileId?: string;
    mimeType?: string;
    name: string;
    size?: number;
    url: string;
  };
  type: 'file_url';
}

export type UserMessageContentPart =
  | UserMessageContentPartText
  | UserMessageContentPartImage
  | UserMessageContentPartVideo
  | UserMessageContentPartAudio
  | UserMessageContentPartFile
  | UserMessageContentPartThinking;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isOptionalString = (value: unknown): boolean =>
  value === undefined || typeof value === 'string';

/**
 * Loose check: does this part *claim* to be a native file part?
 *
 * Providers that cannot carry documents must drop / downgrade every part that
 * claims the `file_url` type, including malformed ones — otherwise an unknown
 * object reaches the upstream wire. Use `isFileUrlPart` instead whenever the
 * part's fields are actually read.
 */
export const isFileUrlTypedPart = (part: unknown): boolean =>
  !!part && typeof part === 'object' && (part as { type?: unknown }).type === 'file_url';

/**
 * Type guard for the native `file_url` part.
 *
 * Takes `unknown` on purpose: providers that never opt into native files still
 * need to recognise (and drop) the part while their local content-part unions
 * do not include it.
 *
 * The whole declared shape is validated, not just `file_url.url`: callers use
 * the narrowed value to build placeholders (`[file omitted: <name>]`) and
 * upstream upload payloads, so a partially-valid object must be rejected
 * outright rather than surface as `undefined` / `[object Object]` on the wire.
 */
export const isFileUrlPart = (part: unknown): part is UserMessageContentPartFile => {
  if (!part || typeof part !== 'object' || Array.isArray(part)) return false;
  if ((part as { type?: unknown }).type !== 'file_url') return false;

  const fileUrl = (part as { file_url?: unknown }).file_url;
  if (!fileUrl || typeof fileUrl !== 'object' || Array.isArray(fileUrl)) return false;

  const { content, fileId, mimeType, name, size, url } = fileUrl as Record<string, unknown>;

  return (
    isNonEmptyString(url) &&
    isNonEmptyString(name) &&
    isOptionalString(mimeType) &&
    isOptionalString(fileId) &&
    isOptionalString(content) &&
    (size === undefined || (typeof size === 'number' && Number.isFinite(size)))
  );
};

/**
 * Text stand-in for a `file_url` part that the target provider cannot carry
 * natively — keeps the signal that a document was attached without leaking an
 * unknown object onto the wire.
 *
 * Accepts `unknown` and degrades gracefully: a malformed part must never render
 * as `[file omitted: undefined]` or `[file omitted: [object Object]]`.
 */
export const fileUrlPartPlaceholder = (part: unknown): string => {
  const name = (part as { file_url?: { name?: unknown } } | undefined)?.file_url?.name;

  return isNonEmptyString(name) ? `[file omitted: ${name}]` : '[file omitted]';
};

export interface OpenAIChatMessage {
  content: string | UserMessageContentPart[];
  name?: string;
  reasoning?: ModelReasoning;
  reasoning_content?: string;
  role: LLMRoleType;
  tool_call_id?: string;
  tool_calls?: MessageToolCall[];
}

/**
 * @title Chat Stream Payload
 */
export interface ChatStreamPayload {
  apiMode?: 'chatCompletion' | 'responses';
  /**
   * @title Provider deployment name
   */
  deploymentName?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /**
   * Enable context caching
   */
  enabledContextCaching?: boolean;
  /**
   * Whether to enable search
   */
  enabledSearch?: boolean;
  /**
   * @title Penalty coefficient for reducing repetitiveness in generated text
   * @default 0
   */
  frequency_penalty?: number;
  /**
   * @title Image aspect ratio for image generation
   */
  imageAspectRatio?: string;
  /**
   * @title Image resolution for image generation (e.g., '512', '1K', '2K', '4K')
   */
  imageResolution?: '512' | '1K' | '2K' | '4K';
  logprobs?: boolean;
  /**
   * @title Maximum length of generated text
   */
  max_tokens?: number;
  /**
   * @title List of chat messages
   */
  messages: OpenAIChatMessage[];
  /**
   * @title Custom text chunks for mock response
   */
  mockChunks?: string[];
  /**
   * @title Delay in milliseconds between mock chunks
   * @default 50
   */
  mockDelayMs?: number;
  /**
   * @title Enable mock response for benchmark testing
   * @description When true, returns a simulated SSE stream without calling real LLM API
   */
  mockResponse?: boolean;
  /**
   * @title Model name
   */
  model: string;
  /**
   * @title Number of text responses to return
   */
  n?: number;
  /**
   * @title Penalty coefficient for reducing topic variation in generated text
   * @default 0
   */
  presence_penalty?: number;
  preserveThinking?: boolean;
  provider?: string;
  reasoning?: {
    effort?: string;
    mode?: 'standard' | 'pro';
    summary?: string;
  };
  reasoning_effort?:
    | 'none'
    | 'no_think'
    | 'minimal'
    | 'instant'
    | 'low'
    | 'medium'
    | 'high'
    | 'xhigh'
    | 'max'
    | 'pro';
  response_format?: ChatResponseFormat;
  responseMode?: 'stream' | 'json';
  /**
   * @title Whether to enable streaming requests
   * @default true
   */
  stream?: boolean;
  /**
   * @title Randomness measure for generated text, controls creativity and diversity
   * @default 1
   */
  temperature?: number;
  text?: {
    verbosity?: 'low' | 'medium' | 'high';
  };
  /**
   * use for Claude and Gemini
   */
  thinking?: {
    budget_tokens?: number;
    type?: 'enabled' | 'disabled' | 'adaptive';
  };
  thinkingBudget?: number;
  /**
   * Thinking level for Gemini models (e.g., gemini-3.0-pro)
   */
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high';
  tool_choice?: string;
  tools?: ChatCompletionTool[];
  /**
   * @title Controls the highest probability single token in generated text
   * @default 1
   */
  top_logprobs?: number;
  top_p?: number;
  truncation?: 'auto' | 'disabled';
  /**
   * @title Gemini URL context fetching tool toggle
   */
  urlContext?: boolean;
  verbosity?: 'low' | 'medium' | 'high';
}

export interface ChatMethodOptions {
  callback?: ChatStreamCallbacks;
  /**
   * response headers
   */
  headers?: Record<string, any>;
  /** Metadata passed to hooks (billing, tracing, etc.) */
  metadata?: Record<string, unknown>;
  /** Request-scoped pricing context for model-bank pricing lookups. */
  pricingContext?: ModelPricingContext;
  /**
   * send the request to the ai api endpoint
   */
  requestHeaders?: Record<string, any>;
  signal?: AbortSignal;
  /**
   * userId for the chat completion
   */
  user?: string;
}

export interface ChatCompletionFunctions {
  /**
   * The description of what the function does.
   * @type {string}
   * @memberof ChatCompletionFunctions
   */
  description?: string;
  /**
   * The name of the function to be called. Must be a-z, A-Z, 0-9, or contain underscores and dashes, with a maximum length of 64.
   * @type {string}
   * @memberof ChatCompletionFunctions
   */
  name: string;
  /**
   * The parameters the functions accepts, described as a JSON Schema object. See the [guide](/docs/guides/gpt/function-calling) for examples, and the [JSON Schema reference](https://json-schema.org/understanding-json-schema/) for documentation about the format.
   * @type {{ [key: string]: any }}
   * @memberof ChatCompletionFunctions
   */
  parameters?: {
    [key: string]: any;
  };
}

export interface ChatCompletionTool {
  function: ChatCompletionFunctions;

  /**
   * The type of the tool. Currently, only `function` is supported.
   */
  type: 'function';
}

export interface OnFinishData {
  error?: any;
  /**
   * The terminal finishReason emitted by the provider in the `stop` SSE chunk
   * (e.g. Google: STOP / SAFETY / RECITATION / MAX_TOKENS; OpenAI: stop / length;
   * Anthropic: end_turn / max_tokens / tool_use). Used to detect "soft interrupts"
   * where the provider returns empty content with a non-normal finishReason.
   */
  finishReason?: string;
  grounding?: any;
  reasoning?: ModelReasoning;
  speed?: ModelPerformance;
  text: string;
  thinking?: string;
  toolsCalling?: MessageToolCall[];
  usage?: ModelUsage;
  usageMissingDiagnostics?: UsageMissingDiagnostics;
}

export interface UsageMissingDiagnostics {
  apiMode?: 'chat_completions' | 'messages' | 'responses';
  chunkIndex?: number;
  finishReason?: string | null;
  hasUsageMetadata: boolean;
  includeUsageRequested?: boolean;
  model?: string;
  provider?: string;
  responseId?: string;
  source:
    'anthropic_messages' | 'google_generative_ai' | 'openai_chat_completions' | 'openai_responses';
  terminalEventType: string;
  terminalStatus?: string;
}

/**
 * Base64 image data from model output
 */
export interface Base64ImageData {
  /** Base64 encoded image data (with or without data URI prefix) */
  data: string;
  /** Unique identifier for the image */
  id: string;
}

/**
 * A file produced by the model (e.g. a code-interpreter export) delivered
 * inline on the stream, mirroring {@link Base64ImageData} for non-image output.
 */
export interface StreamFileData {
  /** `data:<mimeType>;base64,…` — the whole file, encoded */
  data: string;
  mimeType: string;
  /** File name including its extension, already sanitized */
  name: string;
  /** Decoded byte length */
  size: number;
  /** Where the model wrote it (e.g. `sandbox:/mnt/data/report.pdf`), for tracing */
  sourcePath?: string;
}

/**
 * Content part data for multimodal output
 */
export interface ContentPartData {
  /** Text content or base64 image data */
  content: string;
  /** Image MIME type (for image parts) */
  mimeType?: string;
  /** Part type: text or image */
  partType: 'text' | 'image';
  /** Optional signature for reasoning verification (Google Gemini feature) */
  thoughtSignature?: string;
}

export interface ChatStreamCallbacks {
  /**
   * `onBase64Image`: Called when a base64 image is received from the model.
   * Used for models that generate images (e.g., GPT-4 with DALL-E, Gemini with image output)
   */
  onBase64Image?: (data: {
    /** The newly received image */
    image: Base64ImageData;
    /** All images received so far */
    images: Base64ImageData[];
  }) => Promise<void> | void;
  onCompletion?: (data: OnFinishData) => Promise<void> | void;
  /**
   * `onContentPart`: Called for each content part in multimodal output.
   * Used for models that return structured content with mixed text and images.
   */
  onContentPart?: (data: ContentPartData) => Promise<void> | void;
  /** `onError`: Called when a stream error event is received from the provider. */
  onError?: (error: any) => Promise<void> | void;
  /**
   * `onFile`: Called when the model delivers a generated file (e.g. a
   * code-interpreter export). Non-image counterpart of {@link onBase64Image}.
   */
  onFile?: (data: {
    /** The newly received file */
    file: StreamFileData;
    /** All files received so far */
    files: StreamFileData[];
  }) => Promise<void> | void;
  /**
   * `onFinal`: Called once when the stream is closed with the final completion message.
   **/
  onFinal?: (data: OnFinishData) => Promise<void> | void;
  onGrounding?: (grounding: any) => Promise<void> | void;
  /**
   * `onReasoningPart`: Called for each reasoning/thinking part in multimodal output.
   * Used for models that return structured reasoning with mixed text and images.
   */
  onReasoningPart?: (data: ContentPartData) => Promise<void> | void;
  /** `onStart`: Called once when the stream is initialized. */
  onStart?: () => Promise<void> | void;
  /** `onText`: Called for each text chunk. */
  onText?: (content: string) => Promise<void> | void;
  onThinking?: (content: string) => Promise<void> | void;
  onToolsCalling?: (data: {
    chunk: MessageToolCallChunk[];
    /**
     * full tools calling array
     */
    toolsCalling: MessageToolCall[];
  }) => Promise<void> | void;
  onUsage?: (usage: ModelTokensUsage) => Promise<void> | void;
}
