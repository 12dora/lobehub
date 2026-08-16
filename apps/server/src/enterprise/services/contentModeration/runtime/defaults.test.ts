import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultModerationRuntimeDeps } from './defaults';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createDefaultModerationRuntimeDeps logger', () => {
  it('never prints an Error message that contains secrets', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const deps = createDefaultModerationRuntimeDeps({
      db: {} as never,
      provider: 'openai',
      userId: 'user-1',
    });

    deps.logger?.error('failed', new Error('upstream sk-abc leaked prompt'));

    expect(spy).toHaveBeenCalledWith(
      '[content-moderation]',
      expect.objectContaining({ code: 'upstream_error', errorClass: 'Error' }),
    );
    expect(JSON.stringify(spy.mock.calls)).not.toContain('sk-abc');
  });
});
