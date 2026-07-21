/**
 * Independent emission contract for the OTLP probe.
 *
 * - Parses production rule selectors as the expected matchers (oracle source 1).
 * - Invokes real per-metric attribute builders with representative inputs (oracle source 2).
 * - NEVER mutates builder output after the call. If the unaltered builder output does not
 *   satisfy a production matcher, fail closed (rule/builder drift).
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
  ENTERPRISE_CONFIG_PUBLISH_OUTCOMES,
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
  ENTERPRISE_REVISION_LAG_REASONS,
  ENTERPRISE_SSRF_DENIAL_CATEGORIES,
} from '@lobechat/observability-otel/modules/enterprise-platform';

import type { LabelMatcher, RuleMetricSelector } from './parseSelectors';
import { representativeMatcherValue } from './parseSelectors';

/** Prometheus labels each instrument may emit (from its real builder only). */
export const METRIC_ALLOWED_PROMETHEUS_LABELS: Readonly<Record<string, readonly string[]>> = {
  enterprise_platform_agent_materialization_total: ['enterprise_outcome'],
  enterprise_platform_cache_load_total: ['enterprise_domain', 'enterprise_outcome'],
  enterprise_platform_config_publish_total: [
    'enterprise_domain',
    'enterprise_operation',
    'enterprise_outcome',
  ],
  enterprise_platform_guard_decision_total: [
    'enterprise_classification',
    'enterprise_mode',
    'enterprise_outcome',
    'enterprise_resource',
  ],
  enterprise_platform_instance_heartbeat_total: ['enterprise_operation', 'enterprise_outcome'],
  enterprise_platform_invalidation_total: ['enterprise_backend', 'enterprise_outcome'],
  enterprise_platform_job_backlog_oldest_age_seconds: ['enterprise_scope', 'enterprise_state'],
  enterprise_platform_oidc_login_total: [
    'enterprise_failure_category',
    'enterprise_outcome',
    'enterprise_stage',
  ],
  enterprise_platform_operational_collector_enabled: ['enterprise_collector', 'enterprise_scope'],
  enterprise_platform_operational_snapshot_age_seconds: [
    'enterprise_collector',
    'enterprise_scope',
  ],
  enterprise_platform_operational_snapshot_ready: ['enterprise_collector', 'enterprise_scope'],
  enterprise_platform_revision_lag_instances: [
    'enterprise_domain',
    'enterprise_reason',
    'enterprise_scope',
  ],
  enterprise_platform_ssrf_denial_total: ['enterprise_category'],
};

/** Closed values allowed per metric for enterprise_outcome (metric-local, not global). */
const OUTCOME_BY_METRIC: Partial<Record<string, ReadonlySet<string>>> = {
  enterprise_platform_agent_materialization_total: new Set(
    ENTERPRISE_AGENT_MATERIALIZATION_OUTCOMES,
  ),
  enterprise_platform_cache_load_total: new Set(ENTERPRISE_CACHE_LOAD_OUTCOMES),
  enterprise_platform_config_publish_total: new Set(ENTERPRISE_CONFIG_PUBLISH_OUTCOMES),
  enterprise_platform_guard_decision_total: new Set(ENTERPRISE_GUARD_OUTCOMES),
  enterprise_platform_instance_heartbeat_total: new Set(ENTERPRISE_HEARTBEAT_OUTCOMES),
  enterprise_platform_invalidation_total: new Set(ENTERPRISE_INVALIDATION_OUTCOMES),
  enterprise_platform_oidc_login_total: new Set(ENTERPRISE_OIDC_LOGIN_OUTCOMES),
};

export const prometheusLabelToOtelKey = (label: string): string =>
  label.startsWith('enterprise_') ? `enterprise.${label.slice('enterprise_'.length)}` : label;

export const otelKeyToPrometheusLabel = (key: string): string => key.replaceAll('.', '_');

const asStringRecord = (attributes: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(attributes).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );

/**
 * Fail closed when a production rule matcher is not a real dimension of that metric
 * or uses a value outside the metric's own closed vocabulary.
 */
export const reconcileSelectorsWithMetricDimensions = (selectors: RuleMetricSelector[]): void => {
  for (const selector of selectors) {
    const allowed = METRIC_ALLOWED_PROMETHEUS_LABELS[selector.metric];
    if (!allowed) {
      throw new Error(
        `Rule ${selector.alert} references unknown instrument metric ${selector.metric}`,
      );
    }
    for (const matcher of selector.matchers) {
      if (!allowed.includes(matcher.name)) {
        throw new Error(
          `Rule ${selector.alert} matcher ${matcher.name} is not a dimension of ${selector.metric}`,
        );
      }
      if (matcher.name === 'enterprise_outcome') {
        const outcomes = OUTCOME_BY_METRIC[selector.metric];
        if (outcomes) {
          const values =
            matcher.op === '=~' || matcher.op === '!~' ? matcher.value.split('|') : [matcher.value];
          for (const value of values) {
            if (!outcomes.has(value)) {
              throw new Error(
                `Rule ${selector.alert} outcome ${value} is invalid for ${selector.metric}`,
              );
            }
          }
        }
      }
      if (matcher.name === 'enterprise_collector') {
        const values =
          matcher.op === '=~' ? matcher.value.split('|') : [representativeMatcherValue(matcher)];
        for (const value of values) {
          if (!(ENTERPRISE_OPERATIONAL_COLLECTORS as readonly string[]).includes(value)) {
            throw new Error(
              `Rule ${selector.alert} collector ${value} is outside closed collector vocabulary`,
            );
          }
        }
      }
    }
  }
};

/** @deprecated use reconcileSelectorsWithMetricDimensions */
export const reconcileSelectorsWithClosedVocab = reconcileSelectorsWithMetricDimensions;

/**
 * Build unaltered OTel attributes for a rule selector via the real metric builder.
 * Chooses a representative input so the builder output satisfies equality matchers.
 * Does not mutate attributes after the builder returns.
 */
export const buildUnalteredAttributesForSelector = (
  selector: RuleMetricSelector,
): Record<string, string> => {
  const forced = (name: string): string | undefined => {
    const matcher = selector.matchers.find((entry) => entry.name === name);
    return matcher ? representativeMatcherValue(matcher) : undefined;
  };

  switch (selector.metric) {
    case 'enterprise_platform_config_publish_total': {
      const outcome = (forced('enterprise_outcome') ?? 'success') as
        'conflict' | 'failure' | 'success';
      return asStringRecord(
        buildConfigPublishAttributes({
          domain: 'identity',
          operation: 'publish',
          outcome,
        }) as Record<string, unknown>,
      );
    }
    case 'enterprise_platform_invalidation_total': {
      const outcome = (forced('enterprise_outcome') ?? 'error') as
        'disabled' | 'error' | 'partial_failure' | 'success' | 'unavailable';
      return asStringRecord(
        buildInvalidationAttributes({
          backend: ENTERPRISE_INVALIDATION_BACKENDS[1]!,
          outcome,
        }) as Record<string, unknown>,
      );
    }
    case 'enterprise_platform_cache_load_total': {
      const outcome = (forced('enterprise_outcome') ?? 'load_failure') as
        'load_failure' | 'loaded' | 'loaded_negative';
      return asStringRecord(
        buildCacheLoadAttributes({
          domain: ENTERPRISE_CACHE_DOMAINS[0]!,
          outcome,
        }) as Record<string, unknown>,
      );
    }
    case 'enterprise_platform_guard_decision_total': {
      const outcome = (forced('enterprise_outcome') ?? 'denied') as
        'catalog_not_ready' | 'denied' | 'would_deny';
      return asStringRecord(
        buildGuardDecisionAttributes({
          classification: 'deny',
          mode: 'enforced',
          outcome,
          resource: ENTERPRISE_GUARD_RESOURCES[0]!,
        }) as Record<string, unknown>,
      );
    }
    case 'enterprise_platform_instance_heartbeat_total': {
      const outcome = (forced('enterprise_outcome') ?? 'failure') as 'failure' | 'success';
      return asStringRecord(
        buildHeartbeatAttributes({
          operation: ENTERPRISE_HEARTBEAT_OPERATIONS[1]!,
          outcome,
        }) as Record<string, unknown>,
      );
    }
    case 'enterprise_platform_ssrf_denial_total': {
      const category = (forced('enterprise_category') ??
        ENTERPRISE_SSRF_DENIAL_CATEGORIES[4]!) as (typeof ENTERPRISE_SSRF_DENIAL_CATEGORIES)[number];
      return asStringRecord(buildSsrfDenialAttributes({ category }) as Record<string, unknown>);
    }
    case 'enterprise_platform_oidc_login_total': {
      const outcome = forced('enterprise_outcome') ?? 'failure';
      if (outcome === 'failure') {
        return asStringRecord(
          buildOidcLoginAttributes({
            failureCategory: ENTERPRISE_OIDC_FAILURE_CATEGORIES[0]!,
            outcome: 'failure',
            stage: ENTERPRISE_OIDC_LOGIN_STAGES[0]!,
          }) as Record<string, unknown>,
        );
      }
      return asStringRecord(
        buildOidcLoginAttributes({
          outcome: 'success',
          stage: ENTERPRISE_OIDC_LOGIN_STAGES[4]!,
        }) as Record<string, unknown>,
      );
    }
    case 'enterprise_platform_agent_materialization_total': {
      const outcome = (forced('enterprise_outcome') ?? 'failure') as
        'created' | 'reused' | 'race_reused' | 'archived' | 'failure';
      return asStringRecord(
        buildAgentMaterializationAttributes({ outcome }) as Record<string, unknown>,
      );
    }
    case 'enterprise_platform_job_backlog_oldest_age_seconds': {
      const state = (forced('enterprise_state') ??
        ENTERPRISE_JOB_BACKLOG_STATES[0]!) as (typeof ENTERPRISE_JOB_BACKLOG_STATES)[number];
      return asStringRecord(buildJobBacklogAttributes({ state }) as Record<string, unknown>);
    }
    case 'enterprise_platform_revision_lag_instances': {
      const reason = (forced('enterprise_reason') ??
        ENTERPRISE_REVISION_LAG_REASONS[1]!) as (typeof ENTERPRISE_REVISION_LAG_REASONS)[number];
      return asStringRecord(
        buildRevisionLagAttributes({ domain: 'identity', reason }) as Record<string, unknown>,
      );
    }
    case 'enterprise_platform_operational_snapshot_age_seconds':
    case 'enterprise_platform_operational_snapshot_ready':
    case 'enterprise_platform_operational_collector_enabled': {
      const collector = (forced('enterprise_collector') ??
        ENTERPRISE_OPERATIONAL_COLLECTORS[0]!) as (typeof ENTERPRISE_OPERATIONAL_COLLECTORS)[number];
      return asStringRecord(
        buildOperationalCollectorAttributes({ collector }) as Record<string, unknown>,
      );
    }
    default: {
      throw new Error(`No emission builder for metric ${selector.metric}`);
    }
  }
};

const assertBuilderSatisfiesMatchers = (
  selector: RuleMetricSelector,
  attributes: Record<string, string>,
): void => {
  const prometheusLabels = Object.fromEntries(
    Object.entries(attributes).map(([key, value]) => [otelKeyToPrometheusLabel(key), value]),
  );
  for (const matcher of selector.matchers) {
    const actual = prometheusLabels[matcher.name];
    if (actual === undefined) {
      throw new Error(
        `Unaltered builder output for ${selector.metric} missing label ${matcher.name} required by ${selector.alert}`,
      );
    }
    if (matcher.op === '=') {
      if (actual !== matcher.value) {
        throw new Error(
          `Unaltered builder output for ${selector.metric} has ${matcher.name}=${actual}, rule requires ${matcher.value}`,
        );
      }
    } else if (matcher.op === '=~' && !new RegExp(`^(?:${matcher.value})$`).test(actual)) {
      throw new Error(
        `Unaltered builder output for ${selector.metric} has ${matcher.name}=${actual}, rule requires =~${matcher.value}`,
      );
    }
  }
};

export interface EmissionPoint {
  attributes: Record<string, string>;
  isCounter: boolean;
  metric: string;
  prometheusLabels: Record<string, string>;
  querySelector: string;
  value: number;
}

/**
 * Derive emission points from production selectors using unaltered builder output only.
 */
export const buildEmissionPointsFromSelectors = (
  selectors: RuleMetricSelector[],
): EmissionPoint[] => {
  reconcileSelectorsWithMetricDimensions(selectors);
  const points: EmissionPoint[] = [];
  const seen = new Set<string>();

  for (const selector of selectors) {
    const attributes = buildUnalteredAttributesForSelector(selector);
    assertBuilderSatisfiesMatchers(selector, attributes);
    const prometheusLabels = Object.fromEntries(
      Object.entries(attributes).map(([key, value]) => [otelKeyToPrometheusLabel(key), value]),
    );
    const key = `${selector.metric}|${JSON.stringify(prometheusLabels)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const isCounter = selector.metric.endsWith('_total');
    const isEnabledGauge = selector.metric === 'enterprise_platform_operational_collector_enabled';
    points.push({
      attributes,
      isCounter,
      metric: selector.metric,
      prometheusLabels,
      querySelector: selector.querySelector,
      value: isCounter ? 5 : isEnabledGauge ? 1 : selector.metric.includes('ready') ? 1 : 42,
    });
  }

  // Emit enabled for every known collector + healthy ready/age when operational rules exist.
  // Probe uses enabled=1 for both so translation of all rule selectors is provable; disabled
  // semantics are covered by promtool fixtures, not by omitting series here.
  const hasOperationalRules = selectors.some(
    (selector) =>
      selector.alert === 'EnterpriseOperationalCollectionStale' ||
      selector.metric.includes('operational'),
  );
  if (hasOperationalRules) {
    for (const collector of ENTERPRISE_OPERATIONAL_COLLECTORS) {
      const attributes = asStringRecord(
        buildOperationalCollectorAttributes({ collector }) as Record<string, unknown>,
      );
      const prometheusLabels = Object.fromEntries(
        Object.entries(attributes).map(([key, value]) => [otelKeyToPrometheusLabel(key), value]),
      );
      const operationalSeries: Array<{ metric: string; value: number }> = [
        { metric: 'enterprise_platform_operational_collector_enabled', value: 1 },
        { metric: 'enterprise_platform_operational_snapshot_ready', value: 1 },
        { metric: 'enterprise_platform_operational_snapshot_age_seconds', value: 30 },
      ];
      for (const series of operationalSeries) {
        const key = `${series.metric}|${JSON.stringify(prometheusLabels)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        points.push({
          attributes,
          isCounter: false,
          metric: series.metric,
          prometheusLabels,
          querySelector: `${series.metric}{enterprise_collector="${collector}"}`,
          value: series.value,
        });
      }
    }
  }

  return points;
};

/** Fail closed when a known-valid label is attached to the wrong metric. */
export const assertWrongMetricMatcherRejected = (
  metric: string,
  foreignMatcher: LabelMatcher,
): void => {
  try {
    reconcileSelectorsWithMetricDimensions([
      {
        alert: 'MutationProbe',
        matchers: [foreignMatcher],
        metric,
        querySelector: `${metric}{${foreignMatcher.name}="${foreignMatcher.value}"}`,
      },
    ]);
  } catch {
    return;
  }
  throw new Error(
    `Expected wrong-metric matcher ${foreignMatcher.name} on ${metric} to be rejected`,
  );
};
