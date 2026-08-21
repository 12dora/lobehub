/**
 * Streaming-safe filter for chatgpt.com image-search / bento tool-call JSON.
 *
 * Those calls arrive as a leading `{"layout":"bento",…}` object — sometimes as
 * their own message (recipient/channel patched in later), sometimes as the first
 * string part of the visible answer. `text.delta` is additive, so a prefix that
 * *could still become* that object must be withheld, not emitted and later
 * regretted.
 *
 * Two prefix classes, because they must not be treated the same once the
 * message is finished (or on a recovery poll):
 *
 * - **ambiguous** (`{`, `{"lay`, `{"layout":"ben`): still a prefix of
 *   `{"layout":"bento"…}`, but also of ordinary JSON. Withhold while streaming;
 *   release as text once the message can no longer grow.
 * - **confirmed** (`{"layout":"bento"` matched): drop, even if the object is
 *   still open. Arbitrary JSON is never stripped.
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

type BentoScan =
  | { rest: string; status: 'complete' }
  | { status: 'ambiguous' }
  | { status: 'confirmed-prefix' }
  | { status: 'other' };

/**
 * Walk `{"layout":"bento"` (JSON whitespace allowed) as far as `text` goes.
 * `"bento"` as the value is the confirmation point; anything shorter is only
 * *possibly* that object.
 */
const scanBentoCandidate = (text: string): BentoScan => {
  let index = skipWs(text, 0);
  if (index >= text.length) return { status: 'other' };

  const brace = matchLiteral(text, index, '{');
  if (brace === 'fail') return { status: 'other' };
  if (brace === 'prefix') return { status: 'ambiguous' };

  index = skipWs(text, brace);
  if (index >= text.length) return { status: 'ambiguous' };

  const key = matchLiteral(text, index, '"layout"');
  if (key === 'fail') return { status: 'other' };
  if (key === 'prefix') return { status: 'ambiguous' };

  index = skipWs(text, key);
  if (index >= text.length) return { status: 'ambiguous' };

  const colon = matchLiteral(text, index, ':');
  if (colon === 'fail') return { status: 'other' };
  if (colon === 'prefix') return { status: 'ambiguous' };

  index = skipWs(text, colon);
  if (index >= text.length) return { status: 'ambiguous' };

  const value = matchLiteral(text, index, '"bento"');
  if (value === 'fail') return { status: 'other' };
  if (value === 'prefix') return { status: 'ambiguous' };

  const objectStart = skipWs(text, 0);
  const objectEnd = endOfJsonObject(text, objectStart);
  if (objectEnd === null) return { status: 'confirmed-prefix' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(objectStart, objectEnd));
  } catch {
    return { status: 'other' };
  }
  if (asRecord(parsed)?.layout !== 'bento') return { status: 'other' };

  return { rest: text.slice(objectEnd).replace(/^\s+/, ''), status: 'complete' };
};

export interface InspectBentoTextOptions {
  /**
   * Mid-stream: also withhold an *ambiguous* prefix of `{"layout":"bento"…}`.
   * Once the message is finished (or on the recovery poll), those prefixes are
   * released as ordinary text — only a confirmed bento object/prefix is dropped.
   */
  streaming?: boolean;
}

export interface BentoTextResult {
  /** `layout: "bento"` has been matched, even if the object is still open. */
  confirmed: boolean;
  /**
   * The whole candidate was a confirmed bento object/prefix (no remainder).
   * Callers should latch `ignored` once the message can no longer grow.
   */
  ignored: boolean;
  /** User-facing text after dropping a complete leading bento object. */
  text: string;
  /** Do not emit or raise high-water. */
  withhold: boolean;
}

export const inspectBentoText = (
  candidate: string,
  { streaming }: InspectBentoTextOptions = {},
): BentoTextResult => {
  const scan = scanBentoCandidate(candidate);
  if (scan.status === 'ambiguous') {
    return { confirmed: false, ignored: false, text: candidate, withhold: !!streaming };
  }
  if (scan.status === 'confirmed-prefix') {
    return { confirmed: true, ignored: true, text: '', withhold: true };
  }
  if (scan.status === 'complete') {
    const empty = scan.rest.length === 0;
    return { confirmed: true, ignored: empty, text: scan.rest, withhold: empty };
  }
  return { confirmed: false, ignored: false, text: candidate, withhold: false };
};

/**
 * A finished unclassified image-search / bento tool-call — not a user-facing
 * answer. Recovery must keep polling rather than treat the empty remainder as
 * "the turn produced nothing".
 */
export const isBentoOnlyText = (candidate: string): boolean => {
  const result = inspectBentoText(candidate);
  return result.confirmed && result.text.length === 0;
};

/** Drop a confirmed leading bento object/prefix; keep ambiguous JSON. */
export const stripBentoLayout = (candidate: string): string => {
  const result = inspectBentoText(candidate);
  return result.withhold ? '' : result.text;
};
