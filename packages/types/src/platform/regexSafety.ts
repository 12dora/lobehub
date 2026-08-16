/**
 * Conservative static checks for admin-authored keyword regexes.
 * Slightly over-rejects is preferred to letting ReDoS onto the chat hot path.
 *
 * Dynamic probing lives in the server regex worker — this module must stay
 * synchronous and cheap so Zod refine can call it.
 */

export type RegexSafetyResult = { ok: true } | { ok: false; reason: string };

export const REGEX_PROBE_CHARS = 4000;
export const REGEX_PROBE_MAX_MS = 50;

const BACKREF_QUANTIFIED = /\\[1-9]\d*[+*]|\\[1-9]\d*\{\d+,/;
const CLASS_ESCAPES = new Set(['d', 'D', 's', 'S', 'w', 'W']);
const MAX_BOUNDED_REPEAT = 200;
const MAX_UNBOUNDED_QUANTIFIERS = 2;

const findMatchingParen = (pattern: string, open: number): number => {
  let depth = 1;
  for (let index = open + 1; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
};

const findMatchingBracket = (pattern: string, open: number): number => {
  let index = open + 1;
  if (pattern[index] === '^') index += 1;
  // A leading `]` inside a class is literal.
  if (pattern[index] === ']') index += 1;
  for (; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === ']') return index;
  }
  return -1;
};

interface Quantifier {
  length: number;
  max?: number;
  unbounded: boolean;
}

const parseQuantifier = (pattern: string, index: number): Quantifier | null => {
  const char = pattern[index];
  const possessiveOrLazy = (length: number): number => {
    const next = pattern[index + length];
    return next === '?' || next === '+' ? length + 1 : length;
  };

  if (char === '*' || char === '+') {
    return { length: possessiveOrLazy(1), unbounded: true };
  }
  if (char === '?') {
    return { length: possessiveOrLazy(1), unbounded: false };
  }
  if (char !== '{') return null;

  const match = /^\{\d+(?:,(\d*))?\}/.exec(pattern.slice(index));
  if (!match) return null;
  const length = possessiveOrLazy(match[0].length);
  if (!match[0].includes(',')) {
    return { length, unbounded: false };
  }
  if (match[1] === undefined || match[1] === '') {
    return { length, unbounded: true };
  }
  return { length, max: Number(match[1]), unbounded: false };
};

const stripGroupPrefix = (body: string): string => {
  if (
    body.startsWith('?:') ||
    body.startsWith('?=') ||
    body.startsWith('?!') ||
    body.startsWith('?>')
  ) {
    return body.slice(2);
  }
  if (body.startsWith('?<=') || body.startsWith('?<!')) {
    return body.slice(3);
  }
  const named = /^\?<[^>]+>/.exec(body);
  if (named) return body.slice(named[0].length);
  return body;
};

const isLookbehindGroup = (pattern: string, open: number): boolean => {
  const rest = pattern.slice(open);
  return rest.startsWith('(?<=') || rest.startsWith('(?<!');
};

/**
 * A quantified group's body is unsafe when it contains another quantifier,
 * an alternation, a wildcard `.`, a class escape, or a bracket class.
 */
const groupBodyIsUnsafe = (rawBody: string): boolean => {
  const body = stripGroupPrefix(rawBody);
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '\\') {
      const escaped = body[index + 1];
      if (escaped && CLASS_ESCAPES.has(escaped)) return true;
      index += 1;
      continue;
    }
    if (char === '[') return true;
    if (char === '|' || char === '.') return true;
    if (char === '*' || char === '+' || char === '?') return true;
    if (char === '{' && parseQuantifier(body, index)) return true;
  }
  return false;
};

const lookbehindHasQuantifier = (body: string): boolean => {
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '[') {
      const close = findMatchingBracket(body, index);
      if (close < 0) break;
      index = close;
      continue;
    }
    if (parseQuantifier(body, index)) return true;
  }
  return false;
};

/**
 * Reject nested/overlapping ReDoS shapes, too many unbounded quantifiers,
 * oversized `{n,m}`, quantified back-references, and lookbehinds that
 * themselves contain a quantifier.
 *
 * Group bodies are walked (unquantified wrappers included) so `((a|a)*)`
 * cannot bypass the same checks that reject `(a|a)*`.
 */
export const assessRegexSafety = (pattern: string): RegexSafetyResult => {
  if (BACKREF_QUANTIFIED.test(pattern)) {
    return { ok: false, reason: 'quantified_backref' };
  }

  let unbounded = 0;

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '[') {
      const close = findMatchingBracket(pattern, index);
      if (close < 0) break;
      index = close;
      continue;
    }

    if (char === '(') {
      const close = findMatchingParen(pattern, index);
      if (close < 0) break;
      const body = pattern.slice(index + 1, close);
      const stripped = stripGroupPrefix(body);
      const prefixLength = body.length - stripped.length;

      if (isLookbehindGroup(pattern, index) && lookbehindHasQuantifier(stripped)) {
        return { ok: false, reason: 'lookbehind_quantifier' };
      }

      const quantifier = parseQuantifier(pattern, close + 1);
      if (quantifier && groupBodyIsUnsafe(body)) {
        return { ok: false, reason: 'unsafe_quantified_group' };
      }

      // Walk into the group body (skip `(?:` / lookaround prefixes so `?`
      // is not counted as a quantifier). Inner unbounded / `{n,m}` checks
      // run on the same pass.
      index += prefixLength;
      continue;
    }

    const quantifier = parseQuantifier(pattern, index);
    if (!quantifier) continue;
    if (quantifier.max !== undefined && quantifier.max > MAX_BOUNDED_REPEAT) {
      return { ok: false, reason: 'repeat_upper_bound' };
    }
    if (quantifier.unbounded) unbounded += 1;
    if (unbounded > MAX_UNBOUNDED_QUANTIFIERS) {
      return { ok: false, reason: 'too_many_unbounded' };
    }
    index += quantifier.length - 1;
  }

  return { ok: true };
};

export interface RegexProbeOptions {
  maxMs?: number;
  now?: () => number;
}

/**
 * Synchronous probe kept for unit tests only. Production paths must use the
 * interruptible worker (`probeRegexPattern`) so a catastrophic pattern cannot
 * stall the request event loop.
 */
export const probeRegexPerformance = (
  pattern: string,
  options: RegexProbeOptions = {},
): RegexSafetyResult => {
  let compiled: RegExp;
  try {
    compiled = new RegExp(pattern, 'iu');
  } catch {
    return { ok: false, reason: 'invalid' };
  }

  const now = options.now ?? Date.now;
  const maxMs = options.maxMs ?? REGEX_PROBE_MAX_MS;
  const n = REGEX_PROBE_CHARS;
  const samples = ['a'.repeat(n), `${'a'.repeat(n)}!`, '1'.repeat(n)];

  for (const sample of samples) {
    let best = Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < 2 && best > maxMs; attempt += 1) {
      const started = now();
      compiled.lastIndex = 0;
      compiled.test(sample);
      compiled.lastIndex = 0;
      best = Math.min(best, now() - started);
    }
    if (best > maxMs) {
      return { ok: false, reason: 'slow_probe' };
    }
  }
  return { ok: true };
};
