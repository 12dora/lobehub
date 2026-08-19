import { describe, expect, it } from 'vitest';

import type { ChatCompletionTool } from '../../types/chat';
import {
  buildCursorToolProtocol,
  CURSOR_TOOL_CALLS_CLOSE,
  CURSOR_TOOL_CALLS_OPEN,
  serializeCursorToolCalls,
} from './toolProtocol';
import { buildCursorTurn } from './turn';

const SEARCH_TOOL: ChatCompletionTool = {
  function: {
    description: 'Search docs',
    name: 'search',
    parameters: {
      properties: { q: { type: 'string' } },
      required: ['q'],
      type: 'object',
    },
  },
  type: 'function',
};

const WEATHER_TOOL: ChatCompletionTool = {
  function: {
    description: 'Get weather',
    name: 'weather',
    parameters: { properties: { city: { type: 'string' } }, type: 'object' },
  },
  type: 'function',
};

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

  it('is byte-identical when tools are omitted or empty', () => {
    const payload = {
      messages: [
        { content: 'be terse', role: 'system' as const },
        { content: 'hello', role: 'user' as const },
        { content: 'hi there', role: 'assistant' as const },
        { content: 'pong?', role: 'user' as const },
      ],
      model: 'composer-2.5',
    };
    const baseline = buildCursorTurn(payload);

    expect(buildCursorTurn({ ...payload, tools: undefined })).toEqual(baseline);
    expect(buildCursorTurn({ ...payload, tools: [] })).toEqual(baseline);
    expect(JSON.stringify(baseline)).not.toContain(CURSOR_TOOL_CALLS_OPEN);
  });

  it('appends the tool-protocol block inside <system> when tools are present', () => {
    const protocol = buildCursorToolProtocol([SEARCH_TOOL, WEATHER_TOOL], 'auto');
    const body = buildCursorTurn({
      messages: [
        { content: 'be terse', role: 'system' },
        { content: 'search docs', role: 'user' },
      ],
      model: 'composer-2.5',
      tool_choice: 'auto',
      tools: [SEARCH_TOOL, WEATHER_TOOL],
    });

    expect(body.prompt).toBe(`<system>be terse\n\n${protocol}</system>\n\nsearch docs`);
    expect(body.prompt).toContain(CURSOR_TOOL_CALLS_OPEN);
    expect(body.prompt).toContain(CURSOR_TOOL_CALLS_CLOSE);
    expect(body.prompt).toContain('"name":"search"');
    expect(body.prompt).toContain('"name":"weather"');
    expect(body.history).toBeUndefined();
  });

  it('re-serializes prior assistant tool_calls in the same markup and folds tool results', () => {
    const protocol = buildCursorToolProtocol([SEARCH_TOOL]);
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
        { content: 'found pong', name: 'search', role: 'tool', tool_call_id: 'call_1' },
        { content: 'what did you find?', role: 'user' },
      ],
      model: 'composer-2.5',
      tools: [SEARCH_TOOL],
    });

    const expectedBlock = serializeCursorToolCalls([
      {
        function: { arguments: '{"q":"pong"}', name: 'search' },
        id: 'call_1',
        type: 'function',
      },
    ]);
    const expectedResult =
      '<aihub:tool_result name="search" id="call_1">found pong</aihub:tool_result>';

    expect(body.history?.messages).toEqual([
      {
        user: {
          content: [{ text: { text: `<system>${protocol}</system>\n\nsearch docs` } }],
        },
      },
      {
        assistant: {
          content: [
            {
              text: {
                text: `looking it up\n${expectedBlock}\n${expectedResult}`,
              },
            },
          ],
        },
      },
    ]);
    expect(body.prompt).toBe('what did you find?');
    expect(JSON.stringify(body)).not.toContain('[tool call');
    expect(JSON.stringify(body)).not.toContain('[tool result');
  });

  it('keeps the legacy tool fold when tools are not in the payload', () => {
    const withHistoryTools = {
      messages: [
        { content: 'search docs', role: 'user' as const },
        {
          content: 'looking it up',
          role: 'assistant' as const,
          tool_calls: [
            {
              function: { arguments: '{"q":"pong"}', name: 'search' },
              id: 'call_1',
              type: 'function' as const,
            },
          ],
        },
        { content: 'found pong', role: 'tool' as const, tool_call_id: 'call_1' },
        { content: 'what did you find?', role: 'user' as const },
      ],
      model: 'composer-2.5',
    };

    expect(buildCursorTurn(withHistoryTools)).toEqual(
      buildCursorTurn({ ...withHistoryTools, tools: [] }),
    );
    expect(buildCursorTurn(withHistoryTools).history?.messages[1]).toEqual({
      assistant: {
        content: [
          {
            text: {
              text: 'looking it up\n[tool call search: {"q":"pong"}]\n[tool result call_1: found pong]',
            },
          },
        ],
      },
    });
  });

  it('honors tool_choice=required in the protocol block', () => {
    const body = buildCursorTurn({
      messages: [{ content: 'go', role: 'user' }],
      model: 'auto',
      tool_choice: 'required',
      tools: [SEARCH_TOOL],
    });

    expect(body.prompt).toContain('You MUST call at least one tool.');
  });

  it('does not advertise tools when tool_choice is none', () => {
    const payload = {
      messages: [
        { content: 'be terse', role: 'system' as const },
        { content: 'hello', role: 'user' as const },
        { content: 'hi there', role: 'assistant' as const },
        { content: 'pong?', role: 'user' as const },
      ],
      model: 'composer-2.5',
    };

    expect(buildCursorTurn({ ...payload, tool_choice: 'none', tools: [SEARCH_TOOL] })).toEqual(
      buildCursorTurn(payload),
    );
    expect(
      JSON.stringify(buildCursorTurn({ ...payload, tool_choice: 'none', tools: [SEARCH_TOOL] })),
    ).not.toContain(CURSOR_TOOL_CALLS_OPEN);
  });
});
