/**
 * Streaming-safe filter for chatgpt.com image-search / bento tool-call JSON.
 *
 * Those calls arrive as a leading `{"layout":"bento",…}` object — sometimes as
 * their own message (recipient/channel patched in later), sometimes as the first
 * string part of the visible answer. `text.delta` is additive, so a prefix that
 * *could still become* that object must be withheld, not emitted and later
 * regretted.
 *
 * Narrow on purpose: only an object whose first key/value is `layout: "bento"`.
 * `{"name":"ok"}` diverges at the key and streams. Arbitrary JSON is never
 * stripped.
 */

const isJsonWs = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

const skipWs = (text: string, index: number): number => {
  let i = index;
  while (i < text.length && isJsonWs(text[i]!)) i += 1;
  return i;
};

const matchLiteral = (text: string, index: number, literal: string): number | 'fail' | 'prefix' => {
  for (let offset = 0; offset < literal.length; offset += 1) {
    if (index + offset >= text.length) return 'prefix';
    if (text[index + offset] !== literal[offset]) return 'fail';
  }
  return index + literal.length;
};

/**
 * Index past the matching `}` of the object that starts at `start`, or `null`
 * when the object is still open. Strings (and their escapes) are skipped so a
 * brace inside a query string cannot close the object.
 */
const endOfJsonObject = (text: string, start: number): number | null => {
  if (text[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return null;
};

const asRecord = (value: unknown): Record<string, any> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, any>)
    : undefined;

type BentoScan = { rest: string; status: 'complete' } | { status: 'other' } | { status: 'prefix' };

/**
 * Walk `{"layout":"bento"` (JSON whitespace allowed) as far as `text` goes.
 * Once that value is confirmed, wait for the wrapping object to close.
 */
const scanBentoCandidate = (text: string): BentoScan => {
  let index = skipWs(text, 0);
  if (index >= text.length) return { status: 'other' };

  const brace = matchLiteral(text, index, '{');
  if (brace === 'fail') return { status: 'other' };
  if (brace === 'prefix') return { status: 'prefix' };

  index = skipWs(text, brace);
  if (index >= text.length) return { status: 'prefix' };

  const key = matchLiteral(text, index, '"layout"');
  if (key === 'fail') return { status: 'other' };
  if (key === 'prefix') return { status: 'prefix' };

  index = skipWs(text, key);
  if (index >= text.length) return { status: 'prefix' };

  const colon = matchLiteral(text, index, ':');
  if (colon === 'fail') return { status: 'other' };
  if (colon === 'prefix') return { status: 'prefix' };

  index = skipWs(text, colon);
  if (index >= text.length) return { status: 'prefix' };

  const value = matchLiteral(text, index, '"bento"');
  if (value === 'fail') return { status: 'other' };
  if (value === 'prefix') return { status: 'prefix' };

  const objectStart = skipWs(text, 0);
  const objectEnd = endOfJsonObject(text, objectStart);
  if (objectEnd === null) return { status: 'prefix' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(objectStart, objectEnd));
  } catch {
    return { status: 'other' };
  }
  if (asRecord(parsed)?.layout !== 'bento') return { status: 'other' };

  return { rest: text.slice(objectEnd).replace(/^\s+/, ''), status: 'complete' };
};

export interface BentoTextResult {
  /**
   * The whole candidate was a bento object (no remainder). Callers should latch
   * `ignored` once the message can no longer grow.
   */
  ignored: boolean;
  /** User-facing text after dropping a complete leading bento object. */
  text: string;
  /** Still a prefix of `{"layout":"bento"…}` — do not emit or raise high-water. */
  withhold: boolean;
}

export const inspectBentoText = (candidate: string): BentoTextResult => {
  const scan = scanBentoCandidate(candidate);
  if (scan.status === 'prefix') return { ignored: false, text: '', withhold: true };
  if (scan.status === 'complete') {
    const empty = scan.rest.length === 0;
    return { ignored: empty, text: scan.rest, withhold: empty };
  }
  return { ignored: false, text: candidate, withhold: false };
};

/** Drop a leading complete/partial bento object; used on the post-turn poll path. */
export const stripBentoLayout = (candidate: string): string => {
  const result = inspectBentoText(candidate);
  return result.withhold ? '' : result.text;
};
