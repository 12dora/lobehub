/**
 * Code-interpreter file delivery.
 *
 * When the upstream python tool writes a file, the answer text references it as
 * a `sandbox:` link (`[report.pdf](sandbox:/mnt/data/report.pdf)`) — a scheme no
 * renderer can follow. These helpers turn that link into something resolvable:
 * the path is extracted from the finished answer text, handed to
 * `resolveInterpreterFile`, and the downloaded bytes become a `file` chunk.
 */

/** The virtual directory the interpreter writes into. */
export const SANDBOX_PATH_PREFIX = 'sandbox:/mnt/data/';

/** `[name](sandbox:/mnt/data/x.pdf)` — the shape the model actually emits. */
const MARKDOWN_SANDBOX_LINK_RE = /\]\((sandbox:\/mnt\/data\/[^\s)]+)\)/g;

/**
 * A bare mention, e.g. `saved to sandbox:/mnt/data/x.pdf`.
 *
 * CJK punctuation ends the path like ASCII whitespace does: a Chinese answer
 * writes `…/报告.pdf。另见…` with no space at all, and none of these marks are
 * legal in a name the interpreter produced.
 */
const BARE_SANDBOX_LINK_RE = /sandbox:\/mnt\/data\/[^\s)\]"'<>`，。、；：！？「」『』（）《》]+/gu;

/**
 * Trailing punctuation a prose sentence glues onto a bare path — ASCII and the
 * CJK sentence marks, which the model uses whenever it answers in Chinese
 * (`报告已保存到 sandbox:/mnt/data/report.pdf。`).
 */
const TRAILING_PUNCTUATION_RE = /[!,.:;?，。、；：！？」』）》]+$/u;

export interface SandboxFileRef {
  /** File name (basename of {@link sandboxPath}), sanitized */
  name: string;
  /** Absolute sandbox path WITHOUT the scheme, e.g. `/mnt/data/report.pdf` */
  path: string;
  /** The reference as it appeared, e.g. `sandbox:/mnt/data/report.pdf` */
  sandboxPath: string;
}

const decodePath = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    // a stray `%` is not an escape — keep the literal text
    return value;
  }
};

/**
 * Everything after the last `/`, with anything that could escape a directory or
 * break a header stripped, capped at 128 chars (extension preserved).
 */
export const sandboxFileName = (sandboxPath: string): string => {
  const raw = decodePath(sandboxPath).split(/[/\\]/).pop() ?? '';
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replaceAll(/[\u0000-\u001F\u007F"*:<>?|\\/]/g, '')
    .replace(/^\.+/, '')
    .trim();
  if (!cleaned) return 'download';
  if (cleaned.length <= 128) return cleaned;

  const dot = cleaned.lastIndexOf('.');
  const extension = dot > 0 && cleaned.length - dot <= 12 ? cleaned.slice(dot) : '';
  return cleaned.slice(0, 128 - extension.length) + extension;
};

/**
 * Sandbox references in an answer text, in order of appearance (by the offset
 * the reference starts at, whatever shape it has), deduplicated by path.
 *
 * @param requireClosed only accept the complete markdown form. While a message
 *   is still streaming its tail may be a half-written path (`…/mnt/data/ai`),
 *   and resolving that would 404 on a file name that never existed.
 */
export const extractSandboxFiles = (
  text: string,
  { requireClosed = false }: { requireClosed?: boolean } = {},
): SandboxFileRef[] => {
  if (!text || !text.includes(SANDBOX_PATH_PREFIX)) return [];

  const seen = new Set<string>();
  const refs: SandboxFileRef[] = [];
  /** every reference, with the offset its `sandbox:` starts at */
  const candidates: { index: number; value: string }[] = [];

  for (const match of text.matchAll(MARKDOWN_SANDBOX_LINK_RE))
    candidates.push({
      index: (match.index ?? 0) + match[0].indexOf(SANDBOX_PATH_PREFIX),
      value: match[1],
    });

  if (!requireClosed)
    for (const match of text.matchAll(BARE_SANDBOX_LINK_RE)) {
      const index = match.index ?? 0;
      // `](sandbox:/mnt/data/ai` — the tail of a markdown link whose `)` never
      // arrived is a TRUNCATED path, not a bare mention. Its closed form is
      // already covered by the markdown pass, so skipping it here can only drop
      // half-written paths (which would 404 on a name that never existed).
      if (text.slice(Math.max(0, index - 2), index) === '](') continue;
      candidates.push({ index, value: match[0] });
    }

  candidates.sort((a, b) => a.index - b.index);

  for (const { value } of candidates) {
    const sandboxPath = value.replace(TRAILING_PUNCTUATION_RE, '');
    if (!sandboxPath.startsWith(SANDBOX_PATH_PREFIX)) continue;
    const path = decodePath(sandboxPath.slice('sandbox:'.length));
    if (path.length <= '/mnt/data/'.length || seen.has(path)) continue;
    seen.add(path);
    refs.push({ name: sandboxFileName(sandboxPath), path, sandboxPath });
  }

  return refs;
};

/** Extensions worth naming explicitly; everything else is a binary blob. */
const MIME_BY_EXTENSION: Record<string, string> = {
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  gif: 'image/gif',
  htm: 'text/html',
  html: 'text/html',
  ics: 'text/calendar',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  json: 'application/json',
  log: 'text/plain',
  md: 'text/markdown',
  pdf: 'application/pdf',
  png: 'image/png',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  py: 'text/x-python',
  svg: 'image/svg+xml',
  tsv: 'text/tab-separated-values',
  txt: 'text/plain',
  webp: 'image/webp',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  zip: 'application/zip',
};

export const FALLBACK_MIME_TYPE = 'application/octet-stream';

/** Mime types that carry no information — the extension knows better. */
const GENERIC_MIME_TYPES = new Set([
  '',
  'application/binary',
  'application/octet-stream',
  'binary/octet-stream',
]);

export const mimeTypeForFileName = (name: string): string | undefined => {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return undefined;
  return MIME_BY_EXTENSION[name.slice(dot + 1).toLowerCase()];
};

/**
 * The download response's `content-type` wins (it is what the upstream stored),
 * except when it is generic or missing — then the extension decides, and a file
 * we cannot name at all is an opaque blob rather than a lie.
 */
export const resolveFileMimeType = (headerMime: string | undefined, name: string): string => {
  const declared = (headerMime ?? '').split(';')[0].trim().toLowerCase();
  if (!GENERIC_MIME_TYPES.has(declared)) return declared;
  return mimeTypeForFileName(name) ?? FALLBACK_MIME_TYPE;
};
