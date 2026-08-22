import { describe, expect, it } from 'vitest';

import grokChatModels from './grok';

describe('grok chat models', () => {
  it('enables files on every chat card (native document input via the CLI proxy)', () => {
    expect(grokChatModels.length).toBeGreaterThan(0);
    for (const model of grokChatModels) {
      expect(model.type).toBe('chat');
      expect(model.abilities?.files, model.id).toBe(true);
    }
  });
});
