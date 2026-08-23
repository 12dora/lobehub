import type { ChildProcess } from 'node:child_process';

import type { NetworkProxyEngineIssueCode } from '@/const/platform/networkProxy';

import type { InstalledArtifact } from './artifacts';
import type { NetworkProxyRuntimeSnapshot } from './b1';
import type { EngineLogRing } from './logs';
import type { enginePaths } from './platform';
import type { EngineRestClient } from './restClient';
import type { EngineRuntimeState } from './types';

/** Mutable runtime handle matching EngineSupervisor fields/methods used by extracted units. */
export type SupervisorHandle = {
  appliedEngineGeneration: number | null;
  appliedRevision: number | null;
  backoffMs: number;
  child: ChildProcess | null;
  controllerPort: number | null;
  controllerSecret: string | null;
  crashLimit: number;
  crashTimes: number[];
  crashWindowMs: number;
  desiredStop: boolean;
  healthFailures: number;
  healthFailuresBeforeRestart: number;
  healthIntervalMs: number;
  healthTimer: ReturnType<typeof setInterval> | null;
  healBackoffBaseMs: number;
  healBackoffMaxMs: number;
  lastAttemptedEngineGeneration: number | null;
  listenerPassword: string | null;
  logs: EngineLogRing;
  mixedPort: number | null;
  rest: EngineRestClient | null;
  startedAt: number | null;
  starting: boolean;
  startWaitMs: number;
  state: EngineRuntimeState;
  version: string | null;

  desiredRun: (snapshot: NetworkProxyRuntimeSnapshot, binary: InstalledArtifact | null) => boolean;
  enterErrorState: (generation?: number | null) => void;
  markAttemptedGeneration: (generation: number) => void;
  onChildExit: (code: number | null, signal: NodeJS.Signals | null) => Promise<void>;
  patchState: (patch: Partial<EngineRuntimeState>) => void;
  patchStopped: (binary: InstalledArtifact | null, reason: 'desired' | 'failure') => void;
  paths: () => ReturnType<typeof enginePaths>;
  restart: () => Promise<void>;
  restartNow: () => Promise<boolean>;
  runExclusive: <T>(work: () => Promise<T>) => Promise<T>;
  setIssue: (code: NetworkProxyEngineIssueCode, error?: unknown) => void;
  setIssueFromUnknown: (error: unknown) => void;
  startEngineNow: () => Promise<boolean>;
  startHealthLoop: () => void;
  stopEngineNow: () => Promise<void>;
  stopHealthLoop: () => void;
};
