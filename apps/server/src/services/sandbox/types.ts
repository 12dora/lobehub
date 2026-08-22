import type {
  ISandboxService,
  SandboxExportFileResult,
} from '@lobechat/builtin-tool-cloud-sandbox';
import type { LobeChatDatabase } from '@lobechat/database';

import type { FileService } from '@/server/services/file';
import type { MarketService } from '@/server/services/market';

export type SandboxProviderKind = 'local' | 'market' | 'onlyboxes';

export type LocalSandboxPullPolicy = 'always' | 'if-missing' | 'never';

export type LocalSandboxNetwork = 'bridge' | 'none';

/** Constructor options for `LocalSandboxProvider` (lazy-loaded from `./providers/local`). */
export interface LocalSandboxProviderOptions {
  /** Workspace tmpfs size in MiB (counts toward host RAM). Default 512. */
  diskMb?: number;
  host?: string;
  idleTtlSec: number;
  image: string;
  maxContainers: number;
  /** Hard cap on exportFile payload. Default 100 MiB. */
  maxExportBytes?: number;
  maxOutputBytes: number;
  memoryBytes: number;
  nanoCpus: number;
  network: LocalSandboxNetwork;
  pidsLimit: number;
  pullOnDemand: boolean;
  pullPolicy: LocalSandboxPullPolicy;
  socketPath?: string;
  timeoutMs: number;
}

export interface SandboxSessionContext {
  topicId: string;
  userId: string;
}

export interface SandboxServiceOptions extends SandboxSessionContext {
  fileService?: FileService;
  marketService: MarketService;
  /** Used to look up topic/session files when bootstrapping the sandbox. */
  serverDB?: LobeChatDatabase;
}

export interface SandboxProviderCapabilities {
  backgroundCommands: boolean;
  exportFile: boolean;
  files: boolean;
  languages: string[];
  persistentSession: boolean;
  /** Present when {@link SandboxProvider.putFiles} can push bytes without curl. */
  pushFiles?: boolean;
  shell: boolean;
  skillScripts: boolean;
}

/** Per-file cap for {@link SandboxProvider.putFiles}. Oversize files are skipped, never thrown. */
export const SANDBOX_PUT_FILES_MAX_FILE_BYTES = 64 * 1024 * 1024;

/** Total cap per {@link SandboxProvider.putFiles} call. Remaining files are skipped. */
export const SANDBOX_PUT_FILES_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

export interface SandboxPutFile {
  bytes: Uint8Array;
  mode?: number;
  path: string;
}

export interface SandboxPutFilesFailure {
  path: string;
  reason: string;
}

export interface SandboxPutFilesResult {
  failed: SandboxPutFilesFailure[];
  written: string[];
}

export interface SandboxProvider extends Pick<ISandboxService, 'callTool'> {
  readonly capabilities: SandboxProviderCapabilities;

  exportFileToUploadUrl: (
    request: SandboxProviderFileExportRequest,
  ) => Promise<SandboxProviderFileExportResult>;

  readonly kind: SandboxProviderKind;

  /**
   * Optional: push file bytes into the sandbox (local Docker `putArchive`).
   * Remote providers omit this so the curl path stays in use.
   */
  putFiles?: (files: SandboxPutFile[]) => Promise<SandboxPutFilesResult>;
}

export interface SandboxOverLimitAttachment {
  id: string;
  name: string;
  /**
   * Declared object size in bytes, when known. Used to skip oversize files
   * before downloading them into memory.
   */
  size?: number;
  /**
   * Original object-storage key (S3). Used by {@link SandboxProvider.putFiles}
   * to read bytes server-side; the curl path ignores it.
   */
  storageKey?: string;
  /** Presigned (or otherwise fetchable) download URL. */
  url: string;
}

export interface SandboxService extends ISandboxService {
  readonly capabilities: SandboxProviderCapabilities;
  readonly kind: SandboxProviderKind;
  /**
   * Internal: place over-limit / non-native attachments at collision-free
   * `/mnt/data/uploads` paths. Must NOT run general topic-file initialization.
   */
  syncOverLimitAttachments: (
    files: SandboxOverLimitAttachment[],
  ) => Promise<Record<string, string>>;
}

export interface SandboxFileExporter {
  exportAndUploadFile: (path: string, filename: string) => Promise<SandboxExportFileResult>;
}

export interface SandboxProviderFileExportRequest {
  filename: string;
  path: string;
  uploadHeaders?: Record<string, string>;
  uploadUrl: string;
}

export interface SandboxProviderFileExportResult {
  error?: { message: string; name?: string };
  mimeType?: string;
  result?: Record<string, unknown>;
  size?: number;
  success: boolean;
}

export interface SandboxCommandResult {
  exitCode: number;
  output: string;
  stderr?: string;
  success: boolean;
}
