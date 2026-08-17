import { describe, expect, it } from 'vitest';

/**
 * The root barrel must stay free of the terminal viewer: `./viewer` pulls `gpt-tokenizer`
 * (tens of MB) onto the first-chat-request graph via `heterogeneousAgent` → `parseOperationId`.
 * Viewer consumers import `@lobechat/agent-tracing/viewer` instead.
 */
describe('@lobechat/agent-tracing root barrel', () => {
  it('does not re-export the viewer renderers', async () => {
    const root = await import('./index');
    for (const name of [
      'analyzeAgentSignal',
      'renderAgentSignal',
      'renderMessageDetail',
      'renderSnapshot',
      'renderStepDetail',
      'renderSummaryTable',
    ]) {
      expect(name in root, `${name} leaked into the root barrel`).toBe(false);
    }
    expect(typeof root.parseOperationId).toBe('function');
  });

  it('exposes the viewer through the ./viewer subpath', async () => {
    const viewer = await import('@lobechat/agent-tracing/viewer');
    expect(typeof viewer.renderSnapshot).toBe('function');
    expect(typeof viewer.analyzeAgentSignal).toBe('function');
  });
});
