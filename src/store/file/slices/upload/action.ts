import { LOBE_CHAT_CLOUD } from '@lobechat/business-const';
import { inferImageMimeTypeFromBytes } from '@lobechat/utils';
import { t } from 'i18next';
import { sha256 } from 'js-sha256';

import { handleFileUploadError } from '@/business/client/handleFileUploadError';
import { message } from '@/components/AntdStaticMethods';
import { fileService } from '@/services/file';
import { uploadService } from '@/services/upload';
import { type StoreSetter } from '@/store/types';
import { type UploadFileItem } from '@/types/files';
import { getImageDimensions } from '@/utils/client/imageDimensions';

import { type FileStore } from '../../store';
import { audioMimeFromExtension } from '../chat/uploadGuard';

type OnStatusUpdate = (
  data:
    | {
        id: string;
        type: 'updateFile';
        value: Partial<UploadFileItem>;
      }
    | {
        id: string;
        type: 'removeFile';
      },
) => void;

interface UploadWithProgressParams {
  abortController?: AbortController;
  file: File;
  knowledgeBaseId?: string;
  onStatusUpdate?: OnStatusUpdate;
  parentId?: string;
  /**
   * Optional flag to indicate whether to skip the file type check.
   * When set to `true`, any file type checks will be bypassed.
   * Default is `false`, which means file type checks will be performed.
   */
  skipCheckFileType?: boolean;
  /**
   * Optional source identifier for the file (e.g., 'page-editor', 'image_generation')
   */
  source?: string;
  uploadId?: string;
  /**
   * Optional workspace visibility override sent to `file.createFile`. Only
   * meaningful in workspace mode; personal mode ignores it server-side. When
   * omitted the server picks its default (top-level uploads default to
   * `'private'`, children inherit their parent document's visibility).
   */
  visibility?: 'private' | 'public';
}

interface UploadWithProgressResult {
  dimensions?: {
    height: number;
    ratio: number;
    width: number;
  };
  filename?: string;
  id: string;
  url: string;
}

const normalizeUploadedImageFileType = async (
  file: File,
  fileArrayBuffer: ArrayBuffer,
): Promise<File> => {
  const detectedMimeType = await inferImageMimeTypeFromBytes(fileArrayBuffer);

  if (!detectedMimeType || detectedMimeType === file.type) return file;

  return new File([file], file.name, {
    lastModified: file.lastModified,
    type: detectedMimeType,
  });
};

type ExistingFileMetadata = Record<string, unknown> & { path?: string };

const normalizeExistingFileMetadata = (metadata: unknown): ExistingFileMetadata => {
  // Existing hash records can come from generated assets or older upload paths where metadata is null.
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};

  return metadata as ExistingFileMetadata;
};

const parseMimeTypeFromDataUri = (dataUri: string): string | undefined =>
  /^data:([^;,]+)/.exec(dataUri)?.[1];

/**
 * `uploadService` takes an AbortController (it calls `.abort()` on the xhr),
 * while callers own an AbortSignal — bridge one into the other.
 */
const bridgeSignalToController = (signal?: AbortSignal): AbortController | undefined => {
  if (!signal) return undefined;

  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', () => controller.abort(), { once: true });

  return controller;
};

type Setter = StoreSetter<FileStore>;

export const createFileUploadSlice = (set: Setter, get: () => FileStore, _api?: unknown) =>
  new FileUploadActionImpl(set, get, _api);

export class FileUploadActionImpl {
  constructor(set: Setter, get: () => FileStore, _api?: unknown) {
    void _api;
    void set;
    void get;
  }

  uploadBase64FileWithProgress = async (
    base64: string,
    options?: { filename?: string; mimeType?: string; signal?: AbortSignal },
  ): Promise<UploadWithProgressResult | undefined> => {
    try {
      // Nothing was started yet — cheapest possible cancellation.
      if (options?.signal?.aborted) return;

      const mimeType = options?.mimeType ?? parseMimeTypeFromDataUri(base64);
      // Only images have dimensions — probing a pdf/docx data URI just wastes a
      // decode and always resolves to undefined.
      const isImage = !mimeType || mimeType.startsWith('image/');

      // Extract image dimensions from base64 data
      const dimensions = isImage ? await getImageDimensions(base64) : undefined;

      const { metadata, fileType, size, hash } = await uploadService.uploadBase64ToS3(base64, {
        // `uploadService` cancels the S3 PUT through an AbortController, so
        // bridge the caller's signal (the chat operation's) into one.
        abortController: bridgeSignalToController(options?.signal),
        filename: options?.filename,
      });

      const res = await fileService.createFile({
        fileType,
        hash,
        metadata: { ...metadata, ...dimensions },
        // keep the human-readable name when the caller supplied one; the S3
        // metadata filename is a uuid
        name: options?.filename || metadata.filename,
        size,
        url: metadata.path,
      });
      return { ...res, dimensions, filename: options?.filename || metadata.filename };
    } catch (error) {
      if (handleFileUploadError(error)) return;

      throw error;
    }
  };

  uploadWithProgress = async ({
    file,
    onStatusUpdate,
    knowledgeBaseId,
    skipCheckFileType,
    parentId,
    source,
    uploadId,
    abortController,
    visibility,
  }: UploadWithProgressParams): Promise<UploadWithProgressResult | undefined> => {
    const statusId = uploadId ?? file.name;

    try {
      const fileArrayBuffer = await file.arrayBuffer();
      const normalizedFile = await normalizeUploadedImageFileType(file, fileArrayBuffer);

      // 1. extract image dimensions if applicable
      const dimensions = await getImageDimensions(normalizedFile);

      // 2. check file hash
      const hash = sha256(fileArrayBuffer);

      const checkStatus = await fileService.checkFileHash(hash);
      let metadata: ExistingFileMetadata;

      // 3. if file exist, just skip upload
      if (checkStatus.isExist) {
        metadata = normalizeExistingFileMetadata(checkStatus.metadata);
        onStatusUpdate?.({
          id: statusId,
          type: 'updateFile',
          value: { status: 'processing', uploadState: { progress: 100, restTime: 0, speed: 0 } },
        });
      }
      // 3. if file don't exist, need upload files
      else {
        const { data, success } = await uploadService.uploadFileToS3(normalizedFile, {
          abortController,
          onNotSupported: () => {
            onStatusUpdate?.({ id: statusId, type: 'removeFile' });
            message.info({
              content: t('upload.fileOnlySupportInServerMode', {
                cloud: LOBE_CHAT_CLOUD,
                ext: normalizedFile.name.split('.').pop(),
                ns: 'error',
              }),
              duration: 5,
            });
          },
          onProgress: (status, upload) => {
            onStatusUpdate?.({
              id: statusId,
              type: 'updateFile',
              value: { status: status === 'success' ? 'processing' : status, uploadState: upload },
            });
          },
          skipCheckFileType,
        });
        if (!success) return;

        metadata = { ...data };
      }

      // 4. use more powerful file type detector to get file type
      let fileType = normalizedFile.type;

      if (!normalizedFile.type) {
        const { fileTypeFromBuffer } = await import('file-type');

        const type = await fileTypeFromBuffer(fileArrayBuffer);
        fileType = type?.mime || 'text/plain';
      }

      // Audio containers like .m4a share the ISO-BMFF box with .mp4, so both the browser and
      // byte-sniffing may report an empty or `video/*` mime. Trust the extension to keep these
      // classified (and rendered) as audio.
      const audioMime = audioMimeFromExtension(normalizedFile.name);
      if (audioMime && !fileType.startsWith('audio/')) fileType = audioMime;

      // 5. create file to db
      // Fall back to the global file URL when legacy/generated metadata has no `path`.
      const fileUrl = metadata.path || checkStatus.url;
      if (!fileUrl) throw new Error('File upload failed: missing file url');

      const data = await fileService.createFile(
        {
          fileType,
          hash,
          metadata: { ...metadata, ...dimensions },
          name: normalizedFile.name,
          parentId,
          size: normalizedFile.size,
          source,
          url: fileUrl,
          visibility,
        },
        knowledgeBaseId,
      );

      onStatusUpdate?.({
        id: statusId,
        type: 'updateFile',
        value: {
          fileUrl: data.url,
          id: data.id,
          status: 'success',
          uploadState: { progress: 100, restTime: 0, speed: 0 },
        },
      });

      return { ...data, dimensions, filename: normalizedFile.name };
    } catch (error) {
      if (
        handleFileUploadError(error, {
          onUploadBlocked: () => onStatusUpdate?.({ id: statusId, type: 'removeFile' }),
        })
      ) {
        return;
      }

      throw error;
    }
  };
}

export type FileUploadAction = Pick<FileUploadActionImpl, keyof FileUploadActionImpl>;
