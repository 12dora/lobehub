/**
 * Isolated kill-switch coverage: this file must not probe at module load.
 * `vi.resetModules()` + env are set before importing the ChatGPT fetch factory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('CHATGPT_WEB_TRANSPORT=cli kill switch', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('CHATGPT_WEB_TRANSPORT', 'cli');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('does not probe or load libcurl when the factory is imported after cli is set', async () => {
    const barrel = await import('./index');
    const spy = vi.spyOn(barrel, 'probeLibcurlImpersonate');
    const { getChatGPTWebFetch, getChatGPTWebTransportStatus } =
      await import('../../chatgptWeb/transport/curlImpersonateFetch');

    expect(getChatGPTWebTransportStatus()).toMatchObject({ mode: 'cli' });
    expect(typeof getChatGPTWebFetch()).toBe('function');
    expect(spy).not.toHaveBeenCalled();
  });
});
