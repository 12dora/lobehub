import { createHash } from 'node:crypto';

import { parseHTML } from 'linkedom';
import type { Node as YAMLNode } from 'yaml';
import { isMap, isNode, isScalar, isSeq, LineCounter, parseDocument } from 'yaml';

export interface BrandingFormatFragment {
  column: number;
  line: number;
  locator: string;
  text: string;
}

interface HtmlNodeLike {
  childNodes?: HtmlNodeLike[];
  data?: string;
  nodeType: number;
}

interface HtmlAttributeLike {
  name: string;
  value: string;
}

interface HtmlElementLike extends HtmlNodeLike {
  attributes?: Iterable<HtmlAttributeLike>;
  getAttribute: (name: string) => string | null;
  id?: string;
  localName?: string;
  textContent?: string | null;
}

const HTML_BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'button',
  'dd',
  'dialog',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'head',
  'header',
  'html',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'td',
  'th',
  'title',
  'tr',
  'ul',
]);

const shortFingerprint = (input: string): string =>
  createHash('sha256').update(input).digest('hex').slice(0, 16);

const lineAndColumn = (source: string, offset: number) => {
  const prefix = source.slice(0, Math.max(0, offset));
  const lines = prefix.split(/\r?\n/u);
  return { column: (lines.at(-1)?.length ?? 0) + 1, line: lines.length };
};

const decodeCssEscapes = (input: string): string =>
  input
    .replaceAll(/\\([\dA-F]{1,6})\s?/giu, (_, code: string) => {
      const codePoint = Number.parseInt(code, 16);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '';
    })
    .replaceAll(/\\([^\r\n])/gu, '$1');

const stripCssCommentsOutsideStrings = (source: string): string => {
  let output = '';
  let quote = '';
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? '';
    if (quote) {
      output += character;
      if (character === '\\') {
        output += source[index + 1] ?? '';
        index += 1;
      } else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      output += character;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        index += 1;
      }
      index += 1;
      continue;
    }
    output += character;
  }
  return output;
};

const splitCssDeclarations = (source: string): Array<{ offset: number; text: string }> => {
  const declarations: Array<{ offset: number; text: string }> = [];
  let quote = '';
  let parentheses = 0;
  let start = 0;
  for (let index = 0; index <= source.length; index += 1) {
    const character = source[index] ?? ';';
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '(') parentheses += 1;
    else if (character === ')') parentheses = Math.max(0, parentheses - 1);
    else if (character === ';' && parentheses === 0) {
      declarations.push({ offset: start, text: source.slice(start, index) });
      start = index + 1;
    }
  }
  return declarations;
};

const findCssColon = (source: string): number => {
  let quote = '';
  let parentheses = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? '';
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '(') parentheses += 1;
    else if (character === ')') parentheses = Math.max(0, parentheses - 1);
    else if (character === ':' && parentheses === 0) return index;
  }
  return -1;
};

const cssValueFragments = (value: string): string[] => {
  const fragments: string[] = [];
  let unquoted = '';
  let adjacent = '';
  let index = 0;
  const flushAdjacent = () => {
    if (adjacent) fragments.push(adjacent);
    adjacent = '';
  };

  while (index < value.length) {
    const character = value[index] ?? '';
    if (character !== '"' && character !== "'") {
      if (!/\s/u.test(character)) flushAdjacent();
      unquoted += character;
      index += 1;
      continue;
    }
    const quote = character;
    let stringValue = '';
    index += 1;
    while (index < value.length && value[index] !== quote) {
      const next = value[index] ?? '';
      if (next === '\\') {
        let escape = next;
        index += 1;
        while (index < value.length && /[\dA-F]/iu.test(value[index] ?? '') && escape.length <= 6) {
          escape += value[index];
          index += 1;
        }
        if (/\s/u.test(value[index] ?? '')) {
          escape += value[index];
          index += 1;
        } else if (escape.length === 1 && index < value.length) {
          escape += value[index];
          index += 1;
        }
        stringValue += decodeCssEscapes(escape);
      } else {
        stringValue += next;
        index += 1;
      }
    }
    index += 1;
    adjacent += stringValue;
    unquoted += ' ';
  }
  flushAdjacent();
  if (unquoted.trim()) fragments.push(decodeCssEscapes(unquoted));
  return fragments;
};

const findMatchingCssBrace = (source: string, opening: number): number => {
  let depth = 1;
  let quote = '';
  for (let index = opening + 1; index < source.length; index += 1) {
    const character = source[index] ?? '';
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return source.length;
};

export const collectCssFragments = (
  source: string,
  locatorPrefix = 'css',
): BrandingFormatFragment[] => {
  const sanitized = stripCssCommentsOutsideStrings(source);
  const fragments: BrandingFormatFragment[] = [];

  const parseRange = (start: number, end: number, ancestry: string[]) => {
    let cursor = start;
    while (cursor < end) {
      const opening = sanitized.indexOf('{', cursor);
      if (opening < 0 || opening >= end) break;
      const headerStart =
        Math.max(sanitized.lastIndexOf('}', opening - 1), sanitized.lastIndexOf(';', opening - 1)) +
        1;
      const header = sanitized.slice(Math.max(cursor, headerStart), opening).trim();
      const closing = findMatchingCssBrace(sanitized, opening);
      if (closing > end) break;
      if (header.startsWith('@')) {
        parseRange(opening + 1, closing, [
          ...ancestry,
          `at:${shortFingerprint(header.replaceAll(/\s+/gu, ' '))}`,
        ]);
      } else {
        const selector = header.replaceAll(/\s+/gu, ' ');
        const selectorLocator = `selector:${shortFingerprint(selector)}`;
        const body = sanitized.slice(opening + 1, closing);
        for (const declaration of splitCssDeclarations(body)) {
          const colon = findCssColon(declaration.text);
          if (colon < 0) continue;
          const property = declaration.text.slice(0, colon).trim().toLocaleLowerCase('en-US');
          if (!property) continue;
          const value = declaration.text.slice(colon + 1);
          for (const [valueIndex, text] of cssValueFragments(value).entries()) {
            const absoluteOffset = opening + 1 + declaration.offset + colon + 1;
            const position = lineAndColumn(source, absoluteOffset);
            fragments.push({
              ...position,
              locator: [
                locatorPrefix,
                ...ancestry,
                selectorLocator,
                `property:${property}`,
                `value:${valueIndex}`,
              ].join('/'),
              text,
            });
          }
        }
      }
      cursor = closing + 1;
    }
  };

  parseRange(0, sanitized.length, []);
  return fragments;
};

const htmlDescriptor = (element: HtmlElementLike): string => {
  const tag = (element.localName ?? 'element').toLocaleLowerCase('en-US');
  const id = element.id || element.getAttribute('id');
  const classNames = (element.getAttribute('class') || '')
    .split(/\s+/u)
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right, 'en'));
  return `${tag}${id ? `#${id}` : ''}${classNames.map((name) => `.${name}`).join('')}`;
};

export const collectHtmlFragments = (source: string): BrandingFormatFragment[] => {
  const { document } = parseHTML(source);
  const fragments: BrandingFormatFragment[] = [];
  const root = document.documentElement as unknown as HtmlElementLike | null;
  if (!root) return fragments;

  const add = (text: string, locator: string) => {
    if (!text.trim()) return;
    const rawOffset = source.indexOf(text.trim());
    fragments.push({ ...lineAndColumn(source, rawOffset < 0 ? 0 : rawOffset), locator, text });
  };

  const scanAttributes = (element: HtmlElementLike, ancestry: string[]) => {
    for (const attribute of element.attributes ?? []) {
      if (attribute.name === 'style') {
        const wrapped = `.inline { ${attribute.value} }`;
        fragments.push(...collectCssFragments(wrapped, `html:${ancestry.join('/')}/@style`));
      } else add(attribute.value, `html:${ancestry.join('/')}/@${attribute.name}`);
    }
  };

  const inlineText = (node: HtmlNodeLike, ancestry: string[]): string => {
    if (node.nodeType === 3) return node.data ?? '';
    if (node.nodeType !== 1) return '';
    const element = node as HtmlElementLike;
    const descriptor = htmlDescriptor(element);
    const nextAncestry = [...ancestry, descriptor];
    scanAttributes(element, nextAncestry);
    const tag = (element.localName ?? '').toLocaleLowerCase('en-US');
    if (tag === 'wbr') return '';
    if (tag === 'script' || tag === 'style') return '';
    return (element.childNodes ?? []).map((child) => inlineText(child, nextAncestry)).join('');
  };

  const walk = (element: HtmlElementLike, ancestry: string[]) => {
    const descriptor = htmlDescriptor(element);
    const nextAncestry = [...ancestry, descriptor];
    scanAttributes(element, nextAncestry);
    const tag = (element.localName ?? '').toLocaleLowerCase('en-US');
    if (tag === 'style') {
      fragments.push(
        ...collectCssFragments(element.textContent ?? '', `html:${nextAncestry.join('/')}/style`),
      );
      return;
    }
    if (tag === 'script') {
      add(element.textContent ?? '', `html:${nextAncestry.join('/')}/script`);
      return;
    }

    let run = '';
    let runIndex = 0;
    const flush = () => {
      add(run, `html:${nextAncestry.join('/')}/text-run:${runIndex}`);
      run = '';
      runIndex += 1;
    };
    for (const child of element.childNodes ?? []) {
      if (child.nodeType === 1) {
        const childElement = child as HtmlElementLike;
        const childTag = (childElement.localName ?? '').toLocaleLowerCase('en-US');
        if (HTML_BLOCK_TAGS.has(childTag)) {
          flush();
          walk(childElement, nextAncestry);
          continue;
        }
      }
      run += inlineText(child, nextAncestry);
    }
    flush();
  };

  walk(root, []);
  return fragments;
};

const yamlKey = (node: unknown): string => {
  if (isScalar(node)) return String(node.value);
  if (isNode(node)) return node.toString();
  return String(node);
};

export const collectYamlFragments = (
  filePath: string,
  source: string,
): { errors: string[]; fragments: BrandingFormatFragment[] } => {
  const lineCounter = new LineCounter();
  const document = parseDocument(source, { lineCounter, prettyErrors: false, strict: true });
  const errors = document.errors.map((error) => `${filePath}: invalid YAML: ${error.message}`);
  const fragments: BrandingFormatFragment[] = [];

  const addScalar = (node: YAMLNode, locator: string) => {
    if (!isScalar(node) || typeof node.value !== 'string') return;
    const position = lineCounter.linePos(node.range?.[0] ?? 0);
    fragments.push({ column: position.col, line: position.line, locator, text: node.value });
  };

  const visit = (node: YAMLNode | null, keyPath: string[]) => {
    if (!node) return;
    if (isMap(node)) {
      for (const pair of node.items) {
        const key = yamlKey(pair.key);
        if (isNode(pair.key))
          addScalar(pair.key, `yaml:${keyPath.join('.') || '<root>'}/key:${key}`);
        visit(isNode(pair.value) ? pair.value : null, [...keyPath, key]);
      }
      return;
    }
    if (isSeq(node)) {
      for (const [index, item] of node.items.entries()) {
        visit(isNode(item) ? item : null, [...keyPath, `[${index}]`]);
      }
      return;
    }
    addScalar(node, `yaml:${keyPath.join('.') || '<root>'}/value`);
  };

  visit(isNode(document.contents) ? document.contents : null, []);
  return { errors, fragments };
};

export const collectPlainTextFragments = (source: string): BrandingFormatFragment[] =>
  source
    .split(/\r?\n/u)
    .map((text, index) => ({
      column: 1,
      line: index + 1,
      locator: `text:${shortFingerprint(text.replaceAll(/\s+/gu, ' ').trim())}`,
      text,
    }))
    .filter(({ text }) => Boolean(text.trim()));
