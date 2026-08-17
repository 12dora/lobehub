import { describe, expect, it } from 'vitest';

import { buildCursorTurn } from './turn';

describe('buildCursorTurn', () => {
  it('uses the last user message as the prompt when there is no history', () => {
    expect(
      buildCursorTurn({
        messages: [{ content: 'Reply with pong', role: 'user' }],
        model: 'composer-2.5',
      }),
    ).toEqual({
      model: 'composer-2.5',
      prompt: 'Reply with pong',
    });
  });

  it('prepends system text to the prompt when there is no history', () => {
    expect(
      buildCursorTurn({
        messages: [
          { content: 'be terse', role: 'system' },
          { content: 'Reply with pong', role: 'user' },
        ],
        model: 'composer-2.5',
      }),
    ).toEqual({
      model: 'composer-2.5',
      prompt: '<system>be terse</system>\n\nReply with pong',
    });
  });

  it('treats developer messages as system text', () => {
    expect(
      buildCursorTurn({
        messages: [
          { content: 'you are a CLI', role: 'developer' as 'system' },
          { content: 'hi', role: 'user' },
        ],
        model: 'auto',
      }).prompt,
    ).toBe('<system>you are a CLI</system>\n\nhi');
  });

  it('prepends system text to the first history user and keeps the last user as prompt', () => {
    expect(
      buildCursorTurn({
        messages: [
          { content: 'be terse', role: 'system' },
          { content: 'hello', role: 'user' },
          { content: 'hi there', role: 'assistant' },
          { content: 'pong?', role: 'user' },
        ],
        model: 'composer-2.5',
      }),
    ).toEqual({
      history: {
        messages: [
          { user: { content: [{ text: { text: '<system>be terse</system>\n\nhello' } }] } },
          { assistant: { content: [{ text: { text: 'hi there' } }] } },
        ],
        replaceUserInfo: false,
      },
      model: 'composer-2.5',
      prompt: 'pong?',
    });
  });

  it('folds assistant tool calls and tool results into plain text', () => {
    const body = buildCursorTurn({
      messages: [
        { content: 'search docs', role: 'user' },
        {
          content: 'looking it up',
          role: 'assistant',
          tool_calls: [
            {
              function: { arguments: '{"q":"pong"}', name: 'search' },
              id: 'call_1',
              type: 'function',
            },
          ],
        },
        { content: 'found pong', role: 'tool', tool_call_id: 'call_1' },
        { content: 'what did you find?', role: 'user' },
      ],
      model: 'composer-2.5',
    });

    expect(body.history?.messages).toEqual([
      { user: { content: [{ text: { text: 'search docs' } }] } },
      {
        assistant: {
          content: [
            {
              text: {
                text: 'looking it up\n[tool call search: {"q":"pong"}]\n[tool result call_1: found pong]',
              },
            },
          ],
        },
      },
    ]);
    expect(body.prompt).toBe('what did you find?');
  });

  it('extracts base64 images from the last user message', () => {
    const body = buildCursorTurn({
      messages: [
        {
          content: [
            { text: 'what is this', type: 'text' },
            { image_url: { url: 'data:image/png;base64,QUJD' }, type: 'image_url' },
          ],
          role: 'user',
        },
      ],
      model: 'composer-2.5',
    });

    expect(body.prompt).toBe('what is this');
    expect(body.images).toEqual([{ dataBase64: 'QUJD', mimeType: 'image/png' }]);
  });

  it('drops images from older messages and keeps only last-user images', () => {
    const body = buildCursorTurn({
      messages: [
        {
          content: [
            { text: 'first', type: 'text' },
            { image_url: { url: 'data:image/png;base64,T0xE' }, type: 'image_url' },
          ],
          role: 'user',
        },
        { content: 'ok', role: 'assistant' },
        {
          content: [
            { text: 'second', type: 'text' },
            { image_url: { url: 'data:image/jpeg;base64,TkVX' }, type: 'image_url' },
          ],
          role: 'user',
        },
      ],
      model: 'composer-2.5',
    });

    expect(body.history?.messages).toEqual([
      { user: { content: [{ text: { text: 'first' } }] } },
      { assistant: { content: [{ text: { text: 'ok' } }] } },
    ]);
    expect(JSON.stringify(body.history)).not.toContain('T0xE');
    expect(body.images).toEqual([{ dataBase64: 'TkVX', mimeType: 'image/jpeg' }]);
    expect(body.prompt).toBe('second');
  });

  it('joins multipart user text and skips file parts via placeholders', () => {
    const body = buildCursorTurn({
      messages: [
        {
          content: [
            { text: 'see this', type: 'text' },
            {
              file_url: {
                mimeType: 'text/plain',
                name: 'notes.txt',
                url: 'https://files/notes.txt',
              },
              type: 'file_url',
            },
          ],
          role: 'user',
        },
      ],
      model: 'auto',
    });

    expect(body.prompt).toBe('see this\n[file omitted: notes.txt]');
  });
});
