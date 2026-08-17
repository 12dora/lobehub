import { MODERATION_LIMITS } from '@/const/platform/contentModeration';

const REDACTED = '[REDACTED]';

/**
 * Order matters: more specific patterns (Bearer, JWT, sk-*, assignments) run
 * before generic hex/base64/UUID so we do not double-replace fragments.
 */
const SENSITIVE_PATTERNS: RegExp[] = [
  /\bhttps?:\/\/\S+/gi,
  /\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi,
  /\bBearer\s+[\w\-.~+/]+=*/gi,
  /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}\b/g,
  /\bsk-[A-Za-z0-9]{8,}\b/g,
  /\b[0-9a-f]{32,}\b/gi,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
  /(?<!\d)1[3-9]\d{9}(?!\d)/g,
  /(?<!\d)\d{17}[\dX](?!\d)/gi,
];

/** Require mixed classes so long English identifiers are not treated as base64. */
const BASE64_CANDIDATE = /(?<![A-Z0-9+/=])[A-Z0-9+/]{48,}={0,2}(?![A-Z0-9+/=])/gi;

const isMixedBase64 = (value: string): boolean => {
  const hasLetter = /[A-Z]/i.test(value);
  const hasDigitOrPad = /[\d+/=]/.test(value);
  return hasLetter && hasDigitOrPad;
};

export const redactSensitive = (text: string): string => {
  let next = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    next = next.replace(pattern, REDACTED);
  }
  return next.replaceAll(BASE64_CANDIDATE, (candidate) =>
    isMixedBase64(candidate) ? REDACTED : candidate,
  );
};

export const buildExcerpt = (
  text: string,
  maxChars: number = MODERATION_LIMITS.PROMPT_EXCERPT_MAX_CHARS,
): string => {
  const redacted = redactSensitive(text);
  if (redacted.length <= maxChars) return redacted;
  if (maxChars <= 1) return '…';
  return `${redacted.slice(0, maxChars - 1)}…`;
};
