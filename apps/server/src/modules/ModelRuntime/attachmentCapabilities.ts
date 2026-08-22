import { DOCUMENT_RENDER_DEFAULTS } from '@lobechat/types';
import { DEFAULT_IMAGE_INLINE_MAX_BYTES } from '@lobechat/utils/imageToBase64';
import { ModelProvider } from 'model-bank';

const MIB = 1024 * 1024;

export interface AttachmentCapabilities {
  imageMaxBytes: number;
  imageMaxCount: number;
  nativeFiles: boolean;
  tools: boolean;
}

const DEFAULT_ATTACHMENT_CAPABILITIES: AttachmentCapabilities = {
  imageMaxBytes: DEFAULT_IMAGE_INLINE_MAX_BYTES,
  imageMaxCount: DOCUMENT_RENDER_DEFAULTS.maxImagesDefault,
  nativeFiles: false,
  tools: true,
};

const CURSOR_IMAGE_MAX_BYTES = 6 * MIB;

const ATTACHMENT_CAPABILITIES_BY_PROVIDER: Record<string, AttachmentCapabilities> = {
  [ModelProvider.ChatGPT]: {
    imageMaxBytes: DEFAULT_IMAGE_INLINE_MAX_BYTES,
    imageMaxCount: DOCUMENT_RENDER_DEFAULTS.maxImagesDefault,
    nativeFiles: true,
    tools: true,
  },
  [ModelProvider.ChatGPTWeb]: {
    imageMaxBytes: DEFAULT_IMAGE_INLINE_MAX_BYTES,
    imageMaxCount: DOCUMENT_RENDER_DEFAULTS.maxImagesDefault,
    nativeFiles: true,
    tools: true,
  },
  [ModelProvider.Grok]: {
    imageMaxBytes: DEFAULT_IMAGE_INLINE_MAX_BYTES,
    imageMaxCount: DOCUMENT_RENDER_DEFAULTS.maxImagesDefault,
    nativeFiles: false,
    tools: true,
  },
  [ModelProvider.SuperGrok]: {
    imageMaxBytes: DEFAULT_IMAGE_INLINE_MAX_BYTES,
    imageMaxCount: DOCUMENT_RENDER_DEFAULTS.maxImagesDefault,
    nativeFiles: true,
    tools: true,
  },
  [ModelProvider.Cursor]: {
    imageMaxBytes: CURSOR_IMAGE_MAX_BYTES,
    imageMaxCount: 4,
    nativeFiles: false,
    tools: false,
  },
};

export const getAttachmentCapabilities = (
  runtimeProvider: string | undefined,
): AttachmentCapabilities => {
  if (!runtimeProvider) return DEFAULT_ATTACHMENT_CAPABILITIES;
  return ATTACHMENT_CAPABILITIES_BY_PROVIDER[runtimeProvider] ?? DEFAULT_ATTACHMENT_CAPABILITIES;
};
