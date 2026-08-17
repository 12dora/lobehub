import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getEgressBinding } from '../egress/hook';
import { bindNetworkProxyEgressIfEnabled, resetNetworkProxyEgressBindForTest } from './bindEgress';

const isBootModuleEnabled = vi.hoisted(() => vi.fn(() => true));

vi.mock('../../moduleSettings', () => ({
  isBootModuleEnabled,
}));

vi.mock('../egress/scope', async () => {
  const { setEgressBinding: bind } = await import('../egress/hook');
  bind({
    createEgressFetch: () => fetch,
    createEgressSafeOutboundTransport: () => ({ streamingTransport: {}, transport: {} }) as never,
    getCurrentScope: () => null,
    getEgressProxyUrlForCurl: async () => null,
    getProxyUrlFor: () => null,
    runWithEgressScope: async (_scope, fn) => fn(),
    wrapRuntimeWithEgressScope: (runtime) => runtime,
  });
  return { bindEgressCacheInvalidation: () => undefined };
});

describe('bindNetworkProxyEgressIfEnabled', () => {
  beforeEach(() => {
    resetNetworkProxyEgressBindForTest();
    isBootModuleEnabled.mockReturnValue(true);
  });

  afterEach(() => {
    resetNetworkProxyEgressBindForTest();
  });

  it('registers the egress hook via a bundler-traceable import', async () => {
    await bindNetworkProxyEgressIfEnabled();
    expect(getEgressBinding()?.getProxyUrlFor).toBeTypeOf('function');
  });
});
