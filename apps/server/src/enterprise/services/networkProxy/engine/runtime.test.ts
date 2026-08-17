// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';

import { getEngineRuntime, resetNetworkProxyEngineRuntimeForTest } from './runtime';

afterEach(() => {
  resetNetworkProxyEngineRuntimeForTest();
});

describe('getEngineRuntime', () => {
  it('is safe to call before the supervisor is started', () => {
    const runtime = getEngineRuntime();
    const state = runtime.getState();
    expect(['unsupported', 'not_installed', 'stopped']).toContain(state.state);
    expect(runtime.getLogs()).toEqual([]);
  });
});
