/**
 * Field readers for a ChatGPT Web conversation-document message: text,
 * reasoning, handoff options, and image-tool / asset-pointer detection.
 */

import { ASSET_POINTER_PREFIXES } from '../constants';
import type { AssetPointerKind, StreamHandoffOption } from '../types';

export const asRecord = (value: unknown): Record<string, any> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, any>)
    : undefined;

/**
 * Port of the reference `strip_history`: the upstream replays the assistant
 * turns we sent, so a full message can arrive as `<history><new text>`. Strip
 * the concatenated history prefix repeatedly (a repeated echo strips twice).
 */
export const stripHistory = (text: string, historyText: string): string => {
  if (!historyText) return text;
  let out = text;
  while (out.startsWith(historyText)) out = out.slice(historyText.length);
  return out;
};

/** Joined string `parts` only — never `content.text` (that's the `code` payload). */
export const messagePartsText = (message: Record<string, any>): string => {
  const content = asRecord(message.content);
  if (!content) return '';
  const parts = Array.isArray(content.parts) ? content.parts : [];
  return parts.filter((part: unknown) => typeof part === 'string').join('');
};

export const messageText = (message: Record<string, any>): string => {
  const joined = messagePartsText(message);
  if (joined) return joined;
  // content_type "code" keeps its payload in `text` rather than `parts`
  const content = asRecord(message.content);
  return typeof content?.text === 'string' ? content.text : '';
};

export const reasoningText = (message: Record<string, any>): { summary?: string; text: string } => {
  const content = asRecord(message.content);
  const thoughts = Array.isArray(content?.thoughts) ? content!.thoughts : [];
  const chunks: string[] = [];
  let summary: string | undefined;
  for (const rawThought of thoughts) {
    const thought = asRecord(rawThought);
    if (!thought) continue;
    if (typeof thought.summary === 'string' && thought.summary) summary = thought.summary;
    const body = [thought.summary, thought.content]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join('\n');
    if (body) chunks.push(body);
  }
  return { summary, text: chunks.join('\n\n') };
};

export const toHandoffOptions = (value: unknown): StreamHandoffOption[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const options = value
    .map((raw) => asRecord(raw))
    .filter((option): option is Record<string, any> => !!option)
    .map((option) => ({
      topicId: typeof option.topic_id === 'string' ? option.topic_id : undefined,
      type: typeof option.type === 'string' ? option.type : undefined,
    }));
  return options.length > 0 ? options : undefined;
};

export const pointerKind = (pointer: string): AssetPointerKind | undefined => {
  if (pointer.startsWith(ASSET_POINTER_PREFIXES.fileService)) return 'file-service';
  if (pointer.startsWith(ASSET_POINTER_PREFIXES.sediment)) return 'sediment';
  return undefined;
};

export const isImageToolMessage = (message: Record<string, any>): boolean => {
  if (String(asRecord(message.author)?.role ?? '').toLowerCase() !== 'tool') return false;
  if (asRecord(message.metadata)?.async_task_type === 'image_gen') return true;

  const content = asRecord(message.content);
  if (content?.content_type !== 'multimodal_text') return false;
  const parts = Array.isArray(content.parts) ? content.parts : [];
  return parts.some((rawPart: unknown) => {
    const part = asRecord(rawPart);
    if (!part) return false;
    return (
      part.content_type === 'image_asset_pointer' || !!pointerKind(String(part.asset_pointer ?? ''))
    );
  });
};
