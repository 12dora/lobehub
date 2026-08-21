import {
  SANDBOX_OVER_LIMIT_UPLOADS_DIR,
  SANDBOX_UPLOADED_FILES_DIR,
  sandboxOverLimitUploadPath,
  sandboxUploadedFilePath,
} from '@lobechat/builtin-tool-cloud-sandbox';

/** Marker file written once the uploaded files have been synced for a session. */
export const SANDBOX_FILES_INIT_MARKER = `${SANDBOX_UPLOADED_FILES_DIR}/.lobe-files-initialized`;

/** Timeout (ms) for the bootstrap download command. */
export const SANDBOX_INIT_TIMEOUT_MS = 120_000;

/** Per-file timeout for over-limit attachment sync (ms). */
export const SANDBOX_ATTACHMENT_SYNC_FILE_TIMEOUT_MS = 30_000;

/** `curl --max-time` counterpart of {@link SANDBOX_ATTACHMENT_SYNC_FILE_TIMEOUT_MS}. */
export const SANDBOX_ATTACHMENT_SYNC_FILE_TIMEOUT_SEC = 30;

/** Max in-flight over-limit attachment downloads (and URL resolves). */
export const SANDBOX_ATTACHMENT_SYNC_CONCURRENCY = 3;

export interface SandboxInitDownload {
  name: string;
  /** A download URL (e.g. presigned) the sandbox can fetch with curl. */
  url: string;
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", String.raw`'\''`)}'`;

/**
 * Build an idempotent shell command that downloads the given uploaded files into
 * the sandbox upload directory. A marker file guards re-runs, so the command is
 * a cheap no-op once the files have been synced for the current session.
 *
 * Downloads are best-effort: a single failed fetch does not abort the rest, and
 * the marker is always written so the sync is not retried on every tool call.
 */
export const buildSandboxFilesInitCommand = (downloads: SandboxInitDownload[]): string => {
  const dir = shellQuote(SANDBOX_UPLOADED_FILES_DIR);
  const marker = shellQuote(SANDBOX_FILES_INIT_MARKER);

  const seen = new Set<string>();
  const curls: string[] = [];

  for (const { name, url } of downloads) {
    if (!url) continue;
    const path = sandboxUploadedFilePath(name);
    if (seen.has(path)) continue;
    seen.add(path);
    curls.push(`curl -fsSL ${shellQuote(url)} -o ${shellQuote(path)} || true`);
  }

  if (curls.length === 0) return `mkdir -p ${dir}`;

  const body = [...curls, `touch ${marker}`].join('; ');

  return `mkdir -p ${dir}; if [ ! -f ${marker} ]; then ${body}; fi`;
};

export interface SandboxAttachmentUpload {
  id: string;
  name: string;
  /** A download URL (e.g. presigned) the sandbox can fetch with curl. */
  url: string;
}

/** Prefix written by {@link buildSandboxAttachmentFileSyncCommand} for a successful file. */
export const SANDBOX_ATTACHMENT_SYNC_OK_PREFIX = 'LOBE_SYNC_OK:';

/** Prefix written by {@link buildSandboxAttachmentFileSyncCommand} for a failed file. */
export const SANDBOX_ATTACHMENT_SYNC_FAIL_PREFIX = 'LOBE_SYNC_FAIL:';

const sanitizeMarkerId = (id: string): string => id.replaceAll(/[^\w.-]/g, '_');

/**
 * Per-file marker that records a successful over-limit attachment sync for the
 * current sandbox session. Recycled sessions lose the marker and re-sync.
 */
export const sandboxAttachmentSyncMarker = (fileId: string): string =>
  `${SANDBOX_OVER_LIMIT_UPLOADS_DIR}/.synced-${sanitizeMarkerId(fileId)}`;

/**
 * Build a single-file idempotent shell command that places an over-limit /
 * non-native attachment at a collision-free path under `/mnt/data/uploads`.
 *
 * A marker is only treated as valid when the destination also exists, so a
 * rename between turns re-downloads instead of advertising a missing path.
 * If the topic bootstrap already wrote `/mnt/data/<name>`, that copy is reused
 * instead of issuing a second download.
 *
 * Success/failure is reported on stdout as `LOBE_SYNC_OK:<id>` / `LOBE_SYNC_FAIL:<id>`.
 */
export const buildSandboxAttachmentFileSyncCommand = (file: SandboxAttachmentUpload): string => {
  const { id, name, url } = file;
  const dir = shellQuote(SANDBOX_OVER_LIMIT_UPLOADS_DIR);
  const dest = sandboxOverLimitUploadPath(name, id);
  const marker = shellQuote(sandboxAttachmentSyncMarker(id));
  const quotedDest = shellQuote(dest);
  const quotedUrl = shellQuote(url);
  const quotedBootstrap = shellQuote(sandboxUploadedFilePath(name));
  const echoedId = id.replaceAll(/[\n\r]/g, '');
  const okEcho = shellQuote(`${SANDBOX_ATTACHMENT_SYNC_OK_PREFIX}${echoedId}`);
  const failEcho = shellQuote(`${SANDBOX_ATTACHMENT_SYNC_FAIL_PREFIX}${echoedId}`);
  const maxTime = String(SANDBOX_ATTACHMENT_SYNC_FILE_TIMEOUT_SEC);

  return [
    `mkdir -p ${dir}`,
    `if [ -f ${marker} ] && [ -f ${quotedDest} ]; then echo ${okEcho}`,
    `elif [ -f ${quotedBootstrap} ]; then cp ${quotedBootstrap} ${quotedDest} && touch ${marker} && echo ${okEcho}`,
    `elif curl -fsSL --max-time ${maxTime} ${quotedUrl} -o ${quotedDest}; then touch ${marker} && echo ${okEcho}`,
    `else echo ${failEcho}`,
    'fi',
  ].join('; ');
};
