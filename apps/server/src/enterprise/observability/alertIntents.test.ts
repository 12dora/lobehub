// @vitest-environment node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  extractMetricNamesFromExpr,
  parsePrometheusAlertRulesFile,
} from '../../../../../scripts/enterprise/prometheus-alerts/parseRules';
import {
  ENTERPRISE_ALERT_INTENTS,
  ENTERPRISE_ALERT_REFERENCE_RULES_RELATIVE_PATH,
} from './alertIntents';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../',
);
const rulesPath = path.join(repositoryRoot, ENTERPRISE_ALERT_REFERENCE_RULES_RELATIVE_PATH);

describe('enterprise alert intents', () => {
  it('defines the exact operational intent keys in stable order', () => {
    expect(ENTERPRISE_ALERT_INTENTS.map(({ key }) => key)).toEqual([
      'publish_failure_ratio',
      'publish_conflict_ratio',
      'invalidation_degraded',
      'cache_failure_rate',
      'guard_denial_spike',
      'heartbeat_failure',
      'ssrf_denial_spike',
      'oidc_login_failure_ratio',
      'materialization_failure_rate',
      'job_backlog_stalled',
      'revision_lag',
      'operational_collection_stale',
    ]);
  });

  it('maps each intent to its enterprise OTel metric and reference-rule status', () => {
    expect(ENTERPRISE_ALERT_INTENTS.map(({ metric }) => metric)).toEqual([
      'enterprise_platform_config_publish_total',
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
    ]);
    expect(ENTERPRISE_ALERT_INTENTS.every(({ status }) => status === 'reference-rule')).toBe(true);
    expect(
      ENTERPRISE_ALERT_INTENTS.every(
        ({ ruleName }) => typeof ruleName === 'string' && /^Enterprise[A-Za-z]+$/.test(ruleName),
      ),
    ).toBe(true);
  });

  it('reconciles exact 1:1 intent keys, rule names, and metric identities with the YAML', () => {
    const rules = parsePrometheusAlertRulesFile(rulesPath);
    const ruleNames = rules.map((rule) => rule.alert);
    const intentRuleNames = ENTERPRISE_ALERT_INTENTS.map(({ ruleName }) => ruleName);

    expect(ruleNames).toEqual(intentRuleNames);
    expect(new Set(ruleNames).size).toBe(ENTERPRISE_ALERT_INTENTS.length);

    for (const intent of ENTERPRISE_ALERT_INTENTS) {
      const rule = rules.find((entry) => entry.alert === intent.ruleName);
      expect(rule, `missing rule for ${intent.key}`).toBeDefined();
      const metrics = extractMetricNamesFromExpr(rule!.expr);
      expect(metrics).toContain(intent.metric);
      expect(rule!.labels.severity).toMatch(/^(critical|warning|info)$/);
      expect(rule!.labels.component?.length).toBeGreaterThan(0);
      expect(rule!.annotations.summary?.length).toBeGreaterThan(0);
      expect(rule!.annotations.runbook).toMatch(
        /^docs\/enterprise\/runbooks\/enterprise-prometheus-alerts\.md#/,
      );
      // No secrets or absolute internal URLs in annotations.
      const annotationBlob = Object.values(rule!.annotations).join('\n');
      expect(annotationBlob).not.toMatch(/https?:\/\/(localhost|127\.|10\.|192\.168\.)/i);
      expect(annotationBlob).not.toMatch(/(password|secret|token|apikey)=/i);
    }
  });

  it('requires cluster gauges to aggregate with max (never bare sum across replicas)', () => {
    const rules = parsePrometheusAlertRulesFile(rulesPath);
    const jobBacklog = rules.find((rule) => rule.alert === 'EnterpriseJobBacklogStalled');
    const revisionLag = rules.find((rule) => rule.alert === 'EnterpriseRevisionLag');
    const operational = rules.find((rule) => rule.alert === 'EnterpriseOperationalCollectionStale');

    expect(jobBacklog?.expr).toMatch(/\bmax\s*\(/);
    expect(jobBacklog?.expr).not.toMatch(/sum\s*\(\s*enterprise_platform_job_backlog_oldest/);
    expect(revisionLag?.expr).toMatch(/\bmax\s+by\s*\(/);
    expect(operational?.expr).toMatch(/\bmax\s+by\s*\(\s*enterprise_collector\s*\)/);
  });

  it('EnterpriseOperationalCollectionStale preserves collector identity and absence', () => {
    const rules = parsePrometheusAlertRulesFile(rulesPath);
    const operational = rules.find((rule) => rule.alert === 'EnterpriseOperationalCollectionStale');
    expect(operational).toBeDefined();
    expect(operational!.expr).toContain('enterprise_platform_operational_snapshot_age_seconds');
    expect(operational!.expr).toContain('enterprise_platform_operational_snapshot_ready');
    expect(operational!.expr).toContain('enterprise_collector="job_backlog"');
    expect(operational!.expr).toContain('enterprise_collector="revision_lag"');
    expect(operational!.expr).toMatch(/absent\s*\(/);
    expect(operational!.expr).toMatch(/max\s+by\s*\(\s*enterprise_collector\s*\)/);
    // Must not collapse collectors with bare max(ready)==0.
    expect(operational!.expr).not.toMatch(
      /max\s*\(\s*enterprise_platform_operational_snapshot_ready\s*\)\s*==\s*0/,
    );
    expect(operational!.expr).not.toContain('enterprise.');
  });

  it('guards ratio alerts against zero-traffic denominators', () => {
    const rules = parsePrometheusAlertRulesFile(rulesPath);
    const ratioRules = [
      'EnterpriseConfigPublishFailureRatio',
      'EnterpriseConfigPublishConflictRatio',
      'EnterpriseCacheFailureRate',
      'EnterpriseOidcLoginFailureRatio',
      'EnterpriseAgentMaterializationFailureRate',
    ];
    for (const name of ratioRules) {
      const rule = rules.find((entry) => entry.alert === name);
      expect(rule, name).toBeDefined();
      expect(rule!.expr).toMatch(/>\s*0\b/);
      expect(rule!.expr.toLowerCase()).toContain('and');
    }
  });
});
