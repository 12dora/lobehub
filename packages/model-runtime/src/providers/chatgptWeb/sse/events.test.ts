import { describe, expect, it } from 'vitest';

import type { ConversationEvent } from '../types';
import { ConversationEventRouter } from './events';

const feedAll = (payloads: unknown[], options?: { echoHistory?: string[] }) => {
  const router = new ConversationEventRouter(options);
  const events: ConversationEvent[] = [];
  for (const payload of payloads)
    events.push(...router.feed(typeof payload === 'string' ? payload : JSON.stringify(payload)));
  return { events, router };
};

const typesOf = (events: ConversationEvent[]) => events.map((event) => event.type);

const assistantAdd = (id: string, extra: Record<string, unknown> = {}) => ({
  o: 'add',
  p: '',
  v: {
    conversation_id: 'conv-1',
    message: {
      author: { role: 'assistant' },
      channel: 'final',
      content: { content_type: 'text', parts: [''] },
      id,
      status: 'in_progress',
      ...extra,
    },
  },
});

const append = (value: string) => ({ o: 'append', p: '/message/content/parts/0', v: value });

describe('ConversationEventRouter', () => {
  it('streams assistant text deltas and finishes on [DONE]', () => {
    const { events } = feedAll([
      '"v1"',
      assistantAdd('m1'),
      { o: 'append', p: '/message/content/parts/0', v: 'Hello' },
      { v: ' world' },
      {
        o: 'patch',
        p: '',
        v: [
          { o: 'append', p: '/message/content/parts/0', v: '!' },
          { o: 'replace', p: '/message/status', v: 'finished_successfully' },
          { o: 'replace', p: '/message/end_turn', v: true },
        ],
      },
      '[DONE]',
    ]);

    expect(events[0]).toEqual({ conversationId: 'conv-1', type: 'conversation.start' });
    const deltas = events.filter((event) => event.type === 'text.delta');
    expect(deltas.map((event: any) => event.delta)).toEqual(['Hello', ' world', '!']);
    expect((deltas.at(-1) as any).text).toBe('Hello world!');
    expect(events.at(-1)).toEqual({ conversationId: 'conv-1', endTurn: true, type: 'done' });
    expect(events.some((event) => event.type === 'message.status')).toBe(true);
  });

  it('sanitizes annotation markers inside the streamed text', () => {
    const { events } = feedAll([
      assistantAdd('m1'),
      { o: 'append', p: '/message/content/parts/0', v: 'see \uE200cite\uE202turn0search0' },
      { o: 'append', p: '/message/content/parts/0', v: '\uE201.' },
    ]);

    const deltas = events.filter((event) => event.type === 'text.delta') as any[];
    // the unstable tail (the half-written marker AND the space it will swallow)
    // is withheld, so the deltas stay additive
    expect(deltas.map((event) => event.delta)).toEqual(['see', '.']);
    expect(deltas.join('')).not.toContain('see see');
    expect(deltas.at(-1).text).toBe('see.');
  });

  describe.each([
    ['cite', 'see \uE200cite\uE202turn0search0\uE201.', 'see.'],
    [
      'url',
      'see \uE200url\uE202OpenAI\uE202https://openai.com\uE201.',
      'see OpenAI (https://openai.com).',
    ],
  ])('annotation deltas stay additive for the %s marker', (_kind, full, expected) => {
    // every possible chunk boundary of the message
    for (let split = 1; split < full.length; split += 1) {
      it(`split at ${split}`, () => {
        const { events } = feedAll([
          assistantAdd('m1'),
          { o: 'append', p: '/message/content/parts/0', v: full.slice(0, split) },
          { o: 'append', p: '/message/content/parts/0', v: full.slice(split) },
          {
            o: 'patch',
            p: '',
            v: [{ o: 'replace', p: '/message/status', v: 'finished_successfully' }],
          },
        ]);

        const deltas = events.filter((event) => event.type === 'text.delta') as any[];
        expect(deltas.map((event) => event.delta).join('')).toBe(expected);
        expect(deltas.at(-1)?.text).toBe(expected);
      });
    }
  });

  it('never emits text for hidden, tool-addressed or non-final channels', () => {
    const hidden = feedAll([
      assistantAdd('m1', { metadata: { is_visually_hidden_from_conversation: true } }),
      { o: 'append', p: '/message/content/parts/0', v: 'secret' },
    ]);
    const toolCall = feedAll([
      assistantAdd('m2', { recipient: 'web' }),
      { o: 'append', p: '/message/content/parts/0', v: 'search("x")' },
    ]);
    const analysis = feedAll([
      assistantAdd('m3', { channel: 'analysis' }),
      { o: 'append', p: '/message/content/parts/0', v: 'reasoning leak' },
    ]);

    for (const result of [hidden, toolCall, analysis])
      expect(typesOf(result.events)).not.toContain('text.delta');
  });

  it('maps thoughts to reasoning deltas and a recap to reasoning.done', () => {
    const { events } = feedAll([
      {
        o: 'add',
        p: '',
        v: {
          conversation_id: 'conv-1',
          message: {
            author: { role: 'assistant' },
            channel: 'analysis',
            content: { content_type: 'thoughts', thoughts: [{ content: '', summary: 'Planning' }] },
            id: 'r1',
          },
        },
      },
      { o: 'append', p: '/message/content/thoughts/0/content', v: 'First I check the docs.' },
      {
        o: 'add',
        p: '',
        v: {
          message: {
            author: { role: 'assistant' },
            content: { content: '**Thought for 12 seconds**', content_type: 'reasoning_recap' },
            id: 'r2',
            metadata: { finished_duration_sec: 12 },
          },
        },
      },
    ]);

    const reasoning = events.filter((event) => event.type === 'reasoning.delta') as any[];
    expect(reasoning.at(-1).delta).toContain('First I check the docs.');
    expect(reasoning.at(-1).summary).toBe('Planning');
    expect(events.at(-1)).toMatchObject({
      durationSec: 12,
      recap: '**Thought for 12 seconds**',
      type: 'reasoning.done',
    });
  });

  it('emits citations from streamed content_references', () => {
    const { events } = feedAll([
      assistantAdd('m1'),
      {
        o: 'replace',
        p: '/message/metadata/content_references',
        v: [
          {
            items: [{ snippet: 'a snippet', title: 'Example', url: 'https://example.com/a' }],
            type: 'grouped_webpages',
          },
        ],
      },
    ]);

    const citations = events.find((event) => event.type === 'citations') as any;
    expect(citations.citations).toEqual([
      {
        attribution: undefined,
        endIx: undefined,
        groupType: 'grouped_webpages',
        pubDate: undefined,
        snippet: 'a snippet',
        startIx: undefined,
        title: 'Example',
        url: 'https://example.com/a',
      },
    ]);
  });

  it('emits image pointers only for image_gen tool messages', () => {
    const { events } = feedAll([
      {
        o: 'add',
        p: '',
        v: {
          conversation_id: 'conv-1',
          message: {
            author: { role: 'tool' },
            content: {
              content_type: 'multimodal_text',
              parts: [
                { asset_pointer: 'file-service://file_out', content_type: 'image_asset_pointer' },
                { asset_pointer: 'sediment://file_out', content_type: 'image_asset_pointer' },
              ],
            },
            id: 't1',
            metadata: { async_task_type: 'image_gen' },
          },
        },
      },
    ]);

    expect(events.filter((event) => event.type === 'image.pointer')).toEqual([
      {
        assetPointer: 'file-service://file_out',
        fileId: 'file_out',
        messageId: 't1',
        pointerKind: 'file-service',
        type: 'image.pointer',
      },
      {
        assetPointer: 'sediment://file_out',
        fileId: 'file_out',
        messageId: 't1',
        pointerKind: 'sediment',
        type: 'image.pointer',
      },
    ]);
  });

  it('never treats a user attachment pointer as generated output', () => {
    const { events } = feedAll([
      {
        conversation_id: 'conv-1',
        input_message: {
          author: { role: 'user' },
          content: {
            content_type: 'multimodal_text',
            parts: [{ asset_pointer: 'sediment://file_input' }, 'edit this'],
          },
        },
        type: 'input_message',
      },
      {
        o: 'add',
        p: '',
        v: {
          message: {
            author: { role: 'user' },
            content: {
              content_type: 'multimodal_text',
              parts: [{ asset_pointer: 'sediment://file_input' }, 'edit this'],
            },
            id: 'u1',
          },
        },
      },
    ]);

    expect(typesOf(events)).not.toContain('image.pointer');
  });

  it('reports moderation blocks and server metadata', () => {
    const { events } = feedAll([
      { moderation_response: { blocked: true }, type: 'moderation' },
      { moderation_response: { blocked: false }, type: 'moderation' },
      {
        metadata: { model_slug: 'gpt-5-5', tool_invoked: true, turn_use_case: 'image gen' },
        type: 'server_ste_metadata',
      },
    ]);

    expect(events).toEqual([
      { blocked: true, type: 'moderation' },
      {
        modelSlug: 'gpt-5-5',
        toolInvoked: true,
        turnUseCase: 'image gen',
        type: 'metadata',
      },
    ]);
  });

  it('keeps non-JSON payloads as raw events instead of aborting', () => {
    const { events } = feedAll(['not json at all']);
    expect(events).toEqual([{ payload: 'not json at all', type: 'raw' }]);
  });

  it('ignores the "v1" protocol marker', () => {
    expect(feedAll(['"v1"']).events).toEqual([]);
  });

  it('drops the replayed assistant history the upstream echoes back', () => {
    const { events } = feedAll(
      [
        {
          o: 'add',
          p: '',
          v: {
            conversation_id: 'conv-1',
            message: {
              author: { role: 'assistant' },
              channel: 'final',
              content: { content_type: 'text', parts: ['previous answer'] },
              id: 'echo',
            },
          },
        },
        assistantAdd('m1'),
        { o: 'append', p: '/message/content/parts/0', v: 'fresh' },
      ],
      { echoHistory: ['previous answer'] },
    );

    const deltas = events.filter((event) => event.type === 'text.delta') as any[];
    expect(deltas.map((event) => event.delta)).toEqual(['fresh']);
  });

  describe('handoff', () => {
    it('keeps the resume token and reports the handoff', () => {
      const { events, router } = feedAll([
        '"v1"',
        {
          conversation_id: 'conv-h',
          kind: 'topic',
          token: 'resume-jwt',
          type: 'resume_conversation_token',
        },
        {
          conversation_id: 'conv-h',
          options: [
            { topic_id: 'conversation-turn-7', type: 'resume_sse_endpoint' },
            { topic_id: 'ws-7', type: 'subscribe_ws_topic' },
          ],
          turn_exchange_id: 'exchange-7',
          type: 'stream_handoff',
        },
        '[DONE]',
      ]);

      // the token frame itself is bookkeeping, never an event of its own
      expect(typesOf(events)).toEqual(['conversation.start', 'handoff', 'done']);
      expect(router.resumeToken).toBe('resume-jwt');
      expect(events[1]).toEqual({
        conversationId: 'conv-h',
        options: [
          { topicId: 'conversation-turn-7', type: 'resume_sse_endpoint' },
          { topicId: 'ws-7', type: 'subscribe_ws_topic' },
        ],
        resumeToken: 'resume-jwt',
        turnExchangeId: 'exchange-7',
        type: 'handoff',
      });
    });

    it('survives a handoff without options or a preceding token', () => {
      const { events, router } = feedAll([{ conversation_id: 'conv-h', type: 'stream_handoff' }]);

      expect(events).toEqual([
        { conversationId: 'conv-h', type: 'conversation.start' },
        {
          conversationId: 'conv-h',
          options: undefined,
          resumeToken: undefined,
          turnExchangeId: undefined,
          type: 'handoff',
        },
      ]);
      expect(router.resumeToken).toBeUndefined();
    });
  });

  describe('history echoes (reference `strip_history`)', () => {
    const fullMessage = (id: string, text: string) => ({
      o: 'add',
      p: '',
      v: {
        conversation_id: 'conv-1',
        message: {
          author: { role: 'assistant' },
          channel: 'final',
          content: { content_type: 'text', parts: [text] },
          id,
          status: 'finished_successfully',
        },
      },
    });

    const textOf = (events: ConversationEvent[]) =>
      (events.filter((event) => event.type === 'text.delta') as any[])
        .map((event) => event.delta)
        .join('');

    it('strips the history when it PREFIXES the new answer', () => {
      const { events } = feedAll([fullMessage('m1', 'oldfresh')], { echoHistory: ['old'] });
      expect(textOf(events)).toBe('fresh');
    });

    it('strips a repeated history prefix', () => {
      const { events } = feedAll([fullMessage('m1', 'oldoldfresh')], { echoHistory: ['old'] });
      expect(textOf(events)).toBe('fresh');
    });

    it('strips the CONCATENATION of several replayed turns', () => {
      const { events } = feedAll([fullMessage('m1', 'onetwofresh')], {
        echoHistory: ['one', 'two'],
      });
      expect(textOf(events)).toBe('fresh');
    });

    it('emits nothing for an echo of the whole history', () => {
      const { events } = feedAll([fullMessage('m1', 'onetwo')], { echoHistory: ['one', 'two'] });
      expect(textOf(events)).toBe('');
    });

    it('skips an echo of a single replayed turn, then streams the answer', () => {
      const { events } = feedAll(
        [fullMessage('echo', 'one'), assistantAdd('m1'), append('fresh')],
        { echoHistory: ['one', 'two'] },
      );
      expect(textOf(events)).toBe('fresh');
    });

    it('withholds an incrementally streamed echo until it diverges', () => {
      const { events } = feedAll([assistantAdd('m1'), append('ol'), append('d'), append('fresh')], {
        echoHistory: ['old'],
      });
      expect(textOf(events)).toBe('fresh');
    });

    it('does not withhold an answer that merely shares a prefix once it is final', () => {
      const { events } = feedAll([fullMessage('m1', 'ol')], { echoHistory: ['old'] });
      expect(textOf(events)).toBe('ol');
    });
  });

  describe('resume replay (the same message id arrives again from offset 0)', () => {
    const textOf = (events: ConversationEvent[]) =>
      (events.filter((event) => event.type === 'text.delta') as any[]).map((event) => event.delta);

    it('withholds a replayed prefix and emits only the new suffix', () => {
      const router = new ConversationEventRouter();
      const events: ConversationEvent[] = [];
      const feed = (payload: unknown) => events.push(...router.feed(JSON.stringify(payload)));

      // first leg
      feed(assistantAdd('m1'));
      feed(append('Hello'));
      // the resume leg replays the SAME message from the start
      feed({ o: 'replace', p: '/message/content/parts/0', v: 'H' });
      feed({ o: 'replace', p: '/message/content/parts/0', v: 'He' });
      feed({ o: 'replace', p: '/message/content/parts/0', v: 'Hello' });
      // …and only then extends it
      feed({ o: 'replace', p: '/message/content/parts/0', v: 'Hello world' });

      expect(textOf(events)).toEqual(['Hello', ' world']);
      expect(textOf(events).join('')).toBe('Hello world');
    });

    it('withholds a whole replayed message that re-adds the document', () => {
      const { events } = feedAll([
        assistantAdd('m1'),
        append('Hello world'),
        // the resume leg re-installs the document with a shorter snapshot
        {
          o: 'add',
          p: '',
          v: {
            conversation_id: 'conv-1',
            message: {
              author: { role: 'assistant' },
              channel: 'final',
              content: { content_type: 'text', parts: ['Hello'] },
              id: 'm1',
              status: 'in_progress',
            },
          },
        },
      ]);

      expect(textOf(events)).toEqual(['Hello world']);
    });

    it('withholds a divergent replacement rather than duplicating the answer', () => {
      const { events } = feedAll([
        assistantAdd('m1'),
        append('Hello'),
        {
          o: 'replace',
          p: '/message/content/parts/0',
          v: 'Something else entirely',
        },
      ]);

      expect(textOf(events)).toEqual(['Hello']);
    });

    it('applies the same high-water rule to reasoning', () => {
      const thoughtsAdd = (content: string) => ({
        o: 'add',
        p: '',
        v: {
          conversation_id: 'conv-1',
          message: {
            author: { role: 'assistant' },
            channel: 'analysis',
            content: { content_type: 'thoughts', thoughts: [{ content, summary: 'Thinking' }] },
            id: 'r1',
          },
        },
      });

      const { events } = feedAll([
        thoughtsAdd('first step'),
        // replay from the start
        thoughtsAdd('fir'),
        thoughtsAdd('first step'),
        thoughtsAdd('first step and more'),
      ]);

      const deltas = (events.filter((event) => event.type === 'reasoning.delta') as any[]).map(
        (event) => event.delta,
      );
      expect(deltas).toEqual(['Thinking\nfirst step', ' and more']);
    });
  });

  describe('end_turn promotion', () => {
    const handoff = { conversation_id: 'conv-1', type: 'stream_handoff' };

    it('ignores end_turn echoed by a replayed historical assistant message', () => {
      const { events } = feedAll(
        [
          // the upstream replays the turn we sent it, `end_turn: true` and all
          {
            o: 'add',
            p: '',
            v: {
              conversation_id: 'conv-1',
              message: {
                author: { role: 'assistant' },
                channel: 'final',
                content: { content_type: 'text', parts: ['an old answer'] },
                end_turn: true,
                id: 'echo',
                status: 'finished_successfully',
              },
            },
          },
          handoff,
          '[DONE]',
        ],
        { echoHistory: ['an old answer'] },
      );

      // …so the turn is NOT finished and the caller may resume it
      expect(events.at(-1)).toMatchObject({ endTurn: false, type: 'done' });
      expect(events.some((event) => event.type === 'handoff')).toBe(true);
    });

    it.each([
      ['a thoughts message', { channel: 'analysis', content_type: 'thoughts' }],
      ['a tool call', { channel: 'final', content_type: 'text', recipient: 'web' }],
      ['a hidden message', { channel: 'final', content_type: 'text', hidden: true }],
    ])('ignores end_turn on %s', (_label, shape: any) => {
      const { events } = feedAll([
        {
          o: 'add',
          p: '',
          v: {
            conversation_id: 'conv-1',
            message: {
              author: { role: 'assistant' },
              channel: shape.channel,
              content:
                shape.content_type === 'thoughts'
                  ? { content_type: 'thoughts', thoughts: [{ content: 'x', summary: 's' }] }
                  : { content_type: 'text', parts: ['x'] },
              end_turn: true,
              id: 'internal',
              ...(shape.recipient ? { recipient: shape.recipient } : {}),
              ...(shape.hidden ? { metadata: { is_visually_hidden_from_conversation: true } } : {}),
              status: 'finished_successfully',
            },
          },
        },
        '[DONE]',
      ]);

      expect(events.at(-1)).toMatchObject({ endTurn: false, type: 'done' });
    });

    it('still promotes end_turn from the real answer', () => {
      const { events } = feedAll([
        assistantAdd('m1'),
        append('done'),
        { o: 'replace', p: '/message/end_turn', v: true },
        '[DONE]',
      ]);

      expect(events.at(-1)).toMatchObject({ endTurn: true, type: 'done' });
    });
  });

  describe('code-interpreter files', () => {
    // the exact wire shape of a PDF turn (scratchpad/file-probe.txt): the text
    // arrives in three deltas, the last one closing the markdown link together
    // with the final status
    const pdfTurn = [
      assistantAdd('answer-1'),
      append('Done: [Download a'),
      { v: 'ihub-test.pdf](sandbox:/mnt/data/ai' },
      {
        o: 'patch',
        p: '',
        v: [
          { o: 'append', p: '/message/content/parts/0', v: 'hub-test.pdf)' },
          { o: 'replace', p: '/message/status', v: 'finished_successfully' },
          { o: 'replace', p: '/message/end_turn', v: true },
        ],
      },
    ];

    it('emits a file.pointer for the finished answer, before done', () => {
      const { events } = feedAll([...pdfTurn, '[DONE]']);

      expect(events.filter((event) => event.type === 'file.pointer')).toEqual([
        {
          conversationId: 'conv-1',
          messageId: 'answer-1',
          name: 'aihub-test.pdf',
          sandboxPath: '/mnt/data/aihub-test.pdf',
          type: 'file.pointer',
        },
      ]);

      const pointerIndex = events.findIndex((event) => event.type === 'file.pointer');
      const doneIndex = events.findIndex((event) => event.type === 'done');
      expect(pointerIndex).toBeGreaterThan(-1);
      expect(pointerIndex).toBeLessThan(doneIndex);
    });

    it('sweeps a bare mention at [DONE], even without a final status patch', () => {
      // the shape a leg that never patched a final status leaves behind: no
      // markdown link, just the path in prose
      const { events } = feedAll([
        assistantAdd('answer-1'),
        append('saved to sandbox:/mnt/data/out.csv'),
        '[DONE]',
      ]);

      expect(events.filter((event) => event.type === 'file.pointer')).toEqual([
        {
          conversationId: 'conv-1',
          messageId: 'answer-1',
          name: 'out.csv',
          sandboxPath: '/mnt/data/out.csv',
          type: 'file.pointer',
        },
      ]);
      const pointerIndex = events.findIndex((event) => event.type === 'file.pointer');
      expect(pointerIndex).toBeLessThan(events.findIndex((event) => event.type === 'done'));
    });

    it('never reports a half-written path while the answer is still streaming', () => {
      // same turn, cut off mid-link — `[DONE]` sweeps the unfinished message and
      // must not resolve `sandbox:/mnt/data/ai`
      const { events } = feedAll([...pdfTurn.slice(0, 3), '[DONE]']);

      expect(events.some((event) => event.type === 'file.pointer')).toBe(false);
    });

    it('reports the file exactly once when a resume leg replays the answer', () => {
      const router = new ConversationEventRouter();
      const events: ConversationEvent[] = [];
      const feed = (payloads: unknown[]) => {
        for (const payload of payloads)
          events.push(
            ...router.feed(typeof payload === 'string' ? payload : JSON.stringify(payload)),
          );
      };

      feed([...pdfTurn, '[DONE]']);
      // the resume leg replays the same message from offset 0
      feed([
        assistantAdd('answer-1', {
          content: {
            content_type: 'text',
            parts: ['Done: [Download aihub-test.pdf](sandbox:/mnt/data/aihub-test.pdf)'],
          },
          end_turn: true,
          status: 'finished_successfully',
        }),
        '[DONE]',
      ]);

      expect(events.filter((event) => event.type === 'file.pointer')).toHaveLength(1);
    });

    it('picks the link up from a resumed leg that carries it for the first time', () => {
      const { events } = feedAll([
        assistantAdd('answer-1'),
        append('working on it'),
        '[DONE]',
        // resume leg: the same message id, now complete
        assistantAdd('answer-1', {
          content: {
            content_type: 'text',
            parts: ['working on it — [file](sandbox:/mnt/data/out.csv)'],
          },
          end_turn: true,
          status: 'finished_successfully',
        }),
        '[DONE]',
      ]);

      expect(events.filter((event) => event.type === 'file.pointer')).toEqual([
        {
          conversationId: 'conv-1',
          messageId: 'answer-1',
          name: 'out.csv',
          sandboxPath: '/mnt/data/out.csv',
          type: 'file.pointer',
        },
      ]);
    });

    it('ignores a sandbox path in a tool / hidden message', () => {
      const { events } = feedAll([
        {
          o: 'add',
          p: '',
          v: {
            conversation_id: 'conv-1',
            message: {
              author: { name: 'python', role: 'tool' },
              content: { content_type: 'execution_output', text: "'/mnt/data/aihub-test.pdf'" },
              id: 'tool-1',
              status: 'finished_successfully',
            },
          },
        },
        '[DONE]',
      ]);

      expect(events.some((event) => event.type === 'file.pointer')).toBe(false);
    });
  });

  it('surfaces system_error content as an error event', () => {
    const { events } = feedAll([
      {
        o: 'add',
        p: '',
        v: {
          message: {
            author: { role: 'system' },
            content: { content_type: 'system_error', name: 'rate_limit', parts: ['slow down'] },
            id: 'e1',
          },
        },
      },
    ]);

    expect(events).toContainEqual({ code: 'rate_limit', message: 'slow down', type: 'error' });
  });
});
