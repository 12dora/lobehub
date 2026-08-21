import {
  type ChatFileItem,
  type ChatImageItem,
  type ChatToolPayload,
  type MessageContentPart,
  type MessageToolCall,
} from '@lobechat/types';
import { serializePartsForStorage } from '@lobechat/utils';
import debug from 'debug';
import { throttle } from 'es-toolkit/compat';
import pMap from 'p-map';

import { cleanSpeakerTag } from '../utils/cleanSpeakerTag';
import {
  type FinishData,
  type GroundingData,
  type ReasoningState,
  type StreamChunk,
  type StreamingCallbacks,
  type StreamingContext,
  type StreamingResult,
} from './types/streaming';

const log = debug('lobe-store:streaming-handler');

/** Max number of generated-file uploads running at the same time. */
const FILE_UPLOAD_CONCURRENCY = 3;

/**
 * Minimal `p-limit`: runs at most `concurrency` tasks at a time, queues the rest.
 *
 * Needed because generated files arrive one chunk at a time — `pMap` can only
 * limit an array that's known upfront, so it would just await uploads that all
 * started the moment their chunk landed.
 */
const createConcurrencyLimiter = (concurrency: number) => {
  let active = 0;
  const queue: (() => void)[] = [];

  const next = () => {
    active--;
    queue.shift()?.();
  };

  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = () => {
        active++;
        task().then(resolve, reject).finally(next);
      };

      if (active < concurrency) run();
      else queue.push(run);
    });
};

/**
 * Streaming message handler
 *
 * Encapsulates all state and logic for streaming message processing, including:
 * - Text content accumulation
 * - Reasoning content processing
 * - Multimodal content processing
 * - Tool calls processing
 * - Image upload management
 *
 * @example
 * ```typescript
 * const handler = new StreamingHandler(context, callbacks);
 *
 * // During streaming
 * handler.handleChunk(chunk);
 *
 * // When streaming completes
 * const result = await handler.handleFinish(finishData);
 * ```
 */
export class StreamingHandler {
  // ========== Text state ==========
  private output = '';

  // ========== Reasoning state ==========
  private thinkingContent = '';
  private thinkingStartAt?: number;
  private thinkingDuration?: number;
  private reasoningOperationId?: string;
  private reasoningParts: MessageContentPart[] = [];
  /** Once text/stop/usage/finish closes thinking, trailing reasoning must not restart it. */
  private reasoningClosed = false;

  // ========== Multimodal state ==========
  private contentParts: MessageContentPart[] = [];

  // ========== Tool call state ==========
  private isFunctionCall = false;
  private tools?: ChatToolPayload[];

  // ========== Generated file state ==========
  private files: ChatFileItem[] = [];
  private fileUploadTasks = new Map<string, Promise<ChatFileItem | undefined>>();
  /** temp chunk id -> persisted file, filled as soon as an upload completes */
  private uploadedFiles = new Map<string, ChatFileItem>();
  private limitFileUpload = createConcurrencyLimiter(FILE_UPLOAD_CONCURRENCY);

  // ========== Image upload state ==========
  private uploadTasks = new Map<string, Promise<{ id?: string; url?: string }>>();
  private contentImageUploads = new Map<number, Promise<string>>();
  private reasoningImageUploads = new Map<number, Promise<string>>();

  // ========== Other state ==========
  private msgTraceId?: string;
  private finishReason?: string;
  private finishType?: string;

  // ========== Throttled updates ==========
  private throttledUpdateToolCalls: ReturnType<typeof throttle>;

  constructor(
    private context: StreamingContext,
    private callbacks: StreamingCallbacks,
  ) {
    // Initialize throttled tool calls update (max once per 300ms)
    this.throttledUpdateToolCalls = throttle(
      (toolCalls) => {
        const tools = this.callbacks.transformToolCalls(toolCalls);
        this.callbacks.onToolCallsUpdate(tools);
      },
      300,
      { leading: true, trailing: true },
    );
  }

  // ==================== Public API ====================

  /**
   * Handle streaming chunk
   */
  handleChunk(chunk: StreamChunk): void {
    switch (chunk.type) {
      case 'text': {
        this.handleTextChunk(chunk);
        break;
      }
      case 'reasoning': {
        this.handleReasoningChunk(chunk);
        break;
      }
      case 'reasoning_part': {
        this.handleReasoningPartChunk(chunk);
        break;
      }
      case 'content_part': {
        this.handleContentPartChunk(chunk);
        break;
      }
      case 'tool_calls': {
        this.handleToolCallsChunk(chunk);
        break;
      }
      case 'grounding': {
        this.handleGroundingChunk(chunk);
        break;
      }
      case 'base64_image': {
        this.handleBase64ImageChunk(chunk);
        break;
      }
      case 'file': {
        this.handleFileChunk(chunk);
        break;
      }
      case 'stop': {
        this.handleStopChunk(chunk);
        break;
      }
      case 'usage': {
        this.endReasoningIfNeeded();
        break;
      }
    }
  }

  /**
   * Handle streaming finish
   */
  async handleFinish(finishData: FinishData): Promise<StreamingResult> {
    // Close thinking before waiting on uploads — otherwise a reasoning-only
    // stream (or a provider that never emits `stop`) leaves "Thinking…" on
    // for the duration of image/file uploads.
    this.endReasoningIfNeeded();

    // Update traceId
    if (finishData.traceId) {
      this.msgTraceId = finishData.traceId;
    }

    // Wait for all image uploads to complete
    const finalImages = await this.waitForImageUploads();

    // Wait for all generated file uploads to complete
    const finalFiles = await this.waitForFileUploads();

    // Wait for multimodal image uploads to complete
    await this.waitForMultimodalUploads();

    // Process final tool calls
    this.processFinalToolCalls(finishData.toolCalls);

    // Build final result
    return this.buildFinalResult(finishData, finalImages, finalFiles);
  }

  /**
   * Get current output content
   */
  getOutput(): string {
    return this.output;
  }

  /**
   * Get reasoning duration
   */
  getThinkingDuration(): number | undefined {
    return this.thinkingDuration;
  }

  /**
   * Check if this is a function call
   */
  getIsFunctionCall(): boolean {
    return this.isFunctionCall;
  }

  /**
   * Get tools
   */
  getTools(): ChatToolPayload[] | undefined {
    return this.tools;
  }

  /**
   * Get trace ID
   */
  getTraceId(): string | undefined {
    return this.msgTraceId;
  }

  /**
   * Get finish type
   */
  getFinishType(): string | undefined {
    return this.finishType;
  }

  // ==================== Chunk handling methods ====================

  private handleTextChunk(chunk: { text: string; type: 'text' }): void {
    this.output += chunk.text;

    // Clean speaker tag that may be reproduced by model in group chat
    this.output = cleanSpeakerTag(this.output);

    // End reasoning timing
    this.endReasoningIfNeeded();

    log(
      '[text stream] messageId=%s, output length=%d, operationId=%s',
      this.context.messageId,
      this.output.length,
      this.context.operationId,
    );

    // Notify update
    this.callbacks.onContentUpdate(this.output, this.buildReasoningState());
  }

  private handleReasoningChunk(chunk: { text: string; type: 'reasoning' }): void {
    // Start reasoning timing
    this.startReasoningIfNeeded();

    this.thinkingContent += chunk.text;

    this.callbacks.onReasoningUpdate({ content: this.thinkingContent });
  }

  private handleReasoningPartChunk(chunk: {
    content: string;
    mimeType?: string;
    partType: 'text' | 'image';
    type: 'reasoning_part';
  }): void {
    // Start reasoning timing
    this.startReasoningIfNeeded();

    if (chunk.partType === 'text') {
      this.appendTextToReasoningParts(chunk.content);
      this.thinkingContent += chunk.content;
    } else if (chunk.partType === 'image' && chunk.mimeType) {
      this.appendImageToReasoningParts(chunk.content, chunk.mimeType);
    }

    // Notify update
    const hasImages = this.reasoningParts.some((p) => p.type === 'image');
    this.callbacks.onReasoningUpdate(
      hasImages
        ? { isMultimodal: true, tempDisplayContent: this.reasoningParts }
        : { content: this.thinkingContent },
    );
  }

  private handleContentPartChunk(chunk: {
    content: string;
    mimeType?: string;
    partType: 'text' | 'image';
    type: 'content_part';
  }): void {
    // End reasoning timing
    this.endReasoningIfNeeded();

    if (chunk.partType === 'text') {
      this.appendTextToContentParts(chunk.content);
      this.output += chunk.content;

      // Clean speaker tag
      this.output = cleanSpeakerTag(this.output);
    } else if (chunk.partType === 'image' && chunk.mimeType) {
      this.appendImageToContentParts(chunk.content, chunk.mimeType);
    }

    // Notify update
    this.notifyContentPartUpdate();
  }

  private handleToolCallsChunk(chunk: {
    isAnimationActives?: boolean[];
    tool_calls: MessageToolCall[];
    type: 'tool_calls';
  }): void {
    this.isFunctionCall = true;
    this.callbacks.toggleToolCallingStreaming(this.context.messageId, chunk.isAnimationActives);
    this.throttledUpdateToolCalls(chunk.tool_calls);

    // End reasoning timing
    this.endReasoningIfNeeded();
  }

  private handleGroundingChunk(chunk: { grounding?: GroundingData; type: 'grounding' }): void {
    const { grounding } = chunk;
    if (
      !grounding?.citations?.length &&
      !grounding?.imageResults?.length &&
      !grounding?.searchQueries?.length
    )
      return;

    this.callbacks.onGroundingUpdate(grounding);
  }

  private handleBase64ImageChunk(chunk: {
    image: { data: string; id: string };
    images: { data: string; id: string }[];
    type: 'base64_image';
  }): void {
    // Immediately display images
    this.callbacks.onImagesUpdate(chunk.images.map((i) => ({ alt: i.id, id: i.id, url: i.data })));

    // Async upload
    const task = this.callbacks.uploadBase64Image(chunk.image.data);
    this.uploadTasks.set(chunk.image.id, task);
  }

  /**
   * Handle a generated (non-image) file produced by the model runtime.
   *
   * Mirrors `handleBase64ImageChunk`: show an optimistic entry immediately, then
   * upload the bytes in the background and swap in the persisted file id / url.
   */
  private handleFileChunk(chunk: {
    file: {
      data: string;
      id: string;
      mimeType: string;
      name: string;
      size?: number;
      sourcePath?: string;
    };
    type: 'file';
  }): void {
    const { file } = chunk;
    if (!file?.data) return;

    // Optimistic entry — the data URI is intentionally NOT used as `url` to
    // avoid keeping a second copy of the bytes in the store.
    const tempItem: ChatFileItem = {
      fileType: file.mimeType,
      id: file.id,
      name: file.name,
      size: file.size ?? 0,
      url: '',
    };

    this.files = [...this.files, tempItem];
    this.callbacks.onFilesUpdate?.(this.files);

    const uploadBase64File = this.callbacks.uploadBase64File;
    if (!uploadBase64File) return;

    // The optimistic card is shown immediately, but the upload itself is queued:
    // at most FILE_UPLOAD_CONCURRENCY uploads run at the same time.
    const task = this.limitFileUpload(async () => {
      // Queued-but-not-started uploads are skipped when the user stopped the answer.
      if (this.context.abortSignal?.aborted) {
        log(
          '[file] upload skipped, operation aborted messageId=%s, name=%s',
          this.context.messageId,
          tempItem.name,
        );
        this.removeFile(tempItem.id);
        return undefined;
      }

      const uploaded = await uploadBase64File(file.data, {
        filename: file.name,
        mimeType: file.mimeType,
        signal: this.context.abortSignal,
      });

      if (!uploaded?.id || !uploaded?.url) throw new Error('Upload returned no file');

      const finalItem: ChatFileItem = { ...tempItem, id: uploaded.id, url: uploaded.url };

      this.files = this.files.map((item) => (item.id === tempItem.id ? finalItem : item));
      this.uploadedFiles.set(tempItem.id, finalItem);
      this.callbacks.onFilesUpdate?.(this.files);

      return finalItem;
    }).catch((error) => {
      this.handleFileUploadFailure(tempItem, error);
      return undefined;
    });

    this.fileUploadTasks.set(file.id, task);
  }

  /**
   * An upload failed: drop the optimistic card (it can never resolve to a real
   * file) and let the caller surface it — unless the user aborted, which is not
   * an error worth a toast.
   */
  private handleFileUploadFailure(tempItem: ChatFileItem, error: unknown): void {
    this.removeFile(tempItem.id);

    if (this.context.abortSignal?.aborted) {
      log('[file] upload cancelled messageId=%s, name=%s', this.context.messageId, tempItem.name);
      return;
    }

    log(
      '[file] upload failed messageId=%s, name=%s, error=%o',
      this.context.messageId,
      tempItem.name,
      error,
    );

    this.callbacks.onFileUploadError?.({ error, name: tempItem.name });
  }

  private removeFile(id: string): void {
    if (!this.files.some((item) => item.id === id)) return;

    this.files = this.files.filter((item) => item.id !== id);
    this.callbacks.onFilesUpdate?.(this.files);
  }

  private handleStopChunk(chunk: { reason?: string; type: 'stop' }): void {
    if (typeof chunk.reason === 'string' && chunk.reason && !this.finishReason) {
      this.finishReason = chunk.reason;
    }
    this.endReasoningIfNeeded();
  }

  // ==================== Helper methods ====================

  private startReasoningIfNeeded(): void {
    if (this.reasoningClosed) return;

    if (!this.thinkingStartAt) {
      this.thinkingStartAt = Date.now();
      this.reasoningOperationId = this.callbacks.onReasoningStart();
    }
  }

  private endReasoningIfNeeded(): void {
    this.reasoningClosed = true;

    if (this.thinkingStartAt && !this.thinkingDuration) {
      this.thinkingDuration = Date.now() - this.thinkingStartAt;

      if (this.reasoningOperationId) {
        this.callbacks.onReasoningComplete(this.reasoningOperationId);
        this.reasoningOperationId = undefined;
      }
    }
  }

  private appendTextToReasoningParts(text: string): void {
    const lastPart = this.reasoningParts.at(-1);
    if (lastPart?.type === 'text') {
      this.reasoningParts = [
        ...this.reasoningParts.slice(0, -1),
        { text: lastPart.text + text, type: 'text' },
      ];
    } else {
      this.reasoningParts = [...this.reasoningParts, { text, type: 'text' }];
    }
  }

  private appendImageToReasoningParts(base64Content: string, mimeType: string): void {
    const tempImage = `data:${mimeType};base64,${base64Content}`;
    const partIndex = this.reasoningParts.length;
    this.reasoningParts = [...this.reasoningParts, { image: tempImage, type: 'image' }];

    // Async upload
    const uploadTask = this.callbacks
      .uploadBase64Image(tempImage)
      .then((file) => {
        const url = file?.url || tempImage;
        const updatedParts = [...this.reasoningParts];
        updatedParts[partIndex] = { image: url, type: 'image' };
        this.reasoningParts = updatedParts;
        return url;
      })
      .catch((error) => {
        console.error('[reasoning_part] Image upload failed:', error);
        return tempImage;
      });

    this.reasoningImageUploads.set(partIndex, uploadTask);
  }

  private appendTextToContentParts(text: string): void {
    const lastPart = this.contentParts.at(-1);
    if (lastPart?.type === 'text') {
      this.contentParts = [
        ...this.contentParts.slice(0, -1),
        { text: lastPart.text + text, type: 'text' },
      ];
    } else {
      this.contentParts = [...this.contentParts, { text, type: 'text' }];
    }
  }

  private appendImageToContentParts(base64Content: string, mimeType: string): void {
    const tempImage = `data:${mimeType};base64,${base64Content}`;
    const partIndex = this.contentParts.length;
    this.contentParts = [...this.contentParts, { image: tempImage, type: 'image' }];

    // Async upload
    const uploadTask = this.callbacks
      .uploadBase64Image(tempImage)
      .then((file) => {
        const url = file?.url || tempImage;
        const updatedParts = [...this.contentParts];
        updatedParts[partIndex] = { image: url, type: 'image' };
        this.contentParts = updatedParts;
        return url;
      })
      .catch((error) => {
        console.error('[content_part] Image upload failed:', error);
        return tempImage;
      });

    this.contentImageUploads.set(partIndex, uploadTask);
  }

  private notifyContentPartUpdate(): void {
    const hasContentImages = this.contentParts.some((p) => p.type === 'image');
    const hasReasoningImages = this.reasoningParts.some((p) => p.type === 'image');

    this.callbacks.onContentUpdate(
      this.output,
      hasReasoningImages
        ? {
            duration: this.thinkingDuration,
            isMultimodal: true,
            tempDisplayContent: this.reasoningParts,
          }
        : this.thinkingContent
          ? { content: this.thinkingContent, duration: this.thinkingDuration }
          : undefined,
      hasContentImages
        ? {
            isMultimodal: true,
            tempDisplayContent: serializePartsForStorage(this.contentParts),
          }
        : undefined,
    );
  }

  private buildReasoningState(): ReasoningState | undefined {
    if (!this.thinkingContent) return undefined;
    return { content: this.thinkingContent, duration: this.thinkingDuration };
  }

  private async waitForImageUploads(): Promise<ChatImageItem[]> {
    if (this.uploadTasks.size === 0) return [];

    try {
      const results = await pMap(Array.from(this.uploadTasks.values()), (task) => task, {
        concurrency: 5,
      });
      return results.filter((i) => !!i.url) as ChatImageItem[];
    } catch (error) {
      console.error('Error waiting for image uploads:', error);
      return [];
    }
  }

  /**
   * Collect the generated files to attach to the message.
   *
   * On abort we do NOT wait: queued uploads were skipped and in-flight ones are
   * cancelled through the signal. Uploads that already finished before the stop
   * are still attached on purpose — the file rows exist, so hiding them would
   * leave orphans the user can't reach.
   */
  private async waitForFileUploads(): Promise<ChatFileItem[]> {
    if (this.fileUploadTasks.size === 0) return [];

    if (this.context.abortSignal?.aborted) {
      log(
        '[file] aborted, attaching %d already-uploaded file(s) messageId=%s',
        this.uploadedFiles.size,
        this.context.messageId,
      );
      return this.collectUploadedFiles();
    }

    try {
      // Each task already resolves (failures are swallowed into `undefined`),
      // and concurrency is enforced at chunk time by `limitFileUpload`.
      await Promise.all(Array.from(this.fileUploadTasks.values()));
    } catch (error) {
      log(
        '[file] error waiting for file uploads messageId=%s, error=%o',
        this.context.messageId,
        error,
      );
    }

    return this.collectUploadedFiles();
  }

  /** Uploaded files in chunk arrival order (the map is keyed by temp chunk id). */
  private collectUploadedFiles(): ChatFileItem[] {
    return Array.from(this.fileUploadTasks.keys())
      .map((id) => this.uploadedFiles.get(id))
      .filter((item): item is ChatFileItem => !!item?.url);
  }

  private async waitForMultimodalUploads(): Promise<void> {
    await Promise.allSettled([
      ...Array.from(this.contentImageUploads.values()),
      ...Array.from(this.reasoningImageUploads.values()),
    ]);
  }

  private processFinalToolCalls(toolCalls?: MessageToolCall[]): void {
    if (!toolCalls?.length) return;

    this.throttledUpdateToolCalls.flush();
    this.callbacks.toggleToolCallingStreaming(this.context.messageId, undefined);

    const processedToolCalls = toolCalls.map((item) => ({
      ...item,
      function: {
        ...item.function,
        arguments: item.function.arguments || '{}',
      },
    }));

    const resolved = this.callbacks.transformToolCalls(processedToolCalls);

    // Silent-drop guard: the model emitted tool_calls but every name failed to
    // resolve (e.g. missing `____` prefix the resolver couldn't recover from).
    // Without this log the operation would finish as "completed without tool
    // calls" even though the user's intent was lost. See .
    if (resolved.length < processedToolCalls.length) {
      const resolvedKeys = new Set(resolved.map((t) => t.id));
      const unresolved = processedToolCalls
        .filter((t) => !resolvedKeys.has(t.id))
        .map((t) => t.function.name);
      log(
        '[processFinalToolCalls] unresolved tool_call names messageId=%s, operationId=%s, names=%o',
        this.context.messageId,
        this.context.operationId,
        unresolved,
      );
    }

    this.tools = resolved;
    this.isFunctionCall = true;
  }

  private buildFinalResult(
    finishData: FinishData,
    finalImages: ChatImageItem[],
    finalFiles: ChatFileItem[] = [],
  ): StreamingResult {
    const hasContentImages = this.contentParts.some((p) => p.type === 'image');
    const hasReasoningImages = this.reasoningParts.some((p) => p.type === 'image');

    // Determine final content
    const finalContent = hasContentImages
      ? serializePartsForStorage(this.contentParts)
      : this.output;

    // Determine final reasoning content
    const finalDuration =
      this.thinkingDuration && !isNaN(this.thinkingDuration) ? this.thinkingDuration : undefined;

    // Get signature from finishData.reasoning (provided by backend in onFinish)
    const reasoningSignature = finishData.reasoning?.signature;
    // Hidden Responses reasoning items stay replayable without any visible content
    const hasResponseItems = !!finishData.reasoning?.responseItems?.length;

    let finalReasoning: ReasoningState | undefined;
    if (hasReasoningImages) {
      finalReasoning = {
        content: serializePartsForStorage(this.reasoningParts),
        duration: finalDuration,
        isMultimodal: true,
        signature: reasoningSignature,
      };
    } else if (this.thinkingContent) {
      finalReasoning = {
        ...finishData.reasoning,
        content: this.thinkingContent,
        duration: finalDuration,
      };
    } else if (finishData.reasoning?.content || reasoningSignature || hasResponseItems) {
      finalReasoning = {
        ...finishData.reasoning,
        duration: finalDuration,
      };
    }

    this.finishType = finishData.type;
    const finishReason = finishData.finishReason || this.finishReason;
    if (finishReason) this.finishReason = finishReason;

    log(
      '[handleFinish] messageId=%s, finishType=%s, finishReason=%s, operationId=%s',
      this.context.messageId,
      finishData.type,
      finishReason,
      this.context.operationId,
    );

    return {
      content: finalContent,
      finishType: finishData.type,
      isFunctionCall: this.isFunctionCall,
      metadata: {
        fileList: finalFiles.length > 0 ? finalFiles : undefined,
        ...(finishReason && { finishReason }),
        finishType: finishData.type,
        imageList: finalImages.length > 0 ? finalImages : undefined,
        isMultimodal: hasContentImages || undefined,
        performance: finishData.speed,
        reasoning: finalReasoning,
        search:
          finishData.grounding?.citations?.length || finishData.grounding?.imageResults?.length
            ? finishData.grounding
            : undefined,
        usage: finishData.usage,
      },
      toolCalls: finishData.toolCalls,
      tools: this.tools,
      traceId: this.msgTraceId,
      usage: finishData.usage,
    };
  }
}
