import { fetch as undiciFetch } from 'undici';

import { NETWORK_PROXY_DEFAULTS } from '@/const/platform/networkProxy';

import { onNetworkProxySnapshotChange } from '../snapshot';
import { recordConnectPhaseFailure, recordConnectPhaseSuccess } from './circuit';
import { getSnapshot } from './deps';
import { getDispatcher } from './dispatchers';

const PROBE_INTERVAL_MS = 60_000;
const PROBE_TIMEOUT_MS = 5000;

interface StaticHealth {
  lastCheckedAt: number;
  ok: boolean;
}

/** Unknown until the first successful probe — a dead static outlet is unavailable. */
let health: StaticHealth = { lastCheckedAt: 0, ok: false };
let timer: NodeJS.Timeout | null = null;
let probing = false;
let forcedForTest = false;
let listening = false;

const probeOnce = async (): Promise<void> => {
  if (probing || forcedForTest) return;
  probing = true;
  try {
    const snapshot = await getSnapshot();
    if (!snapshot.config.masterEnabled || snapshot.config.outlet.kind !== 'static') {
      health = { lastCheckedAt: Date.now(), ok: true };
      return;
    }
    const proxyUrl = snapshot.staticProxyUrl;
    if (!proxyUrl) {
      health = { lastCheckedAt: Date.now(), ok: false };
      return;
    }
    const target = snapshot.config.outlet.latencyTestUrl || NETWORK_PROXY_DEFAULTS.LATENCY_TEST_URL;
    const dispatcher = getDispatcher(proxyUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const response = await undiciFetch(target, {
        dispatcher,
        method: 'GET',
        signal: controller.signal,
      });
      const ok = response.status < 500;
      health = { lastCheckedAt: Date.now(), ok };
      if (ok) recordConnectPhaseSuccess('static');
      else recordConnectPhaseFailure('static');
    } catch {
      health = { lastCheckedAt: Date.now(), ok: false };
      recordConnectPhaseFailure('static');
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    probing = false;
  }
};

export const startStaticOutletHealthLoop = (): void => {
  if (!listening) {
    listening = true;
    onNetworkProxySnapshotChange(() => {
      if (forcedForTest) return;
      health = { lastCheckedAt: 0, ok: false };
      void probeOnce();
    });
  }
  if (timer) return;
  void probeOnce();
  timer = setInterval(() => {
    void probeOnce();
  }, PROBE_INTERVAL_MS);
  timer.unref?.();
};

export const getStaticOutletHealth = (): StaticHealth => health;

/** Tests: force the last probe result and skip the live probe. */
export const setStaticOutletHealthForTest = (ok: boolean): void => {
  forcedForTest = true;
  health = { lastCheckedAt: Date.now(), ok };
};

export const stopStaticOutletHealthLoopForTest = (): void => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  health = { lastCheckedAt: 0, ok: false };
  probing = false;
  forcedForTest = false;
};
