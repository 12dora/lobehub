import createDebug from 'debug';

import type { OpenAIChatMessage, UserMessageContentPart } from '../../types';
import type { ChatStreamPayload } from '../../types/chat';
import { fileUrlPartPlaceholder, isFileUrlTypedPart } from '../../types/chat';
import { parseDataUri } from '../../utils/uriParser';

const log = createDebug('lobe-cursor:turn');

export interface CursorTurnImage {
  dataBase64: string;
  mimeType: string;
}

export interface CursorHistoryContentText {
  text: { text: string };
}

export interface CursorHistoryMessage {
  assistant?: { content: CursorHistoryContentText[] };
  user?: { content: CursorHistoryContentText[] };
}

export interface CursorTurnBody {
  history?: { messages: CursorHistoryMessage[]; replaceUserInfo: false };
  images?: CursorTurnImage[];
  model: string;
  prompt: string;
}

const isSystemRole = (role: string): boolean => role === 'system' || role === 'developer';

const isToolRole = (role: string): boolean => role === 'tool' || role === 'function';

const isImagePart = (
  part: unknown,
): part is Extract<UserMessageContentPart, { type: 'image_url' }> =>
  !!part && typeof part === 'object' && (part as { type?: unknown }).type === 'image_url';

const extractText = (content: OpenAIChatMessage['content']): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (
      (part as { type?: unknown }).type === 'text' &&
      typeof (part as { text?: unknown }).text === 'string'
    ) {
      const text = (part as { text: string }).text;
      if (text) parts.push(text);
      continue;
    }
    if (isFileUrlTypedPart(part)) parts.push(fileUrlPartPlaceholder(part));
  }
  return parts.join('\n');
};

const countImageParts = (content: OpenAIChatMessage['content']): number => {
  if (!Array.isArray(content)) return 0;
  return content.filter((part) => isImagePart(part)).length;
};

const extractImages = (content: OpenAIChatMessage['content']): CursorTurnImage[] => {
  if (!Array.isArray(content)) return [];

  const images: CursorTurnImage[] = [];
  for (const part of content) {
    if (!isImagePart(part)) continue;
    const url = part.image_url?.url;
    if (!url) continue;
    const parsed = parseDataUri(url);
    if (parsed.type === 'base64' && parsed.base64) {
      images.push({
        dataBase64: parsed.base64,
        mimeType: parsed.mimeType || 'image/png',
      });
      continue;
    }
    log('skipping non-base64 image on the last user message');
  }
  return images;
};

const foldAssistant = (message: OpenAIChatMessage): string => {
  const bits = [extractText(message.content)];
  for (const call of message.tool_calls ?? []) {
    const name = call.function?.name || call.id || 'tool';
    const args = call.function?.arguments ?? '';
    bits.push(`[tool call ${name}: ${args}]`);
  }
  return bits.filter(Boolean).join('\n');
};

const foldTool = (message: OpenAIChatMessage): string => {
  const text = extractText(message.content);
  const id = message.tool_call_id ? ` ${message.tool_call_id}` : '';
  return `[tool result${id}: ${text}]`;
};

const wrapSystem = (texts: string[]): string => {
  if (texts.length === 0) return '';
  return `<system>${texts.join('\n\n')}</system>\n\n`;
};

const userHistory = (text: string): CursorHistoryMessage => ({
  user: { content: [{ text: { text } }] },
});

const assistantHistory = (text: string): CursorHistoryMessage => ({
  assistant: { content: [{ text: { text } }] },
});

const appendToPreviousAssistant = (history: CursorHistoryMessage[], text: string): boolean => {
  const previous = history.at(-1);
  const content = previous?.assistant?.content[0];
  if (!previous?.assistant || !content) return false;
  const existing = content.text.text;
  content.text.text = existing ? `${existing}\n${text}` : text;
  return true;
};

/**
 * Map a LobeHub chat payload onto the Cursor transport's `/v1/turn` body.
 * History is every message before the last user turn; system/developer text is
 * prepended as `<system>…</system>` onto the first history user (or the prompt
 * when there is no history user). Tool calls/results become plain text.
 */
export const buildCursorTurn = (
  payload: Pick<ChatStreamPayload, 'messages' | 'model'>,
): CursorTurnBody => {
  const messages = payload.messages ?? [];

  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      lastUserIndex = index;
      break;
    }
  }

  const lastUser = lastUserIndex >= 0 ? messages[lastUserIndex] : undefined;
  const earlier = lastUserIndex >= 0 ? messages.slice(0, lastUserIndex) : messages;

  const systemTexts: string[] = [];
  const history: CursorHistoryMessage[] = [];

  for (const message of earlier) {
    if (isSystemRole(message.role)) {
      const text = extractText(message.content);
      if (text) systemTexts.push(text);
      continue;
    }

    const dropped = countImageParts(message.content);
    if (dropped > 0) log('dropping %d image(s) from a non-final user message', dropped);

    if (isToolRole(message.role)) {
      const folded = foldTool(message);
      if (!folded) continue;
      if (!appendToPreviousAssistant(history, folded)) history.push(userHistory(folded));
      continue;
    }

    if (message.role === 'assistant') {
      const folded = foldAssistant(message);
      if (folded) history.push(assistantHistory(folded));
      continue;
    }

    const text = extractText(message.content);
    if (text) history.push(userHistory(text));
  }

  const systemPrefix = wrapSystem(systemTexts);
  const hasHistoryUser = history.some((item) => item.user);

  if (systemPrefix && hasHistoryUser) {
    const firstUser = history.find((item) => item.user);
    const slot = firstUser?.user?.content[0];
    if (slot) slot.text.text = `${systemPrefix}${slot.text.text}`;
  }

  const lastUserText = lastUser ? extractText(lastUser.content) : '';
  const prompt = systemPrefix && !hasHistoryUser ? `${systemPrefix}${lastUserText}` : lastUserText;
  const images = lastUser ? extractImages(lastUser.content) : [];

  return {
    ...(history.length > 0
      ? { history: { messages: history, replaceUserInfo: false as const } }
      : {}),
    ...(images.length > 0 ? { images } : {}),
    model: payload.model,
    prompt,
  };
};
