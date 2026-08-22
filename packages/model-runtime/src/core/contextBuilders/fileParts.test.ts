import { describe, expect, it } from 'vitest';

import type { OpenAIChatMessage } from '../../types';
import { degradeFileUrlPartsToText, filesInfoWithoutUrl } from './fileParts';

describe('degradeFileUrlPartsToText', () => {
  const filePart = {
    file_url: {
      content: 'EXTRACTED TEXT',
      fileId: 'file-1',
      mimeType: 'application/pdf',
      name: 'report.pdf',
      size: 12,
      url: 'data:application/pdf;base64,cGRm',
    },
    type: 'file_url' as const,
  };

  it('replaces file_url parts with files_info text and counts them', () => {
    const messages: OpenAIChatMessage[] = [
      {
        content: [{ text: 'summarize', type: 'text' }, filePart],
        role: 'user',
      },
    ];

    const result = degradeFileUrlPartsToText(messages);

    expect(result.degraded).toBe(1);
    expect(result.messages).toEqual([
      {
        content: [
          { text: 'summarize', type: 'text' },
          {
            text: filesInfoWithoutUrl({
              content: 'EXTRACTED TEXT',
              fileId: 'file-1',
              mimeType: 'application/pdf',
              name: 'report.pdf',
              size: 12,
            }),
            type: 'text',
          },
        ],
        role: 'user',
      },
    ]);
    expect((result.messages[0].content as { text: string }[])[1].text).not.toContain('url=');
    expect((result.messages[0].content as { text: string }[])[1].text).not.toContain(
      'data:application/pdf',
    );
  });

  it('does not mutate the input messages', () => {
    const messages: OpenAIChatMessage[] = [
      {
        content: [{ text: 'hi', type: 'text' }, filePart],
        role: 'user',
      },
    ];
    const snapshot = structuredClone(messages);

    const result = degradeFileUrlPartsToText(messages);

    expect(messages).toEqual(snapshot);
    expect(result.messages[0]).not.toBe(messages[0]);
    expect(result.messages[0].content).not.toBe(messages[0].content);
  });

  it('leaves string-content messages and non-file parts unchanged', () => {
    const imagePart = {
      image_url: { url: 'data:image/png;base64,abc' },
      type: 'image_url' as const,
    };
    const messages: OpenAIChatMessage[] = [
      { content: 'just text', role: 'user' },
      {
        content: [{ text: 'caption', type: 'text' }, imagePart],
        role: 'user',
      },
    ];

    const result = degradeFileUrlPartsToText(messages);

    expect(result.degraded).toBe(0);
    expect(result.messages[0]).toBe(messages[0]);
    expect(result.messages[1]).toBe(messages[1]);
  });

  it('degrades every file_url across messages', () => {
    const messages: OpenAIChatMessage[] = [
      {
        content: [filePart, { ...filePart, file_url: { ...filePart.file_url, name: 'two.pdf' } }],
        role: 'user',
      },
      {
        content: [{ text: 'later', type: 'text' }, filePart],
        role: 'user',
      },
    ];

    const result = degradeFileUrlPartsToText(messages);

    expect(result.degraded).toBe(3);
    expect(
      (result.messages[0].content as { type: string }[]).every((part) => part.type === 'text'),
    ).toBe(true);
    expect((result.messages[1].content as { type: string }[])[1].type).toBe('text');
  });
});
