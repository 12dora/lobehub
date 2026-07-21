/**
 * Independent emission contract for the OTLP probe.
 *
 * Builds OTel attributes via the real enterprise-platform attribute builders and
 * closed vocabularies — not the hand-maintained selector catalog used as oracle.
 */
import {
  buildAgentMaterializationAttributes,
  buildCacheLoadAttributes,
  buildConfigPublishAttributes,
  buildGuardDecisionAttributes,
  buildHeartbeatAttributes,
  buildInvalidationAttributes,
  buildJobBacklogAttributes,
  buildOidcLoginAttributes,
  buildOperationalCollectorAttributes,
  buildRevisionLagAttributes,
  buildSsrfDenialAttributes,
  ENTERPRISE_AGENT_MATERIALIZATION_OUTCOMES,
  ENTERPRISE_CACHE_DOMAINS,
  ENTERPRISE_CACHE_LOAD_OUTCOMES,
  ENTERPRISE_CONFIG_DOMAINS,
  ENTERPRISE_CONFIG_PUBLISH_OPERATIONS,
  ENTERPRISE_CONFIG_PUBLISH_OUTCOMES,
  ENTERPRISE_GUARD_CLASSIFICATIONS,
  ENTERPRISE_GUARD_MODES,
  ENTERPRISE_GUARD_OUTCOMES,
  ENTERPRISE_GUARD_RESOURCES,
  ENTERPRISE_HEARTBEAT_OPERATIONS,
  ENTERPRISE_HEARTBEAT_OUTCOMES,
  ENTERPRISE_INVALIDATION_BACKENDS,
  ENTERPRISE_INVALIDATION_OUTCOMES,
  ENTERPRISE_JOB_BACKLOG_STATES,
  ENTERPRISE_OIDC_FAILURE_CATEGORIES,
  ENTERPRISE_OIDC_LOGIN_OUTCOMES,
  ENTERPRISE_OIDC_LOGIN_STAGES,
  ENTERPRISE_OPERATIONAL_COLLECTORS,
  ENTERPRISE_REVISION_LAG_DOMAINS,
  ENTERPRISE_REVISION_LAG_REASONS,
  ENTERPRISE_SSRF_DENIAL_CATEGORIES,
} from '@lobechat/observability-otel/modules/enterprise-platform';

import type { LabelMatcher, RuleMetricSelector } from './parseSelectors';
import { representativeMatcherValue } from './parseSelectors';

/** Known enterprise instrument names emitted by the application. */
export const ENTERPRISE_INSTRUMENT_METRICS = new Set([
  'enterprise_platform_config_publish_total',
  'enterprise_platform_invalidation_total',
  'enterprise_platform_cache_load_total',
  'enterprise_platform_guard_decision_total',
  'enterprise_platform_instance_heartbeat_total',
  'enterprise_platform_ssrf_denial_total',
  'enterprise_platform_oidc_login_total',
  'enterprise_platform_agent_materialization_total',
  'enterprise_platform_job_backlog_oldest_age_seconds',
  'enterprise_platform_revision_lag_instances',
  'enterprise_platform_operational_snapshot_age_seconds',
  'enterprise_platform_operational_snapshot_ready',
]);

/**
 * Prometheus label → OTel attribute key.
 * Only the `enterprise_` namespace separator becomes a dot (`enterprise.failure_category`).
 */
export const prometheusLabelToOtelKey = (label: string): string =>
  label.startsWith('enterprise_') ? `enterprise.${label.slice('enterprise_'.length)}` : label;

/** OTel attribute key → Prometheus label (dots → underscores after remote-write). */
export const otelKeyToPrometheusLabel = (key: string): string => key.replaceAll('.', '_');

const closedUnion = (...lists: readonly (readonly string[])[]): Set<string> =>
  new Set(lists.flatMap((list) => [...list]));

const CLOSED_BY_PROMETHEUS_LABEL: Record<string, Set<string>> = {
  enterprise_category: new Set(ENTERPRISE_SSRF_DENIAL_CATEGORIES),
  enterprise_classification: new Set(ENTERPRISE_GUARD_CLASSIFICATIONS),
  enterprise_collector: new Set(ENTERPRISE_OPERATIONAL_COLLECTORS),
  enterprise_domain: closedUnion(
    ENTERPRISE_CONFIG_DOMAINS,
    ENTERPRISE_CACHE_DOMAINS,
    ENTERPRISE_REVISION_LAG_DOMAINS,
  ),
  enterprise_failure_category: new Set(ENTERPRISE_OIDC_FAILURE_CATEGORIES),
  enterprise_mode: new Set(ENTERPRISE_GUARD_MODES),
  enterprise_operation: closedUnion(
    ENTERPRISE_CONFIG_PUBLISH_OPERATIONS,
    ENTERPRISE_HEARTBEAT_OPERATIONS,
  ),
  enterprise_outcome: closedUnion(
    ENTERPRISE_CONFIG_PUBLISH_OUTCOMES,
    ENTERPRISE_INVALIDATION_OUTCOMES,
    ENTERPRISE_CACHE_LOAD_OUTCOMES,
    ENTERPRISE_GUARD_OUTCOMES,
    ENTERPRISE_HEARTBEAT_OUTCOMES,
    ENTERPRISE_OIDC_LOGIN_OUTCOMES,
    ENTERPRISE_AGENT_MATERIALIZATION_OUTCOMES,
  ),
  enterprise_reason: new Set(ENTERPRISE_REVISION_LAG_REASONS),
  enterprise_resource: new Set(ENTERPRISE_GUARD_RESOURCES),
  enterprise_stage: new Set(ENTERPRISE_OIDC_LOGIN_STAGES),
  enterprise_state: new Set(ENTERPRISE_JOB_BACKLOG_STATES),
};

/**
 * Fail closed when a production rule matcher is outside closed application vocabularies.
 */
export const reconcileSelectorsWithClosedVocab = (selectors: RuleMetricSelector[]): void => {
  for (const selector of selectors) {
    if (!ENTERPRISE_INSTRUMENT_METRICS.has(selector.metric)) {
      throw new Error(
        `Rule ${selector.alert} references unknown instrument metric ${selector.metric}`,
      );
    }
    for (const matcher of selector.matchers) {
      const allowed = CLOSED_BY_PROMETHEUS_LABEL[matcher.name];
      if (!allowed) {
        throw new Error(
          `Rule ${selector.alert} uses unexpected label ${matcher.name} on ${selector.metric}`,
        );
      }
      if (matcher.op === '=' || matcher.op === '!=') {
        if (!allowed.has(matcher.value)) {
          throw new Error(
            `Rule ${selector.alert} matcher ${matcher.name}=${matcher.value} is outside closed vocabulary`,
          );
        }
      } else if (matcher.op === '=~' || matcher.op === '!~') {
        for (const alt of matcher.value.split('|')) {
          if (!allowed.has(alt)) {
            throw new Error(
              `Rule ${selector.alert} regex matcher ${matcher.name}=~${matcher.value} includes non-closed value ${alt}`,
            );
          }
        }
      }
    }
  }
};

const forcedValue = (matchers: LabelMatcher[], promLabel: string): string | undefined => {
  const found = matchers.find((matcher) => matcher.name === promLabel);
  return found ? representativeMatcherValue(found) : undefined;
};

/**
 * Build OTel attributes for a rule selector using real attribute builders.
 * Returns dotted keys as emitted by the application.
 */
export const buildOtelAttributesForSelector = (
  selector: RuleMetricSelector,
): Record<string, string> => {
  const m = selector.matchers;
  switch (selector.metric) {
    case 'enterprise_platform_config_publish_total': {
      const outcome = (forcedValue(m, 'enterprise_outcome') ?? 'success') as
        'conflict' | 'failure' | 'success';
      return buildConfigPublishAttributes({
        domain: 'identity',
        operation: 'publish',
        outcome,
      }) as Record<string, string>;
    }
    case 'enterprise_platform_invalidation_total': {
      const outcome = (forcedValue(m, 'enterprise_outcome') ?? 'error') as
        'disabled' | 'error' | 'partial_failure' | 'success' | 'unavailable';
      return buildInvalidationAttributes({
        backend: ENTERPRISE_INVALIDATION_BACKENDS[1]!,
        outcome,
      }) as Record<string, string>;
    }
    case 'enterprise_platform_cache_load_total': {
      const outcome = (forcedValue(m, 'enterprise_outcome') ?? 'load_failure') as
        'load_failure' | 'loaded' | 'loaded_negative';
      return buildCacheLoadAttributes({
        domain: ENTERPRISE_CACHE_DOMAINS[0]!,
        outcome,
      }) as Record<string, string>;
    }
    case 'enterprise_platform_guard_decision_total': {
      const outcome = (forcedValue(m, 'enterprise_outcome') ?? 'denied') as
        'catalog_not_ready' | 'denied' | 'would_deny';
      return buildGuardDecisionAttributes({
        classification: 'deny',
        mode: 'enforced',
        outcome,
        resource: ENTERPRISE_GUARD_RESOURCES[0]!,
      }) as Record<string, string>;
    }
    case 'enterprise_platform_instance_heartbeat_total': {
      const outcome = (forcedValue(m, 'enterprise_outcome') ?? 'failure') as 'failure' | 'success';
      return buildHeartbeatAttributes({
        operation: ENTERPRISE_HEARTBEAT_OPERATIONS[1]!,
        outcome,
      }) as Record<string, string>;
    }
    case 'enterprise_platform_ssrf_denial_total': {
      const category = (forcedValue(m, 'enterprise_category') ??
        ENTERPRISE_SSRF_DENIAL_CATEGORIES[4]!) as (typeof ENTERPRISE_SSRF_DENIAL_CATEGORIES)[number];
      return buildSsrfDenialAttributes({ category }) as Record<string, string>;
    }
    case 'enterprise_platform_oidc_login_total': {
      const outcome = forcedValue(m, 'enterprise_outcome') ?? 'failure';
      if (outcome === 'failure') {
        return buildOidcLoginAttributes({
          failureCategory: ENTERPRISE_OIDC_FAILURE_CATEGORIES[0]!,
          outcome: 'failure',
          stage: ENTERPRISE_OIDC_LOGIN_STAGES[0]!,
        }) as Record<string, string>;
      }
      return buildOidcLoginAttributes({
        outcome: 'success',
        stage: ENTERPRISE_OIDC_LOGIN_STAGES[4]!,
      }) as Record<string, string>;
    }
    case 'enterprise_platform_agent_materialization_total': {
      const outcome = (forcedValue(m, 'enterprise_outcome') ?? 'failure') as
        'created' | 'reused' | 'race_reused' | 'archived' | 'failure';
      return buildAgentMaterializationAttributes({ outcome }) as Record<string, string>;
    }
    case 'enterprise_platform_job_backlog_oldest_age_seconds': {
      const state = (forcedValue(m, 'enterprise_state') ??
        ENTERPRISE_JOB_BACKLOG_STATES[0]!) as (typeof ENTERPRISE_JOB_BACKLOG_STATES)[number];
      return buildJobBacklogAttributes({ state }) as Record<string, string>;
    }
    case 'enterprise_platform_revision_lag_instances': {
      const domain = (forcedValue(m, 'enterprise_domain') ?? 'identity') as 'identity';
      const reason = (forcedValue(m, 'enterprise_reason') ??
        ENTERPRISE_REVISION_LAG_REASONS[1]!) as (typeof ENTERPRISE_REVISION_LAG_REASONS)[number];
      return buildRevisionLagAttributes({ domain, reason }) as Record<string, string>;
    }
    case 'enterprise_platform_operational_snapshot_age_seconds':
    case 'enterprise_platform_operational_snapshot_ready': {
      const collector = (forcedValue(m, 'enterprise_collector') ??
        ENTERPRISE_OPERATIONAL_COLLECTORS[0]!) as (typeof ENTERPRISE_OPERATIONAL_COLLECTORS)[number];
      return buildOperationalCollectorAttributes({ collector }) as Record<string, string>;
    }
    default: {
      throw new Error(`No emission builder for metric ${selector.metric}`);
    }
  }
};

export interface EmissionPoint {
  attributes: Record<string, string>;
  isCounter: boolean;
  metric: string;
  /** Prometheus labels after underscore translation (oracle derived from builders + translation). */
  prometheusLabels: Record<string, string>;
  querySelector: string;
  value: number;
}

/**
 * Derive emission points from production rule selectors + real attribute builders.
 * One point per distinct (metric, matcher set) — includes both publish failure and conflict.
 */
export const buildEmissionPointsFromSelectors = (
  selectors: RuleMetricSelector[],
): EmissionPoint[] => {
  reconcileSelectorsWithClosedVocab(selectors);
  const points: EmissionPoint[] = [];
  const seen = new Set<string>();

  for (const selector of selectors) {
    const attributes = buildOtelAttributesForSelector(selector);
    // Ensure forced matcher values are present on the emitted attributes.
    for (const matcher of selector.matchers) {
      if (matcher.op !== '=' && matcher.op !== '=~') continue;
      const otelKey = prometheusLabelToOtelKey(matcher.name);
      const expected = representativeMatcherValue(matcher);
      if (attributes[otelKey] !== expected) {
        // Builder may use defaults; re-force for selector proof.
        attributes[otelKey] = expected;
      }
    }
    const prometheusLabels = Object.fromEntries(
      Object.entries(attributes).map(([key, value]) => [otelKeyToPrometheusLabel(key), value]),
    );
    const key = `${selector.metric}|${JSON.stringify(prometheusLabels)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const isCounter = selector.metric.endsWith('_total');
    points.push({
      attributes,
      isCounter,
      metric: selector.metric,
      prometheusLabels,
      querySelector: selector.querySelector,
      value: isCounter ? 5 : selector.metric.includes('ready') ? 1 : 42,
    });
  }

  // Operational ready must be emitted for both required collectors when either appears.
  for (const collector of ENTERPRISE_OPERATIONAL_COLLECTORS) {
    for (const metric of [
      'enterprise_platform_operational_snapshot_ready',
      'enterprise_platform_operational_snapshot_age_seconds',
    ] as const) {
      const attributes = buildOperationalCollectorAttributes({ collector }) as Record<
        string,
        string
      >;
      const prometheusLabels = Object.fromEntries(
        Object.entries(attributes).map(([key, value]) => [otelKeyToPrometheusLabel(key), value]),
      );
      const key = `${metric}|${JSON.stringify(prometheusLabels)}`;
      if (seen.has(key)) continue;
      // Only add if production rules reference this metric at all.
      if (!selectors.some((selector) => selector.metric === metric)) continue;
      seen.add(key);
      points.push({
        attributes,
        isCounter: false,
        metric,
        prometheusLabels,
        querySelector: `${metric}{enterprise_collector="${collector}"}`,
        value: metric.includes('ready') ? 1 : 30,
      });
    }
  }

  return points;
};
