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

export interface ResolveRuntimeProviderIdInput {
  provider: string;
  providerConfig?: {
    settings?: { sdkType?: string } | null;
    source?: string | null;
  } | null;
}

const readSdkType = (settings: unknown): string | undefined => {
  if (!settings || typeof settings !== 'object') return undefined;
  const sdkType = (settings as { sdkType?: unknown }).sdkType;
  return typeof sdkType === 'string' && sdkType.length > 0 ? sdkType : undefined;
};

/**
 * Map a catalog provider id + optional DB row to the SDK runtime provider.
 *
 * Builtin providers (or rows with `source: 'builtin'`) keep their catalog id.
 * Custom providers use `settings.sdkType`, defaulting to OpenAI-compatible.
 * Mirrors `resolveModelRuntimeProvider` in `ModelRuntime/index.ts`.
 */
export const resolveRuntimeProviderId = ({
  provider,
  providerConfig,
}: ResolveRuntimeProviderIdInput): string => {
  const source = providerConfig?.source ?? undefined;
  const isBuiltin = source
    ? source === 'builtin'
    : Object.values(ModelProvider).includes(provider as ModelProvider);
  if (isBuiltin) return provider;

  return readSdkType(providerConfig?.settings) || ModelProvider.OpenAI;
};
