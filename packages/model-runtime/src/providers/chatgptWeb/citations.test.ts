import { describe, expect, it } from 'vitest';

import {
  citationsFromMessage,
  extractCitations,
  latestAssistantMessage,
  turnAnswerMessage,
} from './citations';

const doc = (messages: Record<string, any>[]) => ({
  mapping: Object.fromEntries(messages.map((message, index) => [`n${index}`, { message }])),
});

describe('citationsFromMessage', () => {
  it('flattens grouped content_references and keeps offsets', () => {
    const citations = citationsFromMessage({
      metadata: {
        content_references: [
          {
            end_idx: 40,
            items: [
              { attribution: 'example.com', title: 'A', url: 'https://example.com/a' },
              { title: 'B', url: 'https://example.com/b' },
            ],
            start_idx: 12,
            type: 'grouped_webpages',
          },
        ],
      },
    });

    expect(citations).toHaveLength(2);
    expect(citations[0]).toMatchObject({
      attribution: 'example.com',
      endIx: 40,
      groupType: 'grouped_webpages',
      startIx: 12,
      title: 'A',
      url: 'https://example.com/a',
    });
  });

  it('merges the legacy citations array and dedupes by url', () => {
    const citations = citationsFromMessage({
      metadata: {
        citations: [
          {
            end_ix: 20,
            metadata: {
              text: 'snippet',
              title: 'A',
              type: 'webpage',
              url: 'https://example.com/a',
            },
            start_ix: 10,
          },
        ],
        content_references: [{ type: 'webpage', url: 'https://example.com/a' }],
      },
    });

    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({ snippet: 'snippet', startIx: 10, title: 'A' });
  });

  it('trims trailing punctuation from urls', () => {
    expect(
      citationsFromMessage({
        metadata: { content_references: [{ url: 'https://example.com/a。' }] },
      })[0].url,
    ).toBe('https://example.com/a');
  });
});

describe('latestAssistantMessage', () => {
  it('picks the newest visible assistant message', () => {
    const message = latestAssistantMessage(
      doc([
        { author: { role: 'user' }, create_time: 30 },
        { author: { role: 'assistant' }, create_time: 10, id: 'old' },
        {
          author: { role: 'assistant' },
          create_time: 25,
          id: 'hidden',
          metadata: { is_visually_hidden_from_conversation: true },
        },
        { author: { role: 'assistant' }, create_time: 20, id: 'new' },
      ]),
    );

    expect(message?.id).toBe('new');
  });

  it.each([
    ['a newer thoughts message', { channel: 'analysis', content: { content_type: 'thoughts' } }],
    ['a newer tool call', { recipient: 'web' }],
    ['a newer non-final channel', { channel: 'analysis' }],
    ['a newer code message', { content: { content_type: 'code' } }],
    ['a newer hidden message', { metadata: { is_visually_hidden_from_conversation: true } }],
  ])('ignores %s and keeps the final answer', (_label, extra) => {
    const message = latestAssistantMessage(
      doc([
        {
          author: { role: 'assistant' },
          channel: 'final',
          content: { content_type: 'text', parts: ['the answer'] },
          create_time: 10,
          id: 'answer',
        },
        { author: { role: 'assistant' }, create_time: 99, id: 'noise', ...extra },
      ]),
    );

    expect(message?.id).toBe('answer');
  });

  it('accepts a multimodal_text answer', () => {
    const message = latestAssistantMessage(
      doc([
        {
          author: { role: 'assistant' },
          content: { content_type: 'multimodal_text', parts: [] },
          create_time: 5,
          id: 'mm',
        },
      ]),
    );

    expect(message?.id).toBe('mm');
  });
});

describe('turnAnswerMessage', () => {
  const historical = {
    author: { role: 'assistant' },
    content: { content_type: 'text', parts: ['last week’s answer'] },
    create_time: 100,
    id: 'old-answer',
  };
  const fresh = {
    author: { role: 'assistant' },
    content: { content_type: 'text', parts: ['this turn’s answer'] },
    create_time: 500,
    id: 'new-answer',
  };
  const document = {
    mapping: {
      'my-user-message': { message: { author: { role: 'user' }, create_time: 400 } },
      'new-answer': { message: fresh, parent: 'my-user-message' },
      'old-answer': { message: historical, parent: 'someone-elses-turn' },
    },
  };

  it('accepts only an answer that descends from this turn’s user message', () => {
    expect(turnAnswerMessage(document, { userMessageId: 'my-user-message' })?.id).toBe(
      'new-answer',
    );
  });

  it('accepts an answer created after the request was sent', () => {
    expect(turnAnswerMessage(document, { since: 450 })?.id).toBe('new-answer');
  });

  it('never returns a replayed historical answer', () => {
    // the turn's own answer is not in the document yet
    const replayOnly = { mapping: { 'old-answer': document.mapping['old-answer'] } };

    expect(
      turnAnswerMessage(replayOnly, { since: 450, userMessageId: 'my-user-message' }),
    ).toBeUndefined();
  });

  it('refuses to guess without a correlation anchor', () => {
    expect(turnAnswerMessage(document)).toBeUndefined();
  });

  describe('anchored answers outrank the timestamp fallback', () => {
    const anchoredAt = (time: number) => ({
      author: { role: 'assistant' },
      content: { content_type: 'text', parts: ['the answer to THIS turn'] },
      create_time: time,
      id: 'anchored',
    });
    const unrelatedAt = (time: number) => ({
      author: { role: 'assistant' },
      content: { content_type: 'text', parts: ['a different branch'] },
      create_time: time,
      id: 'unrelated',
    });

    it('never lets a newer unrelated branch outrank the anchored answer', () => {
      const branched = {
        mapping: {
          'my-user-message': { message: { author: { role: 'user' }, create_time: 10 } },
          'anchored': { message: anchoredAt(11), parent: 'my-user-message' },
          'unrelated': { message: unrelatedAt(12), parent: 'another-turn' },
        },
      };

      expect(turnAnswerMessage(branched, { since: 10, userMessageId: 'my-user-message' })?.id).toBe(
        'anchored',
      );
    });

    it('still falls back to the timestamp when nothing descends from the anchor', () => {
      const noDescendant = {
        mapping: {
          unrelated: { message: unrelatedAt(12), parent: 'another-turn' },
        },
      };

      expect(
        turnAnswerMessage(noDescendant, { since: 10, userMessageId: 'my-user-message' })?.id,
      ).toBe('unrelated');
    });

    it('keeps the newest anchored answer when several descend from the anchor', () => {
      const regenerated = {
        mapping: {
          'my-user-message': { message: { author: { role: 'user' }, create_time: 10 } },
          'anchored': { message: anchoredAt(11), parent: 'my-user-message' },
          'anchored-2': {
            message: { ...anchoredAt(13), id: 'anchored-newer' },
            parent: 'my-user-message',
          },
        },
      };

      expect(
        turnAnswerMessage(regenerated, { since: 10, userMessageId: 'my-user-message' })?.id,
      ).toBe('anchored-newer');
    });

    it('accepts an anchored answer whose timestamp equals the request mark', () => {
      const sameSecond = {
        mapping: {
          'my-user-message': { message: { author: { role: 'user' }, create_time: 10 } },
          'anchored': { message: anchoredAt(10), parent: 'my-user-message' },
        },
      };

      // `since` alone would reject it (strictly greater); the anchor carries it
      expect(
        turnAnswerMessage(sameSecond, { since: 10, userMessageId: 'my-user-message' })?.id,
      ).toBe('anchored');
    });
  });

  it('walks a multi-hop parent chain', () => {
    const deep = {
      mapping: {
        'my-user-message': { message: { author: { role: 'user' } } },
        'thoughts': {
          message: { author: { role: 'assistant' }, channel: 'analysis' },
          parent: 'my-user-message',
        },
        'answer': { message: { ...fresh, create_time: 10 }, parent: 'thoughts' },
      },
    };

    expect(turnAnswerMessage(deep, { userMessageId: 'my-user-message' })?.id).toBe('new-answer');
  });
});

describe('extractCitations', () => {
  it('prefers the structured references', () => {
    expect(
      extractCitations(
        doc([
          {
            author: { role: 'assistant' },
            create_time: 1,
            metadata: {
              content_references: [{ title: 'A', url: 'https://example.com/a' }],
              extra: { avatar: { url: 'https://cdn.example.com/avatar.png' } },
            },
          },
        ]),
      ),
    ).toEqual([expect.objectContaining({ url: 'https://example.com/a' })]);
  });

  it('falls back to the recursive harvest when there are no references', () => {
    const citations = extractCitations(
      doc([
        {
          author: { role: 'assistant' },
          create_time: 1,
          metadata: { search_result_groups: [{ entries: [{ url: 'https://harvested.dev/x' }] }] },
        },
      ]),
    );

    expect(citations.map((citation) => citation.url)).toEqual(['https://harvested.dev/x']);
  });

  it('returns nothing for an empty document', () => {
    expect(extractCitations(undefined)).toEqual([]);
    expect(extractCitations({ mapping: {} })).toEqual([]);
  });
});
