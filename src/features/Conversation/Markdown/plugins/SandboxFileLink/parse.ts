export const LOBE_SANDBOX_FILE_LINK_TAG = 'lobeSandboxFileLink';

/**
 * ChatGPT Web (and other sandboxed code-interpreter providers) reference the
 * files they just produced with a `sandbox:` markdown link, e.g.
 *
 * ```md
 * 已生成：[下载 aihub-uat7.pdf](sandbox:/mnt/data/aihub-uat7.pdf)
 * ```
 *
 * `sandbox:` is not a navigable protocol — react-markdown's `urlTransform`
 * strips it, leaving a dead blue link. The generated file itself is already
 * attached to the same assistant message as `fileList`, so we parse the href
 * here and let the renderer bind the link back to that attachment.
 */
const SANDBOX_PROTOCOL_REGEX = /^sandbox:/i;

export interface ParsedSandboxFileHref {
  /** basename of the sandbox path, used to match against the message `fileList` */
  fileName: string;
  /** the sandbox path with the protocol removed, e.g. `/mnt/data/report.pdf` */
  filePath: string;
}

const safeDecodeURIComponent = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const parseSandboxFileHref = (href?: string): ParsedSandboxFileHref | null => {
  const rawHref = href?.trim();
  if (!rawHref) return null;
  if (!SANDBOX_PROTOCOL_REGEX.test(rawHref)) return null;

  // Drop the protocol, then any query / hash the model may have appended.
  const withoutProtocol = rawHref.replace(SANDBOX_PROTOCOL_REGEX, '');
  const pathOnly = withoutProtocol.split('#')[0]!.split('?')[0]!;

  // `sandbox://mnt/data/x` and `sandbox:/mnt/data/x` denote the same file.
  const filePath = safeDecodeURIComponent(pathOnly.replace(/^\/{2,}/, '/')).replaceAll('\\', '/');

  if (!filePath || filePath.endsWith('/')) return null;

  const fileName = filePath.split('/').at(-1) ?? '';
  if (!fileName || fileName === '.' || fileName === '..') return null;

  return { fileName, filePath };
};

/**
 * Resolve the sandbox basename against the attachments of the same message.
 * Exact (case-sensitive) match wins; a case-insensitive match is the fallback
 * because some providers normalize the case of the path they echo back.
 */
export const matchSandboxFile = <T extends { name: string }>(
  fileName?: string,
  fileList?: T[],
): T | undefined => {
  if (!fileName || !fileList?.length) return undefined;

  const exact = fileList.find((file) => file.name === fileName);
  if (exact) return exact;

  const lowerCased = fileName.toLowerCase();
  return fileList.find((file) => file.name?.toLowerCase() === lowerCased);
};
