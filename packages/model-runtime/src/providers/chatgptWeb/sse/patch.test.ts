import { describe, expect, it } from 'vitest';

import { applyPatchEvent, createPatchState, getPatchedValue } from './patch';

const text = (state: ReturnType<typeof createPatchState>) =>
  getPatchedValue(state, '/message/content/parts/0');

describe('applyPatchEvent', () => {
  it('installs a whole message from an add event and from v.message', () => {
    const state = createPatchState();

    applyPatchEvent(state, {
      c: 3,
      o: 'add',
      p: '',
      v: { conversation_id: 'conv-1', message: { content: { parts: ['hi'] }, id: 'm1' } },
    });
    expect(state.root.conversation_id).toBe('conv-1');
    expect(text(state)).toBe('hi');

    applyPatchEvent(state, { message: { content: { parts: ['whole'] }, id: 'm2' } });
    expect(getPatchedValue(state, '/message/id')).toBe('m2');
    expect(text(state)).toBe('whole');
  });

  it('appends and replaces at an explicit path', () => {
    const state = createPatchState();
    applyPatchEvent(state, { o: 'add', p: '', v: { message: { content: { parts: [''] } } } });

    applyPatchEvent(state, { o: 'append', p: '/message/content/parts/0', v: 'Hello' });
    applyPatchEvent(state, { o: 'append', p: '/message/content/parts/0', v: ' world' });
    expect(text(state)).toBe('Hello world');

    applyPatchEvent(state, { o: 'replace', p: '/message/content/parts/0', v: 'reset' });
    expect(text(state)).toBe('reset');
  });

  it('supports the implicit-append shorthand', () => {
    const state = createPatchState();
    applyPatchEvent(state, { o: 'add', p: '', v: { message: { content: { parts: [''] } } } });
    applyPatchEvent(state, { o: 'append', p: '/message/content/parts/0', v: 'Hello' });

    applyPatchEvent(state, { v: ' world' });
    applyPatchEvent(state, { v: '!' });

    expect(text(state)).toBe('Hello world!');
  });

  it('applies patch arrays in order, including status and end_turn', () => {
    const state = createPatchState();
    applyPatchEvent(state, { o: 'add', p: '', v: { message: { content: { parts: ['a'] } } } });

    applyPatchEvent(state, {
      o: 'patch',
      p: '',
      v: [
        { o: 'append', p: '/message/content/parts/0', v: 'b' },
        { o: 'replace', p: '/message/status', v: 'finished_successfully' },
        { o: 'replace', p: '/message/end_turn', v: true },
      ],
    });

    expect(text(state)).toBe('ab');
    expect(getPatchedValue(state, '/message/status')).toBe('finished_successfully');
    expect(getPatchedValue(state, '/message/end_turn')).toBe(true);
  });

  it('patches non-text paths so reasoning and citations fall out for free', () => {
    const state = createPatchState();
    applyPatchEvent(state, {
      o: 'add',
      p: '',
      v: { message: { content: { content_type: 'thoughts', thoughts: [] } } },
    });

    applyPatchEvent(state, {
      o: 'add',
      p: '/message/content/thoughts/0',
      v: { content: 'Because', summary: 'Thinking' },
    });
    applyPatchEvent(state, { o: 'append', p: '/message/content/thoughts/0/content', v: ' 1 + 1.' });
    applyPatchEvent(state, {
      o: 'replace',
      p: '/message/metadata/content_references',
      v: [{ type: 'webpage', url: 'https://example.com' }],
    });

    expect(getPatchedValue(state, '/message/content/thoughts/0')).toEqual({
      content: 'Because 1 + 1.',
      summary: 'Thinking',
    });
    expect(getPatchedValue(state, '/message/metadata/content_references')).toEqual([
      { type: 'webpage', url: 'https://example.com' },
    ]);
  });

  it('appends into arrays and removes entries', () => {
    const state = createPatchState();
    applyPatchEvent(state, { o: 'add', p: '', v: { message: { content: { parts: ['a'] } } } });

    applyPatchEvent(state, { o: 'append', p: '/message/content/parts', v: 'b' });
    expect(getPatchedValue(state, '/message/content/parts')).toEqual(['a', 'b']);

    applyPatchEvent(state, { o: 'remove', p: '/message/content/parts/0' });
    expect(getPatchedValue(state, '/message/content/parts')).toEqual(['b']);
  });

  it('ignores the shorthand before any document exists', () => {
    const state = createPatchState();
    expect(applyPatchEvent(state, { v: 'orphan' })).toBe(false);
    expect(state.root).toBeUndefined();
  });

  describe('prototype pollution', () => {
    it.each([
      '/__proto__/chatgptWebPolluted',
      '/constructor/prototype/chatgptWebPolluted',
      '/message/__proto__/chatgptWebPolluted',
      '/message/constructor/chatgptWebPolluted',
    ])('refuses to write through %s', (path) => {
      const state = createPatchState();
      applyPatchEvent(state, { o: 'add', p: '', v: { message: { content: { parts: [''] } } } });

      applyPatchEvent(state, { o: 'add', p: path, v: 'yes' });
      applyPatchEvent(state, { o: 'replace', p: path, v: 'yes' });
      applyPatchEvent(state, { o: 'append', p: path, v: 'yes' });

      expect(({} as any).chatgptWebPolluted).toBeUndefined();
      expect((Object.prototype as any).chatgptWebPolluted).toBeUndefined();
      expect(getPatchedValue(state, path)).toBeUndefined();
    });

    it('never traverses into an inherited property', () => {
      const state = createPatchState();
      applyPatchEvent(state, { o: 'add', p: '', v: { message: {} } });
      // `toString` exists on the prototype chain but not as an own property
      applyPatchEvent(state, { o: 'add', p: '/message/toString/hijacked', v: 'yes' });

      expect((String.prototype as any).hijacked).toBeUndefined();
      expect({}.toString).toBe(Object.prototype.toString);
    });
  });

  describe('array containers', () => {
    it('creates an array when the next segment is an index', () => {
      const state = createPatchState();
      applyPatchEvent(state, { o: 'add', p: '', v: {} });
      applyPatchEvent(state, { o: 'add', p: '/items/0/name', v: 'x' });

      expect(Array.isArray(getPatchedValue(state, '/items'))).toBe(true);
      expect(getPatchedValue(state, '/items')).toEqual([{ name: 'x' }]);
    });

    it('inserts on an indexed add and appends on `-`', () => {
      const state = createPatchState();
      applyPatchEvent(state, { o: 'add', p: '', v: { list: ['a', 'c'] } });

      applyPatchEvent(state, { o: 'add', p: '/list/1', v: 'b' });
      expect(getPatchedValue(state, '/list')).toEqual(['a', 'b', 'c']);

      applyPatchEvent(state, { o: 'add', p: '/list/-', v: 'd' });
      expect(getPatchedValue(state, '/list')).toEqual(['a', 'b', 'c', 'd']);
    });

    it('keeps replace overwriting in place', () => {
      const state = createPatchState();
      applyPatchEvent(state, { o: 'add', p: '', v: { list: ['a', 'c'] } });

      applyPatchEvent(state, { o: 'replace', p: '/list/1', v: 'b' });
      expect(getPatchedValue(state, '/list')).toEqual(['a', 'b']);
    });
  });

  it('walks a bare array of operations', () => {
    const state = createPatchState();
    applyPatchEvent(state, { o: 'add', p: '', v: { message: { content: { parts: [''] } } } });

    applyPatchEvent(state, {
      v: [
        { o: 'append', p: '/message/content/parts/0', v: 'x' },
        { o: 'append', p: '/message/content/parts/0', v: 'y' },
      ],
    });

    expect(text(state)).toBe('xy');
  });
});
