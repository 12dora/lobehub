import type {
  OpenAIChatMessage,
  UserMessageContentPart,
  UserMessageContentPartFile,
} from '../../types';
import { fileUrlPartPlaceholder, isFileUrlPart, isFileUrlTypedPart } from '../../types/chat';
import { parseDataUri } from '../../utils/uriParser';
import { assertBoundedBase64, extensionFor, fetchBytes } from './assetDownload';
import type { ChatGPTWebClient } from './client';
import { base64ToBytes } from './client';
import { readImageDimensions } from './imageDimensions';
import { toAttachmentRef } from './turnHelpers';
import type { AttachmentRef, ChatGPTWebMessage } from './types';
import { getCachedUpload, setCachedUpload, uploadCacheKey } from './uploadCache';

interface BuildMessagesOptions {
  client: ChatGPTWebClient;
  logUploadFailure: (kind: 'document' | 'image', error: unknown) => void;
  signal?: AbortSignal;
  uploadNamespace?: string;
}

interface BuiltMessages {
  echoHistory: string[];
  inputText: string;
  messages: ChatGPTWebMessage[];
  mimeTypes: string[];
}

interface BuiltContent {
  attachments: AttachmentRef[];
  text: string;
}

export const buildChatGPTWebMessages = async (
  source: OpenAIChatMessage[],
  options: BuildMessagesOptions,
): Promise<BuiltMessages> => {
  const messages: ChatGPTWebMessage[] = [];
  const echoHistory: string[] = [];
  const inputParts: string[] = [];
  const mimeTypes = new Set<string>();
  /** System instructions waiting to be folded into the user turn they precede. */
  const pendingInstructions: string[] = [];
  let imageIndex = 0;

  const pushMessage = (message: ChatGPTWebMessage) => {
    if (message.content) inputParts.push(message.content);
    messages.push(message);
  };
  /**
   * Emit the buffered instructions as the user turn they now are, at the
   * position the caller put them. Instructions may never cross an assistant
   * turn to reach a later user message because that reorders the conversation.
   */
  const flushInstructions = () => {
    if (pendingInstructions.length === 0) return;
    pushMessage({ content: pendingInstructions.join('\n\n'), role: 'user' });
    pendingInstructions.length = 0;
  };

  for (const message of source) {
    const { attachments, text } = await buildContent(message.content, options, () => {
      imageIndex += 1;
      return imageIndex;
    });
    if (!text && attachments.length === 0) continue;

    /**
     * Browser sessions never author freeform `system` turns: their instructions
     * travel out of band. Fold ours into the immediately following user turn so
     * the body keeps the user/assistant shape chatgpt.com sends. A system message
     * carrying attachments must fall through so its files are not dropped.
     */
    if (message.role === 'system' && attachments.length === 0) {
      if (text) pendingInstructions.push(text);
      continue;
    }

    const role = message.role === 'assistant' ? 'assistant' : 'user';
    if (role === 'assistant') flushInstructions();
    for (const attachment of attachments) mimeTypes.add(attachment.mimeType);
    if (role === 'assistant' && text) echoHistory.push(text);

    let content = text;
    if (role === 'user' && pendingInstructions.length > 0) {
      content = [...pendingInstructions, text].filter(Boolean).join('\n\n');
      pendingInstructions.length = 0;
    }
    pushMessage({
      attachments: attachments.length > 0 ? attachments : undefined,
      content,
      role,
    });
  }

  // A trailing system message (e.g. the force-finish injector) still has to reach the model.
  flushInstructions();
  return { echoHistory, inputText: inputParts.join('\n\n'), messages, mimeTypes: [...mimeTypes] };
};

const buildContent = async (
  content: OpenAIChatMessage['content'],
  options: BuildMessagesOptions,
  nextImageIndex: () => number,
): Promise<BuiltContent> => {
  if (typeof content === 'string') return { attachments: [], text: content };

  const attachments: AttachmentRef[] = [];
  const texts: string[] = [];
  for (const part of (content ?? []) as UserMessageContentPart[]) {
    if (isFileUrlTypedPart(part)) {
      // A malformed `file_url` part must never reach the wire.
      if (!isFileUrlPart(part)) {
        texts.push(fileUrlPartPlaceholder(part));
        continue;
      }
      const attachment = await uploadDocumentPart(part.file_url, options);
      if (attachment) attachments.push(attachment);
      else if (part.file_url.content)
        texts.push(`[Attached file: ${part.file_url.name}]\n${part.file_url.content}`);
      // No parsed content to fall back on: preserve the shared placeholder contract.
      else texts.push(fileUrlPartPlaceholder(part));
      continue;
    }

    if (part.type === 'text') {
      if (part.text) texts.push(part.text);
    } else if (part.type === 'image_url') {
      const attachment = await uploadImagePart(part.image_url.url, nextImageIndex(), options);
      if (attachment) attachments.push(attachment);
      else texts.push('[image omitted: upload failed]');
    }
    // Thinking blocks are internal; audio/video are unsupported upstream.
  }
  return { attachments, text: texts.join('\n\n') };
};

const uploadImagePart = async (
  url: string,
  index: number,
  options: BuildMessagesOptions,
): Promise<AttachmentRef | undefined> => {
  try {
    const parsed = parseDataUri(url);
    let bytes: Uint8Array;
    let mimeType: string | undefined;
    if (parsed.type === 'base64' && parsed.base64) {
      assertBoundedBase64(parsed.base64, 'image');
      bytes = base64ToBytes(parsed.base64);
      mimeType = parsed.mimeType ?? undefined;
    } else {
      // Deliberately not `imageUrlToBase64`: that helper is unbounded and ignores the signal.
      const downloaded = await fetchBytes(url, options.signal);
      bytes = downloaded.bytes;
      mimeType = downloaded.mimeType;
    }

    const dimensions = readImageDimensions(bytes);
    const resolvedMime = dimensions?.mimeType ?? mimeType ?? 'image/png';
    const name = `image_${index}.${extensionFor(resolvedMime)}`;
    const key = uploadCacheKey(options.uploadNamespace, bytes);
    const cached = getCachedUpload(key);
    if (cached) return toAttachmentRef(cached, name);

    const uploaded = await options.client.uploadFile(
      bytes,
      {
        height: dimensions?.height,
        kind: 'image',
        mimeType: resolvedMime,
        name,
        width: dimensions?.width,
      },
      { signal: options.signal },
    );
    setCachedUpload(key, uploaded);
    return toAttachmentRef(uploaded, name);
  } catch (error) {
    options.logUploadFailure('image', error);
    return undefined;
  }
};

const uploadDocumentPart = async (
  file: UserMessageContentPartFile['file_url'],
  options: BuildMessagesOptions,
): Promise<AttachmentRef | undefined> => {
  try {
    const parsed = parseDataUri(file.url);
    let downloaded: { bytes: Uint8Array; mimeType?: string };
    if (parsed.type === 'base64' && parsed.base64) {
      assertBoundedBase64(parsed.base64, 'attachment');
      downloaded = { bytes: base64ToBytes(parsed.base64), mimeType: parsed.mimeType ?? undefined };
    } else downloaded = await fetchBytes(file.url, options.signal);

    const resolvedMime = file.mimeType || downloaded.mimeType || 'application/octet-stream';
    const key = uploadCacheKey(options.uploadNamespace, downloaded.bytes);
    const cached = getCachedUpload(key);
    if (cached) return toAttachmentRef(cached, file.name);

    const uploaded = await options.client.uploadFile(
      downloaded.bytes,
      { kind: 'document', mimeType: resolvedMime, name: file.name },
      { signal: options.signal },
    );
    // Documents are indexed asynchronously; attaching one too early yields empty retrieval.
    const ready = await options.client.waitForFileReady(uploaded.fileId, {
      signal: options.signal,
    });
    const ref = { ...uploaded, fileTokenSize: ready.fileTokenSize };
    setCachedUpload(key, ref);
    return toAttachmentRef(ref, file.name);
  } catch (error) {
    options.logUploadFailure('document', error);
    return undefined;
  }
};
