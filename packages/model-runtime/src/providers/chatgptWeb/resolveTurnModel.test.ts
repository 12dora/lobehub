import { describe, expect, it } from 'vitest';

import { resolveChatGPTWebTurn } from './resolveTurnModel';

describe('resolveChatGPTWebTurn', () => {
  it('never remaps a slug — the selected model is the wire model', () => {
    expect(resolveChatGPTWebTurn({ model: 'gpt-5-6', thinkingEffort: 'max' })).toEqual({
      model: 'gpt-5-6',
    });
    expect(resolveChatGPTWebTurn({ model: 'auto', thinkingEffort: 'extended' })).toEqual({
      model: 'auto',
    });
  });

  describe('*-thinking', () => {
    it('sends the chosen standard / extended / max value', () => {
      expect(
        resolveChatGPTWebTurn({ model: 'gpt-5-6-thinking', thinkingEffort: 'standard' }),
      ).toEqual({ model: 'gpt-5-6-thinking', thinkingEffort: 'standard' });
      expect(
        resolveChatGPTWebTurn({ model: 'gpt-5-6-thinking', thinkingEffort: 'extended' }),
      ).toEqual({ model: 'gpt-5-6-thinking', thinkingEffort: 'extended' });
      expect(resolveChatGPTWebTurn({ model: 'gpt-5-6-thinking', thinkingEffort: 'max' })).toEqual({
        model: 'gpt-5-6-thinking',
        thinkingEffort: 'max',
      });
    });

    it('omits thinking_effort when unset', () => {
      expect(resolveChatGPTWebTurn({ model: 'gpt-5-6-thinking' })).toEqual({
        model: 'gpt-5-6-thinking',
      });
    });

    it('still aliases legacy low/medium/high/xhigh', () => {
      expect(resolveChatGPTWebTurn({ model: 'gpt-5-6-thinking', thinkingEffort: 'low' })).toEqual({
        model: 'gpt-5-6-thinking',
        thinkingEffort: 'standard',
      });
      expect(resolveChatGPTWebTurn({ model: 'gpt-5-6-thinking', thinkingEffort: 'xhigh' })).toEqual(
        {
          model: 'gpt-5-6-thinking',
          thinkingEffort: 'extended',
        },
      );
    });

    it('never puts instant or pro on the wire as thinking_effort', () => {
      expect(
        resolveChatGPTWebTurn({ model: 'gpt-5-6-thinking', thinkingEffort: 'instant' }),
      ).toEqual({ model: 'gpt-5-6-thinking' });
      expect(resolveChatGPTWebTurn({ model: 'gpt-5-6-thinking', thinkingEffort: 'pro' })).toEqual({
        model: 'gpt-5-6-thinking',
      });
    });
  });

  describe('*-pro', () => {
    it('always sends standard, ignoring leftovers', () => {
      expect(resolveChatGPTWebTurn({ model: 'gpt-5-6-pro' })).toEqual({
        model: 'gpt-5-6-pro',
        thinkingEffort: 'standard',
      });
      expect(resolveChatGPTWebTurn({ model: 'gpt-5-6-pro', thinkingEffort: 'max' })).toEqual({
        model: 'gpt-5-6-pro',
        thinkingEffort: 'standard',
      });
    });
  });

  it.each(['auto', 'gpt-5-6', 'gpt-5-6-instant', 'gpt-5-6-mini', 'o3'] as const)(
    'never sends thinking_effort for %s even with a leftover value',
    (model) => {
      expect(resolveChatGPTWebTurn({ model, thinkingEffort: 'max' })).toEqual({ model });
      expect(resolveChatGPTWebTurn({ model })).toEqual({ model });
    },
  );
});
