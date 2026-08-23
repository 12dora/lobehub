import type {
  ArtifactStatusView,
  EngineIssue,
  InstanceStatusView,
  NetworkProxyConfigView,
  NetworkProxyStatusView,
} from '@/types/platform/networkProxy';

import type { NetworkProxyGeodataState } from './geodataState';

/**
 * A server that predates the engine-issue model answers without these fields; an admin panel that
 * crashed on that would be worse than one that says nothing.
 */
export const issueOf = (instance: InstanceStatusView): EngineIssue | null =>
  instance.lastIssue ?? null;

export const healingOf = (instance: InstanceStatusView): InstanceStatusView['healing'] =>
  instance.healing ?? null;

/**
 * States that speak for themselves. `running` and `degraded` are live engines, and a `stopped`
 * engine is usually one an admin turned off — none of them is an outage just because the last
 * issue recorded before them is still on the row.
 */
const SELF_EXPLANATORY_STATES = new Set(['degraded', 'running', 'stopped']);

const hasEngineIssue = (instance: InstanceStatusView): boolean =>
  instance.engineState === 'error' ||
  (issueOf(instance) !== null && !SELF_EXPLANATORY_STATES.has(instance.engineState));

/** Engine states that mean the process is up and serving, whatever it reported before. */
export const LIVE_STATES = new Set(['degraded', 'running']);

/** How the instances split into the two engine banners, plus the setup step that is neither. */
export interface EngineInstanceGroups {
  /** At least one instance is missing the smart-routing rule data (a setup step, not a breakage). */
  geodataMissing: boolean;
  /** Automatic recovery is in flight — the supervisor is retrying these by itself. */
  healing: InstanceStatusView[];
  /** Broken with no retry pending — these are the ones that still need a human. */
  terminal: InstanceStatusView[];
}

/**
 * Automatic recovery only exists on an instance the supervisor has given up starting; every
 * other broken instance is terminal and still needs a human. One recovering instance must
 * never hide the ones that are not — they are different problems on different machines.
 */
export const groupEngineInstances = (instances: InstanceStatusView[]): EngineInstanceGroups => {
  const troubled = instances.filter(hasEngineIssue);
  // Missing rule data is a setup step, not a breakage — it gets the install banner below.
  const geodataMissing = troubled.some((instance) => issueOf(instance)?.code === 'geodata_missing');
  const actionable = troubled.filter((instance) => issueOf(instance)?.code !== 'geodata_missing');
  const healing = actionable.filter(
    (instance) => instance.engineState === 'error' && healingOf(instance) !== null,
  );
  const terminal = actionable.filter((instance) => !healing.includes(instance));
  return { geodataMissing, healing, terminal };
};

/** One named state per banner the page can raise. Each kind appears at most once. */
export type NetworkProxyBannerState =
  | { kind: 'artifactsStale' }
  | { kind: 'artifactsUnknown' }
  | { count: number; kind: 'conflict' }
  | { healingCount: number; issue: EngineIssue | null; kind: 'engineIssue'; terminalCount: number }
  | { kind: 'fallback'; scopes: string[] }
  | { kind: 'geodata' }
  | { kind: 'globalProxy' }
  | { kind: 'selfHealed' }
  | { issue: EngineIssue | null; kind: 'selfHealing'; seconds: number }
  | { kind: 'statusStale' }
  | { kind: 'statusUnknown' }
  | { kind: 'unsupported' };

export interface NetworkProxyBannerInput {
  artifacts?: ArtifactStatusView;
  artifactsError?: unknown;
  artifactsStale?: boolean;
  config: NetworkProxyConfigView;
  /** Field ids whose last write lost a CAS race and is waiting for Retry. */
  conflictCount: number;
  fallbackScopes: string[];
  geodataState: NetworkProxyGeodataState;
  globalProxyActive: boolean;
  groups: EngineInstanceGroups;
  /** Whole seconds until the supervisor's next automatic attempt. */
  healingSeconds: number;
  /** An engine the supervisor was retrying came back up a moment ago. */
  selfHealed: boolean;
  status?: NetworkProxyStatusView;
  statusError?: unknown;
  statusStale?: boolean;
}

type BannerRule = (input: NetworkProxyBannerInput) => NetworkProxyBannerState | null;

const conflictRule: BannerRule = ({ conflictCount }) =>
  conflictCount > 0 ? { count: conflictCount, kind: 'conflict' } : null;

const globalProxyRule: BannerRule = ({ globalProxyActive }) =>
  globalProxyActive ? { kind: 'globalProxy' } : null;

/** A failed *query* is unknown state with a Retry, never a healthy-looking "nothing is there". */
const statusUnknownRule: BannerRule = ({ status, statusError }) =>
  statusError && !status ? { kind: 'statusUnknown' } : null;

const artifactsUnknown = (input: NetworkProxyBannerInput): boolean =>
  Boolean(input.artifactsError) && !input.artifacts;

const artifactsUnknownRule: BannerRule = (input) =>
  artifactsUnknown(input) ? { kind: 'artifactsUnknown' } : null;

const statusStaleRule: BannerRule = ({ statusStale }) =>
  statusStale ? { kind: 'statusStale' } : null;

const artifactsStaleRule: BannerRule = ({ artifactsStale }) =>
  artifactsStale ? { kind: 'artifactsStale' } : null;

const unsupportedRule: BannerRule = ({ artifacts }) =>
  artifacts && !artifacts.engine.supported ? { kind: 'unsupported' } : null;

const selfHealedRule: BannerRule = ({ selfHealed }) => (selfHealed ? { kind: 'selfHealed' } : null);

/**
 * The engine gets exactly one banner: an instance id means nothing to the person reading it, and
 * two banners about one engine read as two outages. While the supervisor is retrying by itself,
 * that banner says so — with the countdown — instead of demanding an action nobody needs to take.
 */
const engineRule: BannerRule = ({ groups, healingSeconds }) => {
  const { healing, terminal } = groups;
  if (terminal.length > 0) {
    return {
      healingCount: healing.length,
      issue: terminal[0] ? issueOf(terminal[0]) : null,
      kind: 'engineIssue',
      terminalCount: terminal.length,
    };
  }
  if (healing.length > 0) {
    return {
      issue: healing[0] ? issueOf(healing[0]) : null,
      kind: 'selfHealing',
      seconds: healingSeconds,
    };
  }
  return null;
};

const fallbackRule: BannerRule = ({ fallbackScopes }) =>
  fallbackScopes.length > 0 ? { kind: 'fallback', scopes: fallbackScopes } : null;

/**
 * Only claim geodata is missing when we actually know what is installed — an unreachable
 * status query is not evidence of an empty disk.
 */
const geodataRule: BannerRule = (input) => {
  const missing =
    input.groups.geodataMissing ||
    (input.config.ruleMode === 'smart' && input.geodataState === 'missing');
  return missing && !artifactsUnknown(input) ? { kind: 'geodata' } : null;
};

/**
 * Every failure state on this page, stated as "what is happening / what to do" (DESIGN.md,
 * 确定性). **This array is the precedence** — banners render in exactly this order, and the two
 * engine states share one slot because they describe one engine.
 */
const BANNER_RULES: BannerRule[] = [
  conflictRule,
  globalProxyRule,
  statusUnknownRule,
  artifactsUnknownRule,
  statusStaleRule,
  artifactsStaleRule,
  unsupportedRule,
  selfHealedRule,
  engineRule,
  fallbackRule,
  geodataRule,
];

export const resolveNetworkProxyBanners = (
  input: NetworkProxyBannerInput,
): NetworkProxyBannerState[] =>
  BANNER_RULES.map((rule) => rule(input)).filter(
    (state): state is NetworkProxyBannerState => state !== null,
  );
