import type { OpenAIChatMessage, UserMessageContentPart } from '../../types';
import { isFileUrlPart } from '../../types/chat';

/**
 * Text stand-in used when a document cannot be sent as Responses `input_file`.
 * Omits `url` so the model is not pointed at an origin it cannot fetch.
 */
export const filesInfoWithoutUrl = (file: {
  content?: string;
  fileId?: string;
  mimeType?: string;
  name: string;
  size?: number;
}): string => {
  const attrs = [
    file.fileId ? `id="${file.fileId}"` : undefined,
    `name="${file.name}"`,
    file.mimeType ? `type="${file.mimeType}"` : undefined,
    file.size === undefined ? undefined : `size="${file.size}"`,
  ]
    .filter(Boolean)
    .join(' ');

  return `<files_info>
<files_docstring>here are user upload files you can refer to</files_docstring>
<file ${attrs}>${file.content ?? ''}</file>
</files_info>`;
};

const degradePart = (part: UserMessageContentPart): UserMessageContentPart => {
  if (!isFileUrlPart(part)) return part;

  const { content, fileId, mimeType, name, size } = part.file_url;
  return {
    text: filesInfoWithoutUrl({ content, fileId, mimeType, name, size }),
    type: 'text',
  };
};

/**
 * Replace every native `file_url` part with extracted-text `<files_info>`.
 * Returns new message objects; the input array and its messages are not mutated.
 */
export const degradeFileUrlPartsToText = (
  messages: OpenAIChatMessage[],
): { degraded: number; messages: OpenAIChatMessage[] } => {
  let degraded = 0;

  const next = messages.map((message) => {
    if (!Array.isArray(message.content)) return message;

    let changed = false;
    const content = message.content.map((part) => {
      if (!isFileUrlPart(part)) return part;
      changed = true;
      degraded += 1;
      return degradePart(part);
    });

    return changed ? { ...message, content } : message;
  });

  return { degraded, messages: next };
};
