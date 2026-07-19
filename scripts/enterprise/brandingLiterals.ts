import path from 'node:path';

import ts from 'typescript';

export const BRANDING_BASELINE_VERSION = 1;
export const BRANDING_BASELINE_POLICY =
  'Known legacy user-visible literals, keyed by repository-relative path and count so line moves stay stable. Any increase or decrease requires a reviewed baseline diff.';

export const BRANDING_SCAN_ROOTS = ['apps', 'packages', 'src'] as const;

export const BRANDING_TEXT_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.cts',
  '.env',
  '.graphql',
  '.gql',
  '.html',
  '.js',
  '.json',
  '.jsonc',
  '.jsx',
  '.less',
  '.mjs',
  '.mts',
  '.scss',
  '.sh',
  '.sql',
  '.svg',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);

export const BRANDING_BINARY_EXTENSIONS = new Set([
  '.7z',
  '.a',
  '.avif',
  '.bin',
  '.bmp',
  '.br',
  '.cer',
  '.crt',
  '.dmg',
  '.eot',
  '.gif',
  '.gz',
  '.ico',
  '.icns',
  '.jar',
  '.jpeg',
  '.jpg',
  '.lockb',
  '.mov',
  '.mp3',
  '.mp4',
  '.otf',
  '.pdf',
  '.pem',
  '.png',
  '.so',
  '.tar',
  '.ttf',
  '.webm',
  '.webp',
  '.woff',
  '.woff2',
  '.zip',
]);

export const BRANDING_EXCLUDED_DIRECTORY_NAMES = new Set([
  '.git',
  '.next',
  '__fixtures__',
  '__generated__',
  '__mocks__',
  '__snapshots__',
  '__tests__',
  'build',
  'coverage',
  'dist',
  'docs',
  'documentation',
  'fixtures',
  'generated',
  'man',
  'node_modules',
  'testdata',
  'tmp',
]);

const DOCUMENT_EXTENSIONS = new Set(['.md', '.mdx', '.rst']);
const TOOLING_IGNORE_FILES = new Set([
  '.dockerignore',
  '.eslintignore',
  '.gitignore',
  '.npmignore',
  '.prettierignore',
  '.stylelintignore',
]);
const SCRIPT_EXTENSIONS = new Set([
  '.cjs',
  '.cts',
  '.js',
  '.json',
  '.jsonc',
  '.jsx',
  '.mjs',
  '.mts',
  '.ts',
  '.tsx',
]);
const TEST_FILE_RE = /(?:^|\/)\S+\.(?:e2e|integration|spec|test)\.[cm]?[jt]sx?$/i;
const LEGAL_FILE_RE = /(?:^|\/)(?:authors|copying|license|notice)(?:\.[^/]*)?$/i;
const BRAND_RE = /lobehub|lobechat/giu;
const UNSAFE_SLASH_RE = /[\u2044\u2215\u29F8\uFF0F\uFF3C]/u;

export type BrandingName = 'LobeChat' | 'LobeHub';

export type BrandingAllowedCategory =
  | 'stable-database-id'
  | 'internal-package-or-path'
  | 'legal-attribution'
  | 'stable-protocol-or-storage-id'
  | 'stable-url-or-email';

export interface BrandingBaselineEntry {
  category: 'legacy-user-visible';
  LobeChat?: number;
  LobeHub?: number;
  path: string;
}

export interface BrandingBaseline {
  entries: BrandingBaselineEntry[];
  policy: string;
  version: number;
}

export interface BrandingLiteralCandidate {
  brand: BrandingName;
  column: number;
  line: number;
  path: string;
  preview: string;
}

export interface BrandingAllowedLiteral extends BrandingLiteralCandidate {
  category: BrandingAllowedCategory;
}

export interface BrandingFileScanResult {
  allowed: BrandingAllowedLiteral[];
  candidates: BrandingLiteralCandidate[];
  errors: string[];
}

interface LiteralFragment {
  column: number;
  line: number;
  text: string;
}

const decodeCodePoint = (value: string, radix: number): string => {
  const codePoint = Number.parseInt(value, radix);
  if (!Number.isSafeInteger(codePoint) || codePoint > 0x10ffff) return '';

  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return '';
  }
};

const stripInvisibleFormatting = (input: string): string =>
  [...input]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return !(
        codePoint === 0 ||
        codePoint === 0x00ad ||
        codePoint === 0x034f ||
        codePoint === 0x061c ||
        codePoint === 0x115f ||
        codePoint === 0x1160 ||
        codePoint === 0x17b4 ||
        codePoint === 0x17b5 ||
        codePoint === 0x180e ||
        (codePoint >= 0x200b && codePoint <= 0x200f) ||
        (codePoint >= 0x202a && codePoint <= 0x202e) ||
        (codePoint >= 0x2060 && codePoint <= 0x206f) ||
        codePoint === 0xfeff
      );
    })
    .join('');

/** Decode only deterministic, non-executing encodings commonly used to hide literals. */
export const decodeBrandingText = (input: string): string => {
  let value = stripInvisibleFormatting(input.normalize('NFKC'));

  for (let iteration = 0; iteration < 3; iteration += 1) {
    const decoded = value
      .replaceAll(/\\u\{([\da-f]{1,6})\}/giu, (_, code: string) => decodeCodePoint(code, 16))
      .replaceAll(/\\u([\da-f]{4})/giu, (_, code: string) => decodeCodePoint(code, 16))
      .replaceAll(/\\x([\da-f]{2})/giu, (_, code: string) => decodeCodePoint(code, 16))
      .replaceAll(/&#x([\da-f]{1,6});?/giu, (_, code: string) => decodeCodePoint(code, 16))
      .replaceAll(/&#(\d{1,7});?/gu, (_, code: string) => decodeCodePoint(code, 10))
      .replaceAll(/%([\da-f]{2})/giu, (_, code: string) => decodeCodePoint(code, 16))
      .normalize('NFKC');
    const stripped = stripInvisibleFormatting(decoded);

    if (stripped === value) break;
    value = stripped;
  }

  return value;
};

export const normalizeRepositoryPath = (input: string): string => {
  if (!input || input.includes('\0') || UNSAFE_SLASH_RE.test(input)) {
    throw new Error(`unsafe repository path: ${JSON.stringify(input)}`);
  }

  const normalizedUnicode = input.normalize('NFKC');
  let decoded = normalizedUnicode;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      throw new Error(`invalid encoded repository path: ${JSON.stringify(input)}`);
    }
  }

  const slashPath = decoded.replaceAll('\\', '/').replace(/^\.\//u, '');
  if (
    path.posix.isAbsolute(slashPath) ||
    path.win32.isAbsolute(decoded) ||
    slashPath.startsWith('//') ||
    /^[a-z][a-z\d+.-]*:/iu.test(slashPath)
  ) {
    throw new Error(`absolute repository path is not allowed: ${JSON.stringify(input)}`);
  }

  const segments = slashPath.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`repository path traversal is not allowed: ${JSON.stringify(input)}`);
  }

  if (path.posix.normalize(slashPath) !== slashPath) {
    throw new Error(`non-canonical repository path: ${JSON.stringify(input)}`);
  }

  return slashPath;
};

export const isExcludedBrandingPath = (filePath: string): boolean => {
  const normalized = normalizeRepositoryPath(filePath);
  const segments = normalized.split('/');
  if (TOOLING_IGNORE_FILES.has(segments.at(-1)?.toLowerCase() ?? '')) return true;
  if (segments.some((segment) => BRANDING_EXCLUDED_DIRECTORY_NAMES.has(segment.toLowerCase()))) {
    return true;
  }

  if (TEST_FILE_RE.test(normalized)) return true;
  const extension = path.posix.extname(normalized).toLowerCase();
  return DOCUMENT_EXTENSIONS.has(extension) && !LEGAL_FILE_RE.test(normalized);
};

export const isLegalAttributionPath = (filePath: string): boolean =>
  LEGAL_FILE_RE.test(normalizeRepositoryPath(filePath));

const getScriptKind = (filePath: string): ts.ScriptKind => {
  const extension = path.posix.extname(filePath).toLowerCase();
  switch (extension) {
    case '.js':
    case '.cjs':
    case '.mjs': {
      return ts.ScriptKind.JS;
    }
    case '.jsx': {
      return ts.ScriptKind.JSX;
    }
    case '.json':
    case '.jsonc': {
      return ts.ScriptKind.JSON;
    }
    case '.tsx': {
      return ts.ScriptKind.TSX;
    }
    default: {
      return ts.ScriptKind.TS;
    }
  }
};

const collectScriptFragments = (filePath: string, source: string): LiteralFragment[] => {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(filePath),
  );
  const fragments: LiteralFragment[] = [];

  const addFragment = (node: ts.Node, text: string) => {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    fragments.push({ column: position.character + 1, line: position.line + 1, text });
  };

  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      addFragment(node, node.text);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return fragments;
};

const collectPlainTextFragments = (source: string): LiteralFragment[] => {
  const fragments: LiteralFragment[] = [];
  const lines = source.split(/\r?\n/u);
  for (const [index, text] of lines.entries()) {
    if (!BRAND_RE.test(decodeBrandingText(text))) {
      BRAND_RE.lastIndex = 0;
      continue;
    }
    BRAND_RE.lastIndex = 0;
    fragments.push({ column: 1, line: index + 1, text });
  }
  return fragments;
};

const classifyAllowedLiteral = (
  filePath: string,
  text: string,
): BrandingAllowedCategory | undefined => {
  if (isLegalAttributionPath(filePath) || /\b(?:copyright|license|trademark)\b/iu.test(text)) {
    return 'legal-attribution';
  }

  if (
    /(?:https?:\/\/|mailto:|[\w.+-]+@)[^\s"'<>]*(?:lobehub|lobechat)/iu.test(text) ||
    /(?:lobehub|lobechat)\.(?:com|ai|dev|org)\b/iu.test(text)
  ) {
    return 'stable-url-or-email';
  }

  if (
    /@(?:lobehub|lobechat)\//iu.test(text) ||
    (!/\s/u.test(text) && text.includes('/') && /lobehub|lobechat/iu.test(text))
  ) {
    return 'internal-package-or-path';
  }

  const compact = !/\s/u.test(text);
  const lowerText = text.toLocaleLowerCase('en-US');
  const upperText = text.toLocaleUpperCase('en-US');
  const containsBrand = lowerText.includes('lobehub') || lowerText.includes('lobechat');
  const containsMachineCaseBrand =
    text.includes('lobehub') ||
    text.includes('lobechat') ||
    text.includes('LOBEHUB') ||
    text.includes('LOBECHAT');
  const hasMachineDelimiter = /[_:./-]/u.test(text);
  const hasOnlyMachineCharacters = /^[\w@.${}:/-]+$/u.test(text);
  if (
    filePath.startsWith('packages/database/') &&
    compact &&
    containsMachineCaseBrand &&
    hasOnlyMachineCharacters
  ) {
    return 'stable-database-id';
  }

  if (
    compact &&
    (text === 'lobehub' ||
      text === 'lobechat' ||
      (/^(?:LobeHub|LobeChat)_[\w.:-]+$/u.test(text) && containsBrand) ||
      (containsMachineCaseBrand &&
        hasMachineDelimiter &&
        hasOnlyMachineCharacters &&
        (text === lowerText || text === upperText || !/LobeHub|LobeChat/u.test(text))))
  ) {
    return 'stable-protocol-or-storage-id';
  }

  if (/^(?:LobeHub|LobeChat) Desktop\/[\w.${}-]+$/u.test(text)) {
    return 'stable-protocol-or-storage-id';
  }

  return undefined;
};

const previewLiteral = (text: string): string => {
  const compact = text.replaceAll(/\s+/gu, ' ').trim();
  return compact.length > 140 ? `${compact.slice(0, 137)}...` : compact;
};

export const scanBrandingFile = (
  filePath: string,
  source: string,
  options: { supportedExtension?: boolean } = {},
): BrandingFileScanResult => {
  let normalizedPath: string;
  try {
    normalizedPath = normalizeRepositoryPath(filePath);
  } catch (error) {
    return { allowed: [], candidates: [], errors: [(error as Error).message] };
  }

  if (isExcludedBrandingPath(normalizedPath)) return { allowed: [], candidates: [], errors: [] };

  const extension = path.posix.extname(normalizedPath).toLowerCase();
  if (source.includes('\0') && options.supportedExtension === false) {
    return {
      allowed: [],
      candidates: [],
      errors: [`${normalizedPath}: NUL byte in a non-binary scan target`],
    };
  }

  const fragments = SCRIPT_EXTENSIONS.has(extension)
    ? collectScriptFragments(normalizedPath, source)
    : collectPlainTextFragments(source);
  const allowed: BrandingAllowedLiteral[] = [];
  const candidates: BrandingLiteralCandidate[] = [];
  const errors: string[] = [];

  for (const fragment of fragments) {
    const decodedText = decodeBrandingText(fragment.text);
    const matches = [...decodedText.matchAll(BRAND_RE)];
    for (const match of matches) {
      const lowerBrand = match[0].toLocaleLowerCase('en-US');
      const brand: BrandingName = lowerBrand === 'lobehub' ? 'LobeHub' : 'LobeChat';
      const candidate = {
        brand,
        column: fragment.column + (match.index ?? 0),
        line: fragment.line,
        path: normalizedPath,
        preview: previewLiteral(decodedText),
      } satisfies BrandingLiteralCandidate;
      const category = classifyAllowedLiteral(normalizedPath, decodedText);
      if (category) allowed.push({ ...candidate, category });
      else candidates.push(candidate);
    }
  }

  if (options.supportedExtension === false && (allowed.length > 0 || candidates.length > 0)) {
    errors.push(
      `${normalizedPath}: branding literal found in unsupported text extension; classify the extension explicitly`,
    );
  }

  return { allowed, candidates, errors };
};

export const validateBrandingBaseline = (baseline: BrandingBaseline): string[] => {
  const errors: string[] = [];
  if (baseline.version !== BRANDING_BASELINE_VERSION) {
    errors.push(
      `unsupported branding baseline version ${String(baseline.version)} (expected ${BRANDING_BASELINE_VERSION})`,
    );
  }
  if (baseline.policy !== BRANDING_BASELINE_POLICY) {
    errors.push('branding baseline policy text is missing or changed');
  }

  let previousPath = '';
  const seen = new Set<string>();
  for (const entry of baseline.entries) {
    let normalizedPath: string;
    try {
      normalizedPath = normalizeRepositoryPath(entry.path);
    } catch (error) {
      errors.push((error as Error).message);
      continue;
    }

    if (normalizedPath !== entry.path) errors.push(`baseline path is not canonical: ${entry.path}`);
    if (seen.has(normalizedPath)) errors.push(`duplicate baseline path: ${normalizedPath}`);
    seen.add(normalizedPath);
    if (previousPath && previousPath.localeCompare(normalizedPath, 'en') >= 0) {
      errors.push(`baseline entries must be sorted: ${previousPath} before ${normalizedPath}`);
    }
    previousPath = normalizedPath;

    if (entry.category !== 'legacy-user-visible') {
      errors.push(`invalid baseline category for ${normalizedPath}`);
    }
    for (const brand of ['LobeChat', 'LobeHub'] as const) {
      const count = entry[brand];
      if (count !== undefined && (!Number.isSafeInteger(count) || count <= 0)) {
        errors.push(`invalid ${brand} count for ${normalizedPath}`);
      }
    }
    if (entry.LobeChat === undefined && entry.LobeHub === undefined) {
      errors.push(`empty baseline entry: ${normalizedPath}`);
    }
  }

  return errors;
};

export const createBrandingBaseline = (
  candidates: BrandingLiteralCandidate[],
): BrandingBaseline => {
  const counts = new Map<string, { LobeChat: number; LobeHub: number }>();
  for (const candidate of candidates) {
    const current = counts.get(candidate.path) ?? { LobeChat: 0, LobeHub: 0 };
    current[candidate.brand] += 1;
    counts.set(candidate.path, current);
  }

  const entries = [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([entryPath, count]) => ({
      ...(count.LobeChat > 0 ? { LobeChat: count.LobeChat } : {}),
      ...(count.LobeHub > 0 ? { LobeHub: count.LobeHub } : {}),
      category: 'legacy-user-visible' as const,
      path: entryPath,
    }));

  return {
    entries,
    policy: BRANDING_BASELINE_POLICY,
    version: BRANDING_BASELINE_VERSION,
  };
};
