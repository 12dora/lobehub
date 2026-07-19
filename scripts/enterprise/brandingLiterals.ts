import { createHash } from 'node:crypto';
import path from 'node:path';

import ts from 'typescript';
import type { Node as YAMLNode } from 'yaml';
import { isMap, isNode, isScalar, isSeq, LineCounter, parseDocument } from 'yaml';

export const BRANDING_BASELINE_VERSION = 2;
export const BRANDING_BASELINE_POLICY =
  'Known legacy user-visible occurrences keyed by canonical repository path, semantic locator, normalized-content fingerprint, and multiset count. Line moves are stable; moves, renames, replacements, additions, and removals require review.';

export const BRANDING_DIRECTORY_ROOTS = ['apps', 'locales', 'packages', 'src'] as const;
export const BRANDING_ROOT_HTML_FILES = [
  'index.auth.html',
  'index.html',
  'index.mobile.html',
] as const;

export const MAX_BRANDING_TEXT_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_BRANDING_BINARY_FILE_BYTES = 64 * 1024 * 1024;

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
  '.jsonl',
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
  '.bmp',
  '.dmg',
  '.gif',
  '.gz',
  '.ico',
  '.icns',
  '.jar',
  '.jpeg',
  '.jpg',
  '.mov',
  '.mp3',
  '.mp4',
  '.otf',
  '.pdf',
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

const DOCUMENT_EXTENSIONS = new Set(['.md', '.mdx', '.rst', '.snap']);
const TOOLING_TEXT_FILES = new Set(['.npmrc']);
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
const YAML_EXTENSIONS = new Set(['.yaml', '.yml']);
const TEST_FILE_RE = /(?:^|\/)\S+\.(?:e2e|integration|spec|test)\.[cm]?[jt]sx?$/i;
const LEGAL_FILE_RE = /(?:^|\/)(?:authors|copying|license|notice)(?:\.[^/]*)?$/i;
const BRAND_RE = /lobehub|lobechat/giu;
const DEFAULT_IGNORABLE_RE = /\p{Default_Ignorable_Code_Point}/gu;
const UNSAFE_SLASH_RE = /[\u2044\u2215\u29F8\uFF0F\uFF3C]/u;
const PERCENT_SEQUENCE_RE = /(?:%[\dA-F]{2})+/giu;
const DATABASE_CALLS = new Set([
  'check',
  'foreignKey',
  'index',
  'pgSchema',
  'pgTable',
  'primaryKey',
  'uniqueIndex',
]);

export type BrandingName = 'LobeChat' | 'LobeHub';

export type BrandingAllowedCategory =
  | 'internal-package-or-path'
  | 'legal-attribution'
  | 'stable-database-id'
  | 'stable-protocol-or-storage-id'
  | 'stable-url-or-email';

export interface BrandingBaselineEntry {
  brand: BrandingName;
  category: 'legacy-user-visible';
  count: number;
  fingerprint: string;
  locator: string;
  path: string;
  preview: string;
}

export interface BrandingBaseline {
  entries: BrandingBaselineEntry[];
  policy: string;
  version: number;
}

export interface BrandingLiteralCandidate {
  brand: BrandingName;
  column: number;
  fingerprint: string;
  line: number;
  locator: string;
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

interface LiteralContext {
  argumentIndex?: number;
  callName?: string;
  moduleSpecifier?: boolean;
}

interface LiteralFragment {
  column: number;
  context: LiteralContext;
  line: number;
  locator: string;
  text: string;
}

const fingerprint = (input: string): string =>
  createHash('sha256').update(input).digest('hex').slice(0, 24);

const decodeCodePoint = (value: string, radix: number): string => {
  const codePoint = Number.parseInt(value, radix);
  if (!Number.isSafeInteger(codePoint) || codePoint > 0x10ffff) return '';
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return '';
  }
};

const decodePercentSequences = (input: string): string =>
  input.replaceAll(PERCENT_SEQUENCE_RE, (sequence) => {
    try {
      return decodeURIComponent(sequence);
    } catch {
      return sequence;
    }
  });

/** Deterministic, non-executing canonicalization used only for literal detection. */
export const decodeBrandingText = (input: string): string => {
  let value = input
    .normalize('NFKC')
    .replaceAll(DEFAULT_IGNORABLE_RE, '')
    .replaceAll('\0', '')
    .replaceAll(/<!--[\s\S]*?-->/gu, '')
    .replaceAll(/\/\*[\s\S]*?\*\//gu, '');

  for (let iteration = 0; iteration < 3; iteration += 1) {
    const decoded = decodePercentSequences(
      value
        .replaceAll(/\\u\{([\dA-F]{1,6})\}/giu, (_, code: string) => decodeCodePoint(code, 16))
        .replaceAll(/\\u([\dA-F]{4})/giu, (_, code: string) => decodeCodePoint(code, 16))
        .replaceAll(/\\x([\dA-F]{2})/giu, (_, code: string) => decodeCodePoint(code, 16))
        .replaceAll(/&#x([\dA-F]{1,6});?/giu, (_, code: string) => decodeCodePoint(code, 16))
        .replaceAll(/&#(\d{1,7});?/gu, (_, code: string) => decodeCodePoint(code, 10)),
    )
      .normalize('NFKC')
      .replaceAll(DEFAULT_IGNORABLE_RE, '')
      .replaceAll('\0', '');
    if (decoded === value) break;
    value = decoded;
  }

  return value;
};

export const normalizeRepositoryPath = (input: string): string => {
  if (!input || input.includes('\0') || UNSAFE_SLASH_RE.test(input)) {
    throw new Error(`unsafe repository path: ${JSON.stringify(input)}`);
  }

  let decoded = input.normalize('NFKC');
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

export const isExplicitTextFile = (filePath: string): boolean => {
  const normalized = normalizeRepositoryPath(filePath);
  const basename = path.posix.basename(normalized).toLowerCase();
  return (
    TOOLING_TEXT_FILES.has(basename) ||
    BRANDING_TEXT_EXTENSIONS.has(path.posix.extname(normalized).toLowerCase())
  );
};

export const isLegalAttributionPath = (filePath: string): boolean =>
  LEGAL_FILE_RE.test(normalizeRepositoryPath(filePath));

const getScriptKind = (filePath: string): ts.ScriptKind => {
  const extension = path.posix.extname(filePath).toLowerCase();
  if (['.js', '.cjs', '.mjs'].includes(extension)) return ts.ScriptKind.JS;
  if (extension === '.jsx') return ts.ScriptKind.JSX;
  if (['.json', '.jsonc'].includes(extension)) return ts.ScriptKind.JSON;
  if (extension === '.tsx') return ts.ScriptKind.TSX;
  return ts.ScriptKind.TS;
};

const nodeName = (node: ts.Node, sourceFile: ts.SourceFile): string | undefined => {
  const named = node as ts.Node & { name?: ts.Node };
  if (!named.name) return undefined;
  return named.name.getText(sourceFile).replaceAll(/\s+/gu, '').slice(0, 100);
};

const callExpressionName = (node: ts.CallExpression, sourceFile: ts.SourceFile): string =>
  node.expression.getText(sourceFile).replaceAll(/\s+/gu, '').slice(0, 100);

const buildScriptLocator = (
  node: ts.Node,
  sourceFile: ts.SourceFile,
): { context: LiteralContext; locator: string } => {
  const parts: string[] = [];
  const context: LiteralContext = {};
  let current: ts.Node = node;

  while (current.parent) {
    const parent = current.parent;
    if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
      parts.push(`property:${nodeName(parent, sourceFile) ?? '<computed>'}`);
    } else if (ts.isVariableDeclaration(parent)) {
      parts.push(`variable:${nodeName(parent, sourceFile) ?? '<binding>'}`);
    } else if (
      ts.isFunctionDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isClassDeclaration(parent)
    ) {
      parts.push(`${ts.SyntaxKind[parent.kind]}:${nodeName(parent, sourceFile) ?? '<anonymous>'}`);
    } else if (ts.isArrayLiteralExpression(parent)) {
      parts.push(`element:${parent.elements.indexOf(current as ts.Expression)}`);
    } else if (ts.isCallExpression(parent)) {
      const argumentIndex = parent.arguments.indexOf(current as ts.Expression);
      if (argumentIndex >= 0) {
        const callName = callExpressionName(parent, sourceFile);
        parts.push(`call:${callName}:arg:${argumentIndex}`);
        context.argumentIndex ??= argumentIndex;
        context.callName ??= callName;
      }
    } else if (ts.isJsxAttribute(parent)) {
      parts.push(`jsx-attribute:${parent.name.getText(sourceFile)}`);
    } else if (ts.isJsxElement(parent)) {
      parts.push(`jsx:${parent.openingElement.tagName.getText(sourceFile)}`);
    }

    if (
      (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
      parent.moduleSpecifier === current
    ) {
      context.moduleSpecifier = true;
      parts.push('module-specifier');
    }
    current = parent;
  }

  return {
    context,
    locator:
      parts.length > 0 ? parts.reverse().join('/') : `syntax:${ts.SyntaxKind[node.parent.kind]}`,
  };
};

const evaluateStaticString = (
  node: ts.Node,
  constants: ReadonlyMap<string, string> = new Map(),
): string | undefined => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) return constants.get(node.text);
  if (ts.isParenthesizedExpression(node)) return evaluateStaticString(node.expression, constants);
  if (ts.isJsxExpression(node) && node.expression)
    return evaluateStaticString(node.expression, constants);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = evaluateStaticString(node.left, constants);
    const right = evaluateStaticString(node.right, constants);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const expression = evaluateStaticString(span.expression, constants);
      if (expression === undefined) return undefined;
      value += expression + span.literal.text;
    }
    return value;
  }
  return undefined;
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
  const constants = new Map<string, string>();

  for (let iteration = 0; iteration < 3; iteration += 1) {
    for (const statement of sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      if (!(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        const value = evaluateStaticString(declaration.initializer, constants);
        if (value !== undefined) constants.set(declaration.name.text, value);
      }
    }
  }

  const addFragment = (node: ts.Node, text: string) => {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const { context, locator } = buildScriptLocator(node, sourceFile);
    fragments.push({
      column: position.character + 1,
      context,
      line: position.line + 1,
      locator,
      text,
    });
  };

  const visit = (node: ts.Node) => {
    const isComposite =
      ts.isBinaryExpression(node) || ts.isTemplateExpression(node) || ts.isJsxExpression(node);
    if (isComposite) {
      const value = evaluateStaticString(node, constants);
      if (value !== undefined) {
        addFragment(node, value);
        return;
      }
    }
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      addFragment(node, node.text);
      return;
    }
    if (
      ts.isIdentifier(node) &&
      ts.isPropertyAssignment(node.parent) &&
      node.parent.name === node &&
      /^(?:lobehub|lobechat)$/iu.test(node.text)
    ) {
      addFragment(node, node.text);
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return fragments;
};

const yamlKey = (node: unknown): string => {
  if (isScalar(node)) return String(node.value);
  if (isNode(node)) return node.toString();
  return String(node);
};

const collectYamlFragments = (
  filePath: string,
  source: string,
): { errors: string[]; fragments: LiteralFragment[] } => {
  const lineCounter = new LineCounter();
  const document = parseDocument(source, { lineCounter, prettyErrors: false, strict: true });
  const errors = document.errors.map((error) => `${filePath}: invalid YAML: ${error.message}`);
  const fragments: LiteralFragment[] = [];

  const visit = (node: YAMLNode | null, keyPath: string[]) => {
    if (!node) return;
    if (isMap(node)) {
      for (const pair of node.items)
        visit(isNode(pair.value) ? pair.value : null, [...keyPath, yamlKey(pair.key)]);
      return;
    }
    if (isSeq(node)) {
      for (const [index, item] of node.items.entries()) {
        visit(isNode(item) ? item : null, [...keyPath, `[${index}]`]);
      }
      return;
    }
    if (!isScalar(node) || typeof node.value !== 'string') return;
    const offset = node.range?.[0] ?? 0;
    const position = lineCounter.linePos(offset);
    fragments.push({
      column: position.col,
      context: {},
      line: position.line,
      locator: `yaml:${keyPath.join('.') || '<root>'}`,
      text: node.value,
    });
  };

  visit(isNode(document.contents) ? document.contents : null, []);
  return { errors, fragments };
};

const normalizeFragment = (text: string): string =>
  decodeBrandingText(text).replaceAll(/\s+/gu, ' ').trim();

const collectPlainTextFragments = (source: string): LiteralFragment[] => {
  const fragments: LiteralFragment[] = [];
  for (const [index, text] of source.split(/\r?\n/u).entries()) {
    const normalized = normalizeFragment(text);
    if (!BRAND_RE.test(normalized)) {
      BRAND_RE.lastIndex = 0;
      continue;
    }
    BRAND_RE.lastIndex = 0;
    const locatorShape = normalized.replaceAll(BRAND_RE, '<brand>');
    BRAND_RE.lastIndex = 0;
    fragments.push({
      column: 1,
      context: {},
      line: index + 1,
      locator: `text:${fingerprint(locatorShape)}`,
      text,
    });
  }
  return fragments;
};

const classifyAllowedOccurrence = (
  filePath: string,
  fragment: LiteralFragment,
  normalizedText: string,
  matchIndex: number,
): BrandingAllowedCategory | undefined => {
  if (isLegalAttributionPath(filePath)) return 'legal-attribution';

  if (/^(?:https?:\/\/|mailto:|[\w.+-]+@)\S*(?:lobehub|lobechat)\S*$/iu.test(normalizedText)) {
    return 'stable-url-or-email';
  }
  if (/^@(?:lobehub|lobechat)\/[a-z\d][\w./-]*$/iu.test(normalizedText)) {
    return 'internal-package-or-path';
  }
  if (fragment.context.moduleSpecifier && /^\S*(?:lobehub|lobechat)\S*$/iu.test(normalizedText)) {
    return 'internal-package-or-path';
  }

  if (
    fragment.context.argumentIndex === 0 &&
    fragment.context.callName &&
    DATABASE_CALLS.has(fragment.context.callName) &&
    /^(?:lobehub|lobechat)[a-z\d_]*$/u.test(normalizedText)
  ) {
    return 'stable-database-id';
  }
  if (path.posix.extname(filePath).toLowerCase() === '.sql') {
    const tokenStart = normalizedText.slice(0, matchIndex).search(/\w+$/u);
    const prefixLength = tokenStart < 0 ? 0 : matchIndex - tokenStart;
    const token = normalizedText.slice(matchIndex - prefixLength).match(/^\w+/u)?.[0];
    if (
      token &&
      /^(?:lobehub|lobechat)[a-z\d_]*$/u.test(token) &&
      /\b(?:ALTER|CREATE|DROP)\s+(?:INDEX|SCHEMA|TABLE|TYPE)\b/iu.test(normalizedText)
    ) {
      return 'stable-database-id';
    }
  }

  if (
    normalizedText === 'lobehub' ||
    normalizedText === 'lobechat' ||
    /^(?:lobehub|lobechat)(?::[a-z\d][\w.-]*)+$/u.test(normalizedText) ||
    /^(?:LOBEHUB|LOBECHAT)(?:_[A-Z\d]+)+$/u.test(normalizedText) ||
    /^(?:LobeHub|LobeChat)_[\w.:]+$/u.test(normalizedText) ||
    /^(?:LobeHub|LobeChat) Desktop\/[\w.${}-]+$/u.test(normalizedText) ||
    /^lobehub-(?:admin-reauth|desktop|market|mobile)$/u.test(normalizedText)
  ) {
    return 'stable-protocol-or-storage-id';
  }

  return undefined;
};

const previewLiteral = (text: string): string =>
  text.length > 140 ? `${text.slice(0, 137)}...` : text;

export const scanBrandingFile = (filePath: string, source: string): BrandingFileScanResult => {
  let normalizedPath: string;
  try {
    normalizedPath = normalizeRepositoryPath(filePath);
  } catch (error) {
    return { allowed: [], candidates: [], errors: [(error as Error).message] };
  }
  if (isExcludedBrandingPath(normalizedPath)) return { allowed: [], candidates: [], errors: [] };

  const extension = path.posix.extname(normalizedPath).toLowerCase();
  let fragments: LiteralFragment[];
  let errors: string[] = [];
  if (SCRIPT_EXTENSIONS.has(extension)) fragments = collectScriptFragments(normalizedPath, source);
  else if (YAML_EXTENSIONS.has(extension)) {
    const yaml = collectYamlFragments(normalizedPath, source);
    fragments = yaml.fragments;
    errors = yaml.errors;
  } else fragments = collectPlainTextFragments(source);

  const allowed: BrandingAllowedLiteral[] = [];
  const candidates: BrandingLiteralCandidate[] = [];
  for (const fragment of fragments) {
    const normalizedText = normalizeFragment(fragment.text);
    for (const match of normalizedText.matchAll(BRAND_RE)) {
      const brand: BrandingName =
        match[0].toLocaleLowerCase('en-US') === 'lobehub' ? 'LobeHub' : 'LobeChat';
      const candidate = {
        brand,
        column: fragment.column + (match.index ?? 0),
        fingerprint: fingerprint(normalizedText),
        line: fragment.line,
        locator: fragment.locator,
        path: normalizedPath,
        preview: previewLiteral(normalizedText),
      } satisfies BrandingLiteralCandidate;
      const category = classifyAllowedOccurrence(
        normalizedPath,
        fragment,
        normalizedText,
        match.index ?? 0,
      );
      if (category) allowed.push({ ...candidate, category });
      else candidates.push(candidate);
    }
  }
  return { allowed, candidates, errors };
};

export const brandingOccurrenceKey = (
  occurrence: Pick<BrandingBaselineEntry, 'brand' | 'fingerprint' | 'locator' | 'path'>,
): string =>
  [occurrence.path, occurrence.locator, occurrence.brand, occurrence.fingerprint].join('\0');

export const validateBrandingBaseline = (baseline: BrandingBaseline): string[] => {
  const errors: string[] = [];
  if (!baseline || !Array.isArray(baseline.entries))
    return ['branding baseline must contain entries'];
  if (baseline.version !== BRANDING_BASELINE_VERSION) {
    errors.push(
      `unsupported branding baseline version ${String(baseline.version)} (expected ${BRANDING_BASELINE_VERSION})`,
    );
  }
  if (baseline.policy !== BRANDING_BASELINE_POLICY) {
    errors.push('branding baseline policy text is missing or changed');
  }

  let previousKey = '';
  const seenKeys = new Set<string>();
  const caseFoldedPaths = new Map<string, string>();
  for (const entry of baseline.entries) {
    let normalizedPath: string;
    try {
      normalizedPath = normalizeRepositoryPath(entry.path);
    } catch (error) {
      errors.push((error as Error).message);
      continue;
    }
    if (normalizedPath !== entry.path) errors.push(`baseline path is not canonical: ${entry.path}`);
    const foldedPath = normalizedPath.toLocaleLowerCase('en-US');
    const existingCase = caseFoldedPaths.get(foldedPath);
    if (existingCase && existingCase !== normalizedPath) {
      errors.push(`case-colliding baseline paths: ${existingCase} and ${normalizedPath}`);
    }
    caseFoldedPaths.set(foldedPath, normalizedPath);

    const key = brandingOccurrenceKey(entry);
    if (seenKeys.has(key)) errors.push(`duplicate baseline occurrence: ${normalizedPath}`);
    seenKeys.add(key);
    if (previousKey && previousKey.localeCompare(key, 'en') >= 0) {
      errors.push(`baseline entries must be sorted: ${previousKey} before ${key}`);
    }
    previousKey = key;

    if (entry.category !== 'legacy-user-visible') errors.push(`invalid baseline category: ${key}`);
    if (!Number.isSafeInteger(entry.count) || entry.count <= 0)
      errors.push(`invalid count: ${key}`);
    if (!/^[\da-f]{24}$/u.test(entry.fingerprint)) errors.push(`invalid fingerprint: ${key}`);
    if (!entry.locator || !entry.preview) errors.push(`incomplete occurrence identity: ${key}`);
  }
  return errors;
};

export const createBrandingBaseline = (
  candidates: BrandingLiteralCandidate[],
): BrandingBaseline => {
  const grouped = new Map<string, BrandingBaselineEntry>();
  for (const candidate of candidates) {
    const key = brandingOccurrenceKey(candidate);
    const current = grouped.get(key);
    if (current) current.count += 1;
    else {
      grouped.set(key, {
        brand: candidate.brand,
        category: 'legacy-user-visible',
        count: 1,
        fingerprint: candidate.fingerprint,
        locator: candidate.locator,
        path: candidate.path,
        preview: candidate.preview,
      });
    }
  }
  return {
    entries: [...grouped.values()].sort((left, right) =>
      brandingOccurrenceKey(left).localeCompare(brandingOccurrenceKey(right), 'en'),
    ),
    policy: BRANDING_BASELINE_POLICY,
    version: BRANDING_BASELINE_VERSION,
  };
};
