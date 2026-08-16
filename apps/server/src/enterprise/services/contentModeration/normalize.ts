import { createHash } from 'node:crypto';

import { MODERATION_LIMITS } from '@/const/platform/contentModeration';

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/gi;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const extractTextFromContent = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text);
  }
  return parts.join('\n');
};

export const normalizeModerationText = (
  text: string,
  maxChars = MODERATION_LIMITS.EXTRACT_MAX_CHARS,
) => {
  const stripped = text.replaceAll(SYSTEM_REMINDER, ' ');
  const collapsed = stripped.replaceAll(/\s+/g, ' ').trim();
  return collapsed.length > maxChars ? collapsed.slice(0, maxChars) : collapsed;
};

/**
 * Last `role === 'user'` message from a chat payload. Content may be a string
 * or an array of `{ type: 'text', text }` parts. System-reminder blocks are
 * stripped, whitespace collapsed, then capped at EXTRACT_MAX_CHARS.
 */
export const extractPromptText = (payload: unknown): string => {
  if (!isRecord(payload) || !Array.isArray(payload.messages)) return '';
  for (let index = payload.messages.length - 1; index >= 0; index -= 1) {
    const message = payload.messages[index];
    if (!isRecord(message) || message.role !== 'user') continue;
    return normalizeModerationText(extractTextFromContent(message.content));
  }
  return '';
};

/** Image / video generation payload: the `prompt` field. */
export const extractGenerationPrompt = (payload: unknown): string => {
  if (!isRecord(payload) || typeof payload.prompt !== 'string') return '';
  return normalizeModerationText(payload.prompt);
};

export const hashPrompt = (text: string): string => createHash('sha256').update(text).digest('hex');
