import dnsPromises from 'node:dns/promises';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

import { Agent, ProxyAgent, setGlobalDispatcher } from 'undici';

import {
  CANONICAL_FIXTURE_HOST,
  PUBLIC_FIXTURE_ADDRESS,
  redirectPinnedHttpsOptions,
} from './fixtureNetworkContract.mjs';

const proxyUrl = process.env.E2E_IDP_PROXY_URL;
if (!proxyUrl) throw new Error('E2E_IDP_PROXY_URL is required');
const fixturePort = Number(process.env.E2E_IDP_FIXTURE_PORT);
if (!Number.isSafeInteger(fixturePort) || fixturePort < 1 || fixturePort > 65_535) {
  throw new Error('E2E_IDP_FIXTURE_PORT must be a valid TCP port');
}

const originalLookup = dnsPromises.lookup.bind(dnsPromises);
dnsPromises.lookup = async (hostname, options) => {
  if (hostname !== CANONICAL_FIXTURE_HOST) return originalLookup(hostname, options);
  const result = { address: PUBLIC_FIXTURE_ADDRESS, family: 4 };
  return typeof options === 'object' && options?.all ? [result] : result;
};

const originalHttpsRequest = https.request.bind(https);
https.request = (input, optionsOrCallback, maybeCallback) => {
  if (input instanceof URL || typeof input === 'string') {
    return originalHttpsRequest(input, optionsOrCallback, maybeCallback);
  }
  const redirected = redirectPinnedHttpsOptions(input, fixturePort);
  return originalHttpsRequest(redirected, optionsOrCallback);
};

// Refresh named ESM exports already imported by application modules from the patched builtins.
syncBuiltinESMExports();

const direct = new Agent();
const proxy = new ProxyAgent({ uri: proxyUrl });

setGlobalDispatcher({
  close: async () => {
    await Promise.all([direct.close(), proxy.close()]);
  },
  destroy: async (error) => {
    await Promise.all([direct.destroy(error), proxy.destroy(error)]);
  },
  dispatch(options, handler) {
    const origin = new URL(String(options.origin));
    return (origin.hostname === CANONICAL_FIXTURE_HOST ? proxy : direct).dispatch(options, handler);
  },
});
