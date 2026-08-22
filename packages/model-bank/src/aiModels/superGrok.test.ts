import { describe, expect, it } from 'vitest';

import superGrokModels from './superGrok';

describe('superGrok chat models', () => {
  it('enables files on every chat card (native document input via api.x.ai files)', () => {
    const chatModels = superGrokModels.filter((model) => model.type === 'chat');
    expect(chatModels.length).toBeGreaterThan(0);
    for (const model of chatModels) {
      expect(model.abilities?.files, model.id).toBe(true);
    }
  });
});
