import {
  PAGE_IMAGES_SHOWN_EARLIER,
  parseDocumentPageImageMarkers,
  replaceDocumentPageImageMarkers,
} from '@lobechat/builtin-tool-document-pages';
import type { OpenAIChatMessage, UserMessageContentPart } from '@lobechat/model-runtime';
import { isFileUrlPart } from '@lobechat/model-runtime';
import { DOCUMENT_RENDER_DEFAULTS } from '@lobechat/types';
import type { OwnDeploymentOrigins } from '@lobechat/utils';
import {
  DEFAULT_FILE_INLINE_MAX_BYTES,
  DEFAULT_IMAGE_INLINE_MAX_BYTES,
} from '@lobechat/utils/imageToBase64';
import debug from 'debug';

import type {
  FilesInfoImageOnlyPdf,
  PdfTextKind,
  RasterizedPdfImages,
} from './attachmentInlinerPdf';
import {
  artifactToDataUri,
  collectImageOnlyPdfsFromFilesInfo,
  IMAGE_ONLY_PDF_MAX_IMAGES_PER_MESSAGE,
  imageOnlyPdfNotice,
  isArtifactKeyForFile,
  isPdfBytes,
  markImageOnlyPdfInFilesInfo,
  pdfTextKind,
  rasterizeImageOnlyPdf,
  selectRasterizedImages,
  setToolMessageText,
  toolMessageText,
} from './attachmentInlinerPdf';
import type {
  InlineOwnOriginAttachmentsOptions,
  OwnOriginAttachmentBytes,
  OwnOriginAttachmentResolver,
} from './attachmentInlinerTypes';
import {
  applyInlinedUrl,
  collectFileUrlFileIds,
  collectOwnOriginAttachmentUrls,
  countImageUrlParts,
  isImageUrlPart,
  resolveUniqueUrls,
  stripOwnOriginUrlAttributesInFilesInfo,
} from './attachmentInlinerUrls';
import { collectAttachedDocumentFiles, collectUserText, selectDocumentFeed } from './documentFeed';
import { bumpDocumentFeedStat } from './documentFeedStats';

const log = debug('lobe-server:attachment-inliner');
const PAYLOAD_MAX_RASTERIZED_PDFS = 2;

interface ImageBudget {
  remaining: number;
}

interface PipelineContext {
  authorizeFile?: (fileId: string) => Promise<boolean>;
  fedFileIds: Set<string>;
  fileBytesMemo: Map<string, Promise<OwnOriginAttachmentBytes | null>>;
  fileMaxBytes: number;
  imageBudget: ImageBudget;
  imageMaxBytes: number;
  lastUserMessageIndex: number;
  loadArtifact?: (key: string, fileId: string) => Promise<Uint8Array | null>;
  loadRender?: InlineOwnOriginAttachmentsOptions['loadRender'];
  loadTextIndex?: InlineOwnOriginAttachmentsOptions['loadTextIndex'];
  maxDocsPerRequest: number;
  messages: OpenAIChatMessage[];
  rasterBudget: { pdfsRemaining: number };
  rasterMemo: Map<string, Promise<RasterizedPdfImages>>;
  resolveByFileId?: InlineOwnOriginAttachmentsOptions['resolveByFileId'];
  resolvedByUrl: Map<string, OwnOriginAttachmentBytes | null>;
  tools: boolean;
}

const recordDocumentFeedStats = (
  fedFileIds: string[],
  attachedImageCount: number,
  notices: string[],
) => {
  if (fedFileIds.length > 0) bumpDocumentFeedStat('docsFed', fedFileIds.length);
  if (attachedImageCount > 0) {
    bumpDocumentFeedStat('imagesFed', attachedImageCount);
    bumpDocumentFeedStat('requestsWithImages');
  }
  const pendingNoticeCount = notices.filter((notice) =>
    notice.includes('text only this turn'),
  ).length;
  if (pendingNoticeCount > 0) bumpDocumentFeedStat('pendingFallbacks', pendingNoticeCount);
};

const findLastUserMessageIndex = (messages: OpenAIChatMessage[]): number => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return index;
  }
  return -1;
};

const stripFilesInfoUrls = (messages: OpenAIChatMessage[], ownOrigins: OwnDeploymentOrigins) => {
  for (const message of messages) {
    if (message.role !== 'user') continue;
    if (typeof message.content === 'string') {
      message.content = stripOwnOriginUrlAttributesInFilesInfo(message.content, ownOrigins);
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === 'text') {
        part.text = stripOwnOriginUrlAttributesInFilesInfo(part.text, ownOrigins);
      }
    }
  }
};

const createPipelineContext = async (
  messages: OpenAIChatMessage[],
  resolver: OwnOriginAttachmentResolver,
  ownOrigins: OwnDeploymentOrigins,
  options?: InlineOwnOriginAttachmentsOptions,
): Promise<PipelineContext> => {
  const imageMaxBytes = options?.imageMaxBytes ?? DEFAULT_IMAGE_INLINE_MAX_BYTES;
  const imageMaxCount = options?.imageMaxCount ?? IMAGE_ONLY_PDF_MAX_IMAGES_PER_MESSAGE;
  const fileMaxBytes = options?.fileMaxBytes ?? DEFAULT_FILE_INLINE_MAX_BYTES;
  stripFilesInfoUrls(messages, ownOrigins);
  const maxBytesByUrl = collectOwnOriginAttachmentUrls(messages, ownOrigins, {
    fileMaxBytes,
    imageMaxBytes,
  });
  const resolvedByUrl =
    maxBytesByUrl.size === 0
      ? new Map<string, OwnOriginAttachmentBytes | null>()
      : await resolveUniqueUrls(maxBytesByUrl, resolver);
  const lastUserMessageIndex = findLastUserMessageIndex(messages);

  return {
    authorizeFile: options?.authorizeFile,
    fedFileIds: new Set<string>(),
    fileBytesMemo: new Map<string, Promise<OwnOriginAttachmentBytes | null>>(),
    fileMaxBytes,
    imageBudget: {
      remaining: Math.max(0, imageMaxCount - countImageUrlParts(messages[lastUserMessageIndex])),
    },
    imageMaxBytes,
    lastUserMessageIndex,
    loadArtifact: options?.loadArtifact,
    loadRender: options?.loadRender,
    loadTextIndex: options?.loadTextIndex,
    maxDocsPerRequest: options?.maxDocsPerRequest ?? DOCUMENT_RENDER_DEFAULTS.maxDocsPerRequest,
    messages,
    rasterBudget: { pdfsRemaining: PAYLOAD_MAX_RASTERIZED_PDFS },
    rasterMemo: new Map<string, Promise<RasterizedPdfImages>>(),
    resolveByFileId: options?.resolveByFileId,
    resolvedByUrl,
    tools: options?.tools ?? true,
  };
};

const loadFileBytes = async (
  context: PipelineContext,
  fileId: string,
): Promise<OwnOriginAttachmentBytes | null> => {
  if (!context.resolveByFileId) return null;
  let pending = context.fileBytesMemo.get(fileId);
  if (!pending) {
    pending = (async () => {
      try {
        return await context.resolveByFileId!(fileId, context.fileMaxBytes);
      } catch (error) {
        log(
          'failed to resolve attachment id=%s error=%s',
          fileId,
          error instanceof Error ? error.message : error,
        );
        return null;
      }
    })();
    context.fileBytesMemo.set(fileId, pending);
  }
  const resolved = await pending;
  if (!resolved) return null;
  if (resolved.bytes.byteLength > context.fileMaxBytes) {
    log(
      'skip over-cap attachment id=%s size=%d max=%d',
      fileId,
      resolved.bytes.byteLength,
      context.fileMaxBytes,
    );
    return null;
  }
  return resolved;
};

const appendRasterizedPages = async (
  context: PipelineContext,
  next: UserMessageContentPart[],
  input: {
    allowRender: boolean;
    bytes: Uint8Array;
    imageSlots: ImageBudget;
    memoKey: string;
    name: string;
    textKind: Exclude<PdfTextKind, 'rich'>;
  },
): Promise<boolean> => {
  const remaining = input.imageSlots.remaining;
  if (remaining <= 0) return false;

  let pending = context.rasterMemo.get(input.memoKey);
  if (!pending) {
    if (!input.allowRender || context.rasterBudget.pdfsRemaining <= 0) return false;
    context.rasterBudget.pdfsRemaining -= 1;
    pending = rasterizeImageOnlyPdf(input.bytes, context.imageMaxBytes).finally(() => {
      // Keep only data URIs in rasterMemo; drop the raw PDF buffer.
      context.fileBytesMemo.delete(input.memoKey);
    });
    context.rasterMemo.set(input.memoKey, pending);
  }

  const { images } = await pending;
  const used = selectRasterizedImages(images, remaining);
  if (used.length === 0) return false;
  const tilesAttached = used.some((image) => image.kind === 'tile');
  for (const image of used) {
    next.push({ image_url: { detail: 'high', url: image.dataUri }, type: 'image_url' });
  }
  next.push({ text: imageOnlyPdfNotice(input.name, tilesAttached, input.textKind), type: 'text' });
  input.imageSlots.remaining -= used.length;
  return true;
};

const applyInlinedParts = async (context: PipelineContext, role: 'assistant' | 'user') => {
  for (let index = 0; index < context.messages.length; index += 1) {
    const message = context.messages[index];
    if (!message || message.role !== role || !Array.isArray(message.content)) continue;
    const allowRender = role === 'user' && index === context.lastUserMessageIndex;
    const imageSlots = allowRender ? context.imageBudget : { remaining: 0 };
    const next: UserMessageContentPart[] = [];

    for (const part of message.content) {
      if (isImageUrlPart(part)) {
        const url = part.image_url.url;
        if (context.resolvedByUrl.has(url)) {
          part.image_url.url = applyInlinedUrl(
            url,
            context.resolvedByUrl.get(url) ?? null,
            context.imageMaxBytes,
          );
        }
        next.push(part);
        continue;
      }
      if (!isFileUrlPart(part)) {
        next.push(part);
        continue;
      }

      const url = part.file_url.url;
      const resolved = context.resolvedByUrl.has(url)
        ? (context.resolvedByUrl.get(url) ?? null)
        : null;
      if (context.resolvedByUrl.has(url)) {
        part.file_url.url = applyInlinedUrl(url, resolved, context.fileMaxBytes);
      }
      next.push(part);
      if (!resolved || resolved.bytes.byteLength > context.fileMaxBytes) continue;
      if (!isPdfBytes(part.file_url.mimeType, resolved.mimeType, resolved.bytes)) continue;
      const textKind = pdfTextKind(part.file_url.content);
      if (textKind === 'rich') continue;
      const memoKey = part.file_url.fileId ?? url;
      if (context.fedFileIds.has(part.file_url.fileId ?? '') || context.fedFileIds.has(memoKey))
        continue;
      await appendRasterizedPages(context, next, {
        allowRender,
        bytes: resolved.bytes,
        imageSlots,
        memoKey,
        name: part.file_url.name,
        textKind,
      });
    }
    message.content = next;
  }
};

const collectFilesInfoCandidates = (
  context: PipelineContext,
  content: OpenAIChatMessage['content'],
): FilesInfoImageOnlyPdf[] | undefined => {
  const texts: string[] = [];
  if (typeof content === 'string') {
    if (!content.includes('<files_info>')) return undefined;
    texts.push(content);
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (part.type === 'text' && part.text.includes('<files_info>')) texts.push(part.text);
    }
    if (texts.length === 0) return undefined;
  } else return undefined;

  const handled = Array.isArray(content) ? collectFileUrlFileIds(content) : new Set<string>();
  const candidates: FilesInfoImageOnlyPdf[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    for (const pdf of collectImageOnlyPdfsFromFilesInfo(text)) {
      if (handled.has(pdf.fileId) || seen.has(pdf.fileId) || context.fedFileIds.has(pdf.fileId))
        continue;
      seen.add(pdf.fileId);
      candidates.push(pdf);
    }
  }
  return candidates;
};

const appendFilesInfoPdf = async (
  context: PipelineContext,
  next: UserMessageContentPart[],
  pdf: FilesInfoImageOnlyPdf,
): Promise<boolean> => {
  const resolved = await loadFileBytes(context, pdf.fileId);
  try {
    if (!resolved || !isPdfBytes(undefined, resolved.mimeType, resolved.bytes)) return false;
    const didAppend = await appendRasterizedPages(context, next, {
      allowRender: true,
      bytes: resolved.bytes,
      imageSlots: context.imageBudget,
      memoKey: pdf.fileId,
      name: pdf.name,
      textKind: pdf.textKind,
    });
    if (didAppend && pdf.textKind === 'empty') {
      for (const part of next) {
        if (part.type === 'text' && part.text.includes('<files_info>')) {
          part.text = markImageOnlyPdfInFilesInfo(part.text, pdf.fileId);
        }
      }
    }
    return didAppend;
  } finally {
    context.fileBytesMemo.delete(pdf.fileId);
  }
};

const applyFilesInfoRasterization = async (context: PipelineContext) => {
  if (!context.resolveByFileId || context.lastUserMessageIndex < 0) return;
  const message = context.messages[context.lastUserMessageIndex];
  if (!message || message.role !== 'user') return;

  try {
    const content = message.content;
    const candidates = collectFilesInfoCandidates(context, content);
    if (!candidates || candidates.length === 0 || context.imageBudget.remaining <= 0) return;
    const next: UserMessageContentPart[] =
      typeof content === 'string' ? [{ text: content, type: 'text' }] : [...content];
    let appended = false;

    for (const pdf of candidates) {
      if (context.imageBudget.remaining <= 0) break;
      if (!context.rasterMemo.has(pdf.fileId) && context.rasterBudget.pdfsRemaining <= 0) break;
      appended = (await appendFilesInfoPdf(context, next, pdf)) || appended;
    }
    if (appended) message.content = next;
  } catch (error) {
    log(
      'files_info image-only PDF inline failed: %s',
      error instanceof Error ? error.message : error,
    );
  }
};

const applyDocumentFeed = async (context: PipelineContext) => {
  if (!context.loadRender || context.lastUserMessageIndex < 0) return;
  const message = context.messages[context.lastUserMessageIndex];
  if (!message || message.role !== 'user') return;
  const files = collectAttachedDocumentFiles(message);
  if (files.length === 0) return;

  try {
    const feed = await selectDocumentFeed({
      files,
      imageMaxCount: context.imageBudget.remaining,
      loadRender: context.loadRender,
      loadTextIndex: context.loadTextIndex,
      maxDocsPerRequest: context.maxDocsPerRequest,
      tools: context.tools,
      userText: collectUserText(message),
    });
    // Page images only ride with the latest user turn; later tool-follow-ups
    // keep fedFileIds so live PDF rasterization is skipped.
    if (context.lastUserMessageIndex !== context.messages.length - 1) {
      for (const id of feed.fedFileIds) context.fedFileIds.add(id);
      return;
    }
    if (feed.images.length === 0 && feed.notices.length === 0) return;
    const next: UserMessageContentPart[] =
      typeof message.content === 'string'
        ? [{ text: message.content, type: 'text' }]
        : Array.isArray(message.content)
          ? [...message.content]
          : [];
    const attachedFileIds = new Set<string>();
    let attachedImageCount = 0;
    for (const image of feed.images) {
      if (!context.loadArtifact || context.imageBudget.remaining <= 0) break;
      if (!isArtifactKeyForFile(image.key, image.fileId)) {
        log('skip document-feed artifact outside prefix fileId=%s key=%s', image.fileId, image.key);
        continue;
      }
      try {
        const dataUri = artifactToDataUri(
          await context.loadArtifact(image.key, image.fileId),
          context.imageMaxBytes,
        );
        if (!dataUri) continue;
        next.push({ image_url: { detail: image.detail, url: dataUri }, type: 'image_url' });
        attachedFileIds.add(image.fileId);
        attachedImageCount += 1;
        context.imageBudget.remaining -= 1;
      } catch (error) {
        log(
          'document-feed artifact load failed key=%s error=%s',
          image.key,
          error instanceof Error ? error.message : error,
        );
      }
    }
    for (const id of attachedFileIds) context.fedFileIds.add(id);
    for (const notice of feed.notices) next.push({ text: notice, type: 'text' });
    message.content = next;
    recordDocumentFeedStats(feed.fedFileIds, attachedImageCount, feed.notices);
  } catch (error) {
    log('document feed failed: %s', error instanceof Error ? error.message : error);
  }
};

const collectToolMarkerIndexes = (messages: OpenAIChatMessage[]): number[] => {
  const markerIndexes: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || message.role !== 'tool') continue;
    const text = toolMessageText(message);
    if (text && parseDocumentPageImageMarkers(text).length > 0) markerIndexes.push(index);
  }
  return markerIndexes;
};

const injectToolPageImages = async (context: PipelineContext) => {
  if (!context.loadArtifact) return;
  const markerIndexes = collectToolMarkerIndexes(context.messages);
  if (markerIndexes.length === 0) return;
  const lastIndex = markerIndexes.at(-1)!;
  const isToolFollowUp = context.lastUserMessageIndex < lastIndex;
  for (const index of markerIndexes) {
    if (isToolFollowUp && index === lastIndex) continue;
    const message = context.messages[index];
    if (!message) continue;
    const text = toolMessageText(message);
    if (text)
      setToolMessageText(message, replaceDocumentPageImageMarkers(text, PAGE_IMAGES_SHOWN_EARLIER));
  }
  if (!isToolFollowUp) return;
  const last = context.messages[lastIndex];
  if (!last) return;
  const text = toolMessageText(last);
  if (!text) return;

  const markers = parseDocumentPageImageMarkers(text);
  const parts: UserMessageContentPart[] = [];
  const attachedPages: number[] = [];
  for (const marker of markers) {
    if (context.imageBudget.remaining <= 0) break;
    if (!isArtifactKeyForFile(marker.key, marker.fileId)) {
      log(
        'skip tool page-image artifact outside prefix fileId=%s key=%s',
        marker.fileId,
        marker.key,
      );
      continue;
    }
    if (context.authorizeFile && !(await context.authorizeFile(marker.fileId))) continue;
    try {
      const dataUri = artifactToDataUri(
        await context.loadArtifact(marker.key, marker.fileId),
        context.imageMaxBytes,
      );
      if (!dataUri) continue;
      parts.push({ image_url: { detail: 'high', url: dataUri }, type: 'image_url' });
      attachedPages.push(marker.page);
      context.imageBudget.remaining -= 1;
    } catch (error) {
      log(
        'tool page-image artifact load failed key=%s error=%s',
        marker.key,
        error instanceof Error ? error.message : error,
      );
    }
  }
  if (parts.length === 0) return;
  const nameMatch = /Requested page images for "([^"]+)"/.exec(text);
  const uniquePages = [...new Set(attachedPages)].sort((a, b) => a - b);
  parts.push({
    text: `[Requested page images for "${nameMatch?.[1] ?? markers[0]?.fileId}": pages ${uniquePages.join(', ')}]`,
    type: 'text',
  });
  let insertAt = lastIndex + 1;
  while (insertAt < context.messages.length && context.messages[insertAt]?.role === 'tool') {
    insertAt += 1;
  }
  context.messages.splice(insertAt, 0, { content: parts, role: 'user' });
};

/**
 * Replace own-deployment `/f/<id>` URLs in user and assistant structured parts
 * with data URIs, strip own-origin `url="…"` attributes from `<files_info>`
 * blocks in user text only, and rasterize empty-text PDFs that arrive only as
 * `<files_info>` markup (no `file_url` part). Mutates `messages`.
 */
export const inlineOwnOriginAttachments = async (
  messages: OpenAIChatMessage[],
  resolver: OwnOriginAttachmentResolver,
  ownOrigins: OwnDeploymentOrigins,
  options?: InlineOwnOriginAttachmentsOptions,
): Promise<void> => {
  const context = await createPipelineContext(messages, resolver, ownOrigins, options);
  await applyDocumentFeed(context);
  await injectToolPageImages(context);
  await applyInlinedParts(context, 'user');
  await applyFilesInfoRasterization(context);
  await applyInlinedParts(context, 'assistant');
};
