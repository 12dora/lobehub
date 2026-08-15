import { sha256 } from '@noble/hashes/sha2.js';
import createDebug from 'debug';

import { bytesToHex } from './binary';
import type { ChatGPTWebClient } from './client';
import { ASSET_POINTER_PREFIXES, TIMEOUTS } from './constants';
import type { ChatGPTWebErrorKind } from './errors';
import { callerAbortReason, isChatGPTWebError } from './errors';
import { readImageDimensions } from './imageDimensions';
import type { AssetPointerKind } from './types';

const log = createDebug('lobe-chatgptweb:image-resolve');

/**
 * Failures that are about the CALL, not about one pointer.
 *
 * Skipping these would report a dead access token, a revoked permission, a rate
 * limit or an expired budget as `ProviderNoImageGenerated` — "the model refused
 * to draw" — and send the user chasing their prompt instead of reconnecting the
 * provider or retrying later. Pointer-specific failures (`not_found`, an
 * `upstream` error on that one asset, unreadable bytes) stay skippable, because
 * the same image is usually reachable through a second pointer.
 */
const GLOBAL_FAILURE_KINDS = new Set<ChatGPTWebErrorKind>([
  'auth',
  'permission',
  'rate_limit',
  'timeout',
  'transport_unavailable',
]);

/**
 * Rethrow a failure the whole call cannot recover from; return for the ones the
 * next pointer may still fix.
 */
const rethrowIfFatal = (error: unknown, signal: AbortSignal | undefined): void => {
  // the abort reason is the authoritative failure here: whatever the client
  // turned the cancellation into, the budget (or the caller) is what ended it
  const abort = callerAbortReason(signal);
  if (abort !== undefined) throw abort;
  if (isChatGPTWebError(error) && GLOBAL_FAILURE_KINDS.has(error.kind)) throw error;
};

/** The upload placeholder is never generated output. */
const SKIPPED_FILE_IDS = new Set(['file_upload']);

/** ROTS: the id shape the upstream currently mints for generated images. */
const GENERATED_FILE_ID_RE = /^file_0{8}[\da-f]{24}$/;

export interface ImagePointer {
  fileId: string;
  kind: AssetPointerKind;
}

export interface ResolvedImage {
  bytes: Uint8Array;
  height?: number;
  mimeType: string;
  width?: number;
}

export const pointerKindOf = (pointer: string): AssetPointerKind | undefined => {
  if (pointer.startsWith(ASSET_POINTER_PREFIXES.fileService)) return 'file-service';
  if (pointer.startsWith(ASSET_POINTER_PREFIXES.sediment)) return 'sediment';
  return undefined;
};

export const pointerKey = ({ fileId, kind }: ImagePointer): string => `${kind}:${fileId}`;

/** Union of two pointer lists, order-preserving, first occurrence wins. */
export const mergePointers = (...lists: ImagePointer[][]): ImagePointer[] => {
  const seen = new Set<string>();
  const out: ImagePointer[] = [];
  for (const list of lists) {
    for (const pointer of list) {
      if (SKIPPED_FILE_IDS.has(pointer.fileId)) continue;
      const key = pointerKey(pointer);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(pointer);
    }
  }
  return out;
};

export const samePointerSet = (left: ImagePointer[], right: ImagePointer[]): boolean => {
  if (left.length !== right.length) return false;
  const keys = new Set(left.map(pointerKey));
  return right.every((pointer) => keys.has(pointerKey(pointer)));
};

/**
 * Pointer → signed download URL. `file-service://` ids resolve through the file
 * endpoint, `sediment://` ids through the conversation attachment endpoint (the
 * sediment id IS the attachment id — there is no mapping step).
 *
 * Per-pointer failures are logged and skipped: one dead pointer must not lose an
 * image that another pointer still resolves.
 */
const resolvePointerUrl = async (
  client: ChatGPTWebClient,
  pointer: ImagePointer,
  conversationId: string | undefined,
  signal?: AbortSignal,
): Promise<string | undefined> => {
  try {
    if (pointer.kind === 'file-service') {
      if (!GENERATED_FILE_ID_RE.test(pointer.fileId))
        // Do not drop it — the id format rotates; a warning beats silence.
        log('file id %s does not match the known generated-image shape', pointer.fileId);
      return (await client.getFileDownloadUrl(pointer.fileId, signal)) || undefined;
    }

    if (!conversationId) {
      log('cannot resolve sediment pointer %s without a conversation id', pointer.fileId);
      return undefined;
    }
    return (
      (await client.getAttachmentDownloadUrl(conversationId, pointer.fileId, signal)) || undefined
    );
  } catch (error) {
    rethrowIfFatal(error, signal);
    // the shape only: a download-url error can carry the signed URL it produced
    log(
      'failed to resolve pointer %s: %s',
      pointer.fileId,
      error instanceof Error ? error.name : typeof error,
    );
    return undefined;
  }
};

export interface ResolveImagesOptions {
  client: ChatGPTWebClient;
  conversationId?: string;
  /** Absolute wall-clock budget shared by the whole `createImage` call. */
  deadline?: number;
  pointers: ImagePointer[];
  signal?: AbortSignal;
}

/**
 * Resolve pointers to bytes, deduplicated by content hash.
 *
 * The same generated image is frequently reachable through both a
 * `file-service://` and a `sediment://` pointer, which yield two different
 * signed URLs for identical bytes — hence the sha256 dedupe rather than URL
 * dedupe.
 */
export const resolveImages = async ({
  client,
  conversationId,
  deadline,
  pointers,
  signal,
}: ResolveImagesOptions): Promise<ResolvedImage[]> => {
  const remaining = () => (deadline === undefined ? undefined : deadline - Date.now());

  const urls: string[] = [];
  for (const pointer of pointers) {
    if (SKIPPED_FILE_IDS.has(pointer.fileId)) continue;
    const url = await resolvePointerUrl(client, pointer, conversationId, signal);
    if (url && !urls.includes(url)) urls.push(url);
  }

  const images: ResolvedImage[] = [];
  const hashes = new Set<string>();

  for (const url of urls) {
    const left = remaining();
    const timeoutMs = left === undefined ? undefined : Math.max(1, Math.min(TIMEOUTS.binary, left));

    let downloaded: { bytes: Uint8Array; mimeType?: string };
    try {
      downloaded = await client.downloadBytes(url, { signal, timeoutMs });
    } catch (error) {
      rethrowIfFatal(error, signal);
      // the URL is signed — log the failure shape, never the request
      log('failed to download an image: %s', error instanceof Error ? error.name : typeof error);
      continue;
    }
    if (downloaded.bytes.length === 0) continue;

    // A 200 carrying an HTML/JSON error page (or any unrecognised payload) is
    // NOT an image: returning it would hand the caller `data:text/html` or a
    // fabricated `image/png`. Skip the pointer and let the next one try.
    const probed = readImageDimensions(downloaded.bytes);
    if (!probed) {
      log('skipping a download whose bytes are not a supported image');
      continue;
    }

    const hash = bytesToHex(sha256(downloaded.bytes));
    if (hashes.has(hash)) continue;
    hashes.add(hash);

    images.push({
      bytes: downloaded.bytes,
      height: probed.height,
      // the type comes from the actual bytes, never from the response header
      mimeType: probed.mimeType,
      width: probed.width,
    });
  }

  return images;
};
