import { NETWORK_PROXY_ENV } from '@/const/platform/networkProxy';
import { isPersistentEnterpriseWorkerRuntime } from '@/server/enterprise/jobs/persistentWorkerRuntime';

import { startInstanceStatusReporter } from './instanceStatusReporter';
import { EngineSupervisor } from './supervisor';
import type { EngineRuntime } from './types';

export type { EngineRuntime, EngineRuntimeState } from './types';

let singleton: EngineSupervisor | null = null;
let loopsStarted = false;
let stopStatusReporter: (() => void) | null = null;

export const getEngineRuntime = (): EngineRuntime => {
  singleton ??= new EngineSupervisor();
  return singleton;
};

export const ensureNetworkProxyEngineSupervisorStarted = (): void => {
  if (loopsStarted) return;
  const autostart = process.env[NETWORK_PROXY_ENV.ENGINE_AUTOSTART] === '1';
  if (!isPersistentEnterpriseWorkerRuntime() && !autostart) return;
  loopsStarted = true;
  const runtime = getEngineRuntime() as EngineSupervisor;
  runtime.startLoops();
  stopStatusReporter = startInstanceStatusReporter(runtime);
};

/** Test seam — drop the process singleton so isolated cases can start clean. */
export const resetNetworkProxyEngineRuntimeForTest = (): void => {
  stopStatusReporter?.();
  stopStatusReporter = null;
  loopsStarted = false;
  singleton = null;
};
