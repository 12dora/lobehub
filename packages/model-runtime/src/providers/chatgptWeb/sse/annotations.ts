import { ANNOTATION_SEPARATOR } from '../constants';

/**
 * ChatGPT web wraps inline citations in private-use-area markers:
 * `U+E200 kind U+E202 arg1 [U+E202 arg2 …] U+E201`.
 *
 * The sanitizer is streaming-safe: a still-unterminated marker at the end of the
 * buffer is dropped, so a half-written annotation never reaches the UI. Callers
 * must keep the RAW text around so the next chunk can complete the marker.
 */

const INTERNAL_TOKEN_RE = /^turn\d+(?:[a-z]+\d*)?$/;
const INTERNAL_TOKEN_LOOSE_RE = /^turn\d\w*$/;

const isInternalAnnotationPart = (part: string): boolean => {
  const value = part.trim();
  if (!value) return true;
  const lower = value.toLowerCase();
  return (
    INTERNAL_TOKEN_RE.test(lower) ||
    INTERNAL_TOKEN_LOOSE_RE.test(lower) ||
    lower.startsWith('turn') ||
    lower.startsWith('source') ||
    lower.startsWith('sources')
  );
};

const readableAnnotationPart = (parts: string[]): string => {
  for (const part of parts) {
    const value = part.trim();
    if (value && !isInternalAnnotationPart(value)) return value;
  }
  return '';
};

const annotationText = (payload: string): string => {
  const parts = payload.split(ANNOTATION_SEPARATOR).map((part) => part.trim());
  const kind = (parts[0] ?? '').toLowerCase();
  const data = parts.slice(1);

  if (kind === 'url') {
    const label = data[0] ?? '';
    const url = data[1] ?? '';
    if (label && (url.startsWith('http://') || url.startsWith('https://')))
      return `${label} (${url})`;
    return label || url;
  }

  return readableAnnotationPart(data);
};

const BEFORE_PUNCTUATION_RE = /(\s*)\uE200([^\uE201]*)\uE201(?=[!,.:;?])/g;
const ANNOTATION_RE = /\uE200([^\uE201]*)\uE201/g;
const UNTERMINATED_RE = /\uE200[^\uE201]*$/;

export interface SanitizeAnnotationsOptions {
  /**
   * Mid-stream: also withhold the trailing whitespace, because a marker that
   * has not arrived yet may still swallow it (`"see ␣<cite>."` collapses to
   * `"see."`). Emitting it early would make the next delta non-additive and the
   * UI would render `"see see."`.
   */
  streaming?: boolean;
}

/**
 * Replace annotation markers with human-readable text.
 *
 * Note the leading-whitespace rule only fires when the annotation is directly
 * followed by punctuation, so legitimate spacing such as `"find ."` in code
 * samples is preserved.
 */
export const sanitizeAnnotations = (
  input: string | undefined | null,
  { streaming }: SanitizeAnnotationsOptions = {},
): string => {
  let text = String(input ?? '');
  if (!text) return '';

  text = text.replaceAll(BEFORE_PUNCTUATION_RE, (_match, leadingSpace: string, payload: string) => {
    const replacement = annotationText(payload);
    return replacement ? `${leadingSpace}${replacement}` : '';
  });
  text = text.replaceAll(ANNOTATION_RE, (_match, payload: string) => annotationText(payload));
  text = text.replace(UNTERMINATED_RE, '');
  if (streaming) text = text.replace(/\s+$/, '');

  return text;
};
