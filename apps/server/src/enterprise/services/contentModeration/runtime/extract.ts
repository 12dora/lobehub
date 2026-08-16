import { MODERATION_LIMITS } from '@/const/platform/contentModeration';

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/gi;

const flattenContent = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      const record = part as { text?: unknown; type?: unknown };
      if (record.type === 'text' && typeof record.text === 'string') return record.text;
      if (typeof record.text === 'string') return record.text;
      return '';
    })
    .join('');
};

export const normalizeExtractedText = (text: string): string => {
  const stripped = text.replaceAll(SYSTEM_REMINDER, '');
  const collapsed = stripped.replaceAll(/\s+/g, ' ').trim();
  return collapsed.slice(0, MODERATION_LIMITS.EXTRACT_MAX_CHARS);
};

/**
 * Last `role === 'user'` message text (string or `type: 'text'` parts), with
 * `<system-reminder>` blocks stripped. Empty after normalisation → `null`.
 *
 * Used as a fallback until B1's `normalize.extractPromptText` is wired; the
 * wrapper prefers B1's extractor when present.
 */
export const extractPromptText = (payload: unknown): string | null => {
  if (!payload || typeof payload !== 'object') return null;
  const messages = (payload as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== 'object') continue;
    if ((message as { role?: unknown }).role !== 'user') continue;
    const text = normalizeExtractedText(flattenContent((message as { content?: unknown }).content));
    return text || null;
  }
  return null;
};

/**
 * Image / video generation prompt. Prefers `params.prompt` (runtime payload),
 * then a top-level `prompt`. Used as a fallback until B1's extractor is wired.
 */
export const extractGenerationPrompt = (payload: unknown): string | null => {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as { params?: { prompt?: unknown }; prompt?: unknown };
  const raw = record.params?.prompt ?? record.prompt;
  if (typeof raw !== 'string') return null;
  const text = normalizeExtractedText(raw);
  return text || null;
};
