import { createHash } from 'node:crypto';
import path from 'node:path';

import ts from 'typescript';

import type { BrandingFormatFragment } from './brandingFormatFragments';
import {
  collectCssFragments,
  collectHtmlFragments,
  collectPlainTextFragments,
  collectYamlFragments,
} from './brandingFormatFragments';

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
  | 'stable-code-key'
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
  propertyKey?: boolean;
}

interface LiteralFragment extends BrandingFormatFragment {
  context: LiteralContext;
}

const fingerprint = (input: string): string =>
  createHash('sha256').update(input).digest('hex').slice(0, 24);

const syntaxPrinter = ts.createPrinter({ removeComments: true });

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
  let value = input.normalize('NFKC').replaceAll(DEFAULT_IGNORABLE_RE, '').replaceAll('\0', '');

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

const syntaxFingerprint = (node: ts.Node | undefined, sourceFile: ts.SourceFile): string =>
  fingerprint(
    node
      ? syntaxPrinter.printNode(ts.EmitHint.Unspecified, node, sourceFile).replaceAll(/\s+/gu, ' ')
      : '<none>',
  );

const jsxDescriptor = (node: ts.JsxElement, sourceFile: ts.SourceFile): string => {
  const opening = node.openingElement;
  let id = '';
  const classes: string[] = [];
  for (const property of opening.attributes.properties) {
    if (!ts.isJsxAttribute(property) || !property.initializer) continue;
    const name = property.name.getText(sourceFile);
    const value = ts.isStringLiteral(property.initializer) ? property.initializer.text : undefined;
    if (!value) continue;
    if (name === 'id') id = value;
    if (name === 'class' || name === 'className') classes.push(...value.split(/\s+/u));
  }
  classes.sort((left, right) => left.localeCompare(right, 'en'));
  return `${opening.tagName.getText(sourceFile)}${id ? `#${id}` : ''}${classes
    .filter(Boolean)
    .map((name) => `.${name}`)
    .join('')}`;
};

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
      if (parent.name === current) context.propertyKey = true;
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
      parts.push(`jsx:${jsxDescriptor(parent, sourceFile)}`);
    } else if (ts.isIfStatement(parent)) {
      const branch =
        current === parent.thenStatement
          ? 'then'
          : current === parent.elseStatement
            ? 'else'
            : 'condition';
      parts.push(`if:${syntaxFingerprint(parent.expression, sourceFile)}:${branch}`);
    } else if (ts.isConditionalExpression(parent)) {
      const branch =
        current === parent.whenTrue ? 'true' : current === parent.whenFalse ? 'false' : 'condition';
      parts.push(`conditional:${syntaxFingerprint(parent.condition, sourceFile)}:${branch}`);
    } else if (ts.isCaseClause(parent)) {
      parts.push(`case:${syntaxFingerprint(parent.expression, sourceFile)}`);
    } else if (ts.isDefaultClause(parent)) {
      parts.push('case:default');
    } else if (ts.isWhileStatement(parent) || ts.isDoStatement(parent)) {
      parts.push(
        `loop:${ts.SyntaxKind[parent.kind]}:${syntaxFingerprint(parent.expression, sourceFile)}`,
      );
    } else if (ts.isForStatement(parent)) {
      parts.push(`loop:for:${syntaxFingerprint(parent.condition, sourceFile)}`);
    } else if (ts.isForInStatement(parent) || ts.isForOfStatement(parent)) {
      parts.push(
        `loop:${ts.SyntaxKind[parent.kind]}:${syntaxFingerprint(parent.expression, sourceFile)}`,
      );
    } else if (
      ts.isBinaryExpression(parent) &&
      [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
      ].includes(parent.operatorToken.kind)
    ) {
      const branch = current === parent.left ? 'left' : 'right';
      parts.push(
        `logical:${ts.SyntaxKind[parent.operatorToken.kind]}:${syntaxFingerprint(parent.left, sourceFile)}:${branch}`,
      );
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

interface LexicalResolution {
  found: boolean;
  value?: string;
}

const bindingMatches = (name: ts.BindingName | undefined, identifier: string): boolean => {
  if (!name) return false;
  if (ts.isIdentifier(name)) return name.text === identifier;
  return name.elements.some(
    (element) => ts.isBindingElement(element) && bindingMatches(element.name, identifier),
  );
};

interface StaticMemberResolution {
  expression?: ts.Expression;
  found: boolean;
}

const staticPropertyName = (
  name: ts.PropertyName | undefined,
  sourceFile: ts.SourceFile,
  seen: Set<ts.Node>,
): string | undefined => {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) {
    return evaluateStaticString(name.expression, sourceFile, new Set(seen));
  }
  return undefined;
};

const resolveObjectMember = (
  object: ts.ObjectLiteralExpression,
  propertyName: string,
  sourceFile: ts.SourceFile,
  seen: Set<ts.Node>,
): StaticMemberResolution => {
  for (let index = object.properties.length - 1; index >= 0; index -= 1) {
    const property = object.properties[index]!;
    if (ts.isSpreadAssignment(property)) return { found: true };
    const name = staticPropertyName(property.name, sourceFile, seen);
    if (name === undefined) return { found: true };
    if (name !== propertyName) continue;
    if (ts.isPropertyAssignment(property)) return { expression: property.initializer, found: true };
    if (ts.isShorthandPropertyAssignment(property))
      return { expression: property.name, found: true };
    return { found: true };
  }
  return { found: false };
};

const resolveArrayMember = (
  array: ts.ArrayLiteralExpression,
  targetIndex: number,
): StaticMemberResolution => {
  for (let index = 0; index <= targetIndex; index += 1) {
    const element = array.elements[index];
    if (!element || ts.isOmittedExpression(element)) {
      if (index === targetIndex) return { found: false };
      continue;
    }
    if (ts.isSpreadElement(element)) return { found: true };
    if (index === targetIndex) return { expression: element, found: true };
  }
  return { found: false };
};

const isStaticUndefined = (node: ts.Expression | undefined): boolean =>
  Boolean(node && ts.isIdentifier(node) && node.text === 'undefined');

const resolveBindingString = (
  name: ts.BindingName,
  initializer: ts.Expression | undefined,
  identifier: string,
  sourceFile: ts.SourceFile,
  seen: Set<ts.Node>,
): string | undefined => {
  if (ts.isIdentifier(name)) {
    return name.text === identifier && initializer
      ? evaluateStaticString(initializer, sourceFile, seen)
      : undefined;
  }

  if (ts.isObjectBindingPattern(name)) {
    if (!initializer || !ts.isObjectLiteralExpression(initializer)) return undefined;
    for (const element of name.elements) {
      if (!bindingMatches(element.name, identifier)) continue;
      const propertyName =
        staticPropertyName(element.propertyName, sourceFile, seen) ??
        (ts.isIdentifier(element.name) ? element.name.text : undefined);
      if (!propertyName) return undefined;
      const member = resolveObjectMember(initializer, propertyName, sourceFile, seen);
      if (member.found && !member.expression) return undefined;
      const selected =
        !member.found || isStaticUndefined(member.expression)
          ? element.initializer
          : member.expression;
      return resolveBindingString(element.name, selected, identifier, sourceFile, seen);
    }
    return undefined;
  }

  if (!initializer || !ts.isArrayLiteralExpression(initializer)) return undefined;
  for (const [index, element] of name.elements.entries()) {
    if (!ts.isBindingElement(element) || !bindingMatches(element.name, identifier)) continue;
    const member = resolveArrayMember(initializer, index);
    if (member.found && !member.expression) return undefined;
    const selected =
      !member.found || isStaticUndefined(member.expression)
        ? element.initializer
        : member.expression;
    return resolveBindingString(element.name, selected, identifier, sourceFile, seen);
  }
  return undefined;
};

const resolveLexicalIdentifier = (
  identifier: ts.Identifier,
  sourceFile: ts.SourceFile,
  seen: Set<ts.Node>,
): LexicalResolution => {
  let scope: ts.Node | undefined = identifier.parent;
  while (scope) {
    if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
      for (const statement of scope.statements) {
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (!bindingMatches(declaration.name, identifier.text)) continue;
            if (
              !(statement.declarationList.flags & ts.NodeFlags.Const) ||
              !declaration.initializer
            ) {
              return { found: true };
            }
            return {
              found: true,
              value: resolveBindingString(
                declaration.name,
                declaration.initializer,
                identifier.text,
                sourceFile,
                seen,
              ),
            };
          }
        }
        if (
          (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
          statement.name?.text === identifier.text
        ) {
          return { found: true };
        }
      }
    }
    if (ts.isFunctionLike(scope)) {
      if (scope.parameters.some((parameter) => bindingMatches(parameter.name, identifier.text))) {
        return { found: true };
      }
      if (
        'name' in scope &&
        scope.name &&
        ts.isIdentifier(scope.name) &&
        scope.name.text === identifier.text
      ) {
        return { found: true };
      }
    }
    if (
      ts.isCatchClause(scope) &&
      bindingMatches(scope.variableDeclaration?.name, identifier.text)
    ) {
      return { found: true };
    }
    scope = scope.parent;
  }
  return { found: false };
};

const evaluateStaticString = (
  node: ts.Node,
  sourceFile: ts.SourceFile,
  seen = new Set<ts.Node>(),
): string | undefined => {
  if (seen.has(node)) return undefined;
  seen.add(node);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) {
    return resolveLexicalIdentifier(node, sourceFile, seen).value;
  }
  if (ts.isParenthesizedExpression(node))
    return evaluateStaticString(node.expression, sourceFile, seen);
  if (ts.isJsxExpression(node) && node.expression)
    return evaluateStaticString(node.expression, sourceFile, seen);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = evaluateStaticString(node.left, sourceFile, new Set(seen));
    const right = evaluateStaticString(node.right, sourceFile, new Set(seen));
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const expression = evaluateStaticString(span.expression, sourceFile, new Set(seen));
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
      const value = evaluateStaticString(node, sourceFile);
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

const normalizeFragment = (text: string): string =>
  decodeBrandingText(text).replaceAll(/\s+/gu, ' ').trim();

const classifyAllowedOccurrence = (
  filePath: string,
  fragment: LiteralFragment,
  normalizedText: string,
  matchIndex: number,
): BrandingAllowedCategory | undefined => {
  if (isLegalAttributionPath(filePath)) return 'legal-attribution';

  // Object/JSON property names are lookup identifiers rather than rendered copy. The value is
  // visited independently, so a user-visible brand literal cannot hide behind this classification.
  if (fragment.context.propertyKey) return 'stable-code-key';

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
    fragments = yaml.fragments.map((fragment) => ({ ...fragment, context: {} }));
    errors = yaml.errors;
  } else if (extension === '.html') {
    fragments = collectHtmlFragments(source).map((fragment) => ({ ...fragment, context: {} }));
  } else if (['.css', '.less', '.scss'].includes(extension)) {
    fragments = collectCssFragments(source).map((fragment) => ({ ...fragment, context: {} }));
  } else {
    fragments = collectPlainTextFragments(source).map((fragment) => ({ ...fragment, context: {} }));
  }

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
