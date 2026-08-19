import { describe, expect, it } from 'vitest';

import cursorChatModels from './cursor';

describe('cursor chat models', () => {
  it('enables functionCall on every chat model (prompt-protocol emulation is model-agnostic)', () => {
    expect(cursorChatModels.length).toBeGreaterThan(0);
    for (const model of cursorChatModels) {
      expect(model.type).toBe('chat');
      expect(model.abilities?.functionCall, model.id).toBe(true);
    }
  });
});
