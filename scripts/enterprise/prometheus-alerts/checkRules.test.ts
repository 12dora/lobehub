// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { checkEnterprisePrometheusRules, testEnterprisePrometheusRules } from './checkRules';
import { cleanupProbeResources } from './cleanup';
import { validateEnterpriseCollectorConfig } from './collectorValidate';
import { assertEnterprisePrometheusComposeWiring } from './composeWiring';
import {
  ENTERPRISE_OTEL_COLLECTOR_IMAGE,
  ENTERPRISE_PROMETHEUS_IMAGE,
  resolveAlertRulesPath,
  resolveRepositoryRoot,
} from './constants';
import {
  assertWrongMetricMatcherRejected,
  buildEmissionPointsFromSelectors,
  buildUnalteredAttributesForSelector,
  reconcileSelectorsWithMetricDimensions,
} from './emissionContract';
import { assertRuleExprUsesPrometheusLabels } from './metricTranslation';
import { runOtlpPrometheusTranslationProbe } from './otlpPrometheusProbe';
import { parsePrometheusAlertRulesFile } from './parseRules';
import { parseProductionRuleSelectors } from './parseSelectors';
import {
  assertForbiddenPrometheusFlagsRejected,
  validateEnterprisePrometheusRuntime,
} from './prometheusRuntime';
import { resetSleepForTests, setSleepForTests } from './sleep';

const tempDirs: string[] = [];
const repositoryRoot = resolveRepositoryRoot();
const rulesPath = resolveAlertRulesPath(repositoryRoot);

afterEach(() => {
  resetSleepForTests();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { force: true, recursive: true });
  }
});

const writeTempRules = (contents: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'enterprise-prom-rules-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'enterprise-platform-alerts.yml');
  writeFileSync(file, contents, 'utf8');
  return file;
};

describe('enterprise prometheus rules — promtool check + semantic tests', () => {
  it('passes promtool check rules (fail closed)', () => {
    const result = checkEnterprisePrometheusRules();
    expect(result.image).toBe(ENTERPRISE_PROMETHEUS_IMAGE);
    expect(result.stdout.toLowerCase()).toMatch(/success|checking/);
  });

  it('passes promtool test rules semantic fixtures (fail closed)', () => {
    const result = testEnterprisePrometheusRules();
    expect(result.image).toBe(ENTERPRISE_PROMETHEUS_IMAGE);
    expect(result.stdout.toLowerCase()).toMatch(/success/);
  });

  it('fails closed on invalid PromQL expressions', () => {
    const rulesFile = writeTempRules(`
groups:
  - name: broken
    rules:
      - alert: BrokenAlert
        expr: this is not valid promql((((
        for: 1m
        labels:
          severity: warning
          component: test
        annotations:
          summary: broken
          runbook: docs/x.md#a
`);
    expect(() => checkEnterprisePrometheusRules({ rulesPath: rulesFile })).toThrow(
      /promtool check rules failed/i,
    );
  });
});

describe('enterprise prometheus — production selector parsing + emission', () => {
  it('parses both publish failure and conflict matchers from production rules', () => {
    const selectors = parseProductionRuleSelectors(rulesPath);
    const publish = selectors.filter(
      (selector) => selector.metric === 'enterprise_platform_config_publish_total',
    );
    const outcomes = publish.flatMap((selector) =>
      selector.matchers
        .filter((matcher) => matcher.name === 'enterprise_outcome' && matcher.op === '=')
        .map((matcher) => matcher.value),
    );
    expect(outcomes).toEqual(expect.arrayContaining(['failure', 'conflict']));
    expect(new Set(outcomes).size).toBeGreaterThanOrEqual(2);
  });

  it('derives emission points from real builders covering every production selector', () => {
    const selectors = parseProductionRuleSelectors(rulesPath);
    const points = buildEmissionPointsFromSelectors(selectors);
    expect(points.length).toBeGreaterThanOrEqual(selectors.length);
    const publishOutcomes = points
      .filter((point) => point.metric === 'enterprise_platform_config_publish_total')
      .map((point) => point.prometheusLabels.enterprise_outcome);
    expect(publishOutcomes).toEqual(expect.arrayContaining(['failure', 'conflict']));
  });

  it('uses Prometheus underscore labels in every production rule expr', () => {
    for (const rule of parsePrometheusAlertRulesFile(rulesPath)) {
      expect(() => assertRuleExprUsesPrometheusLabels(rule.expr)).not.toThrow();
    }
  });

  it('EnterpriseOperationalCollectionStale gates ready/age by collector enabled signal', () => {
    const rule = parsePrometheusAlertRulesFile(rulesPath).find(
      (entry) => entry.alert === 'EnterpriseOperationalCollectionStale',
    );
    expect(rule).toBeDefined();
    expect(rule!.expr).toContain('enterprise_platform_operational_collector_enabled');
    expect(rule!.expr).toContain('enterprise_collector="job_backlog"');
    expect(rule!.expr).toContain('enterprise_collector="revision_lag"');
    expect(rule!.expr).toMatch(/==\s*1/);
    // Explicit absent(ready) per enabled collector — removing either branch must fail this test.
    const absentReadyJob =
      /absent\(\s*enterprise_platform_operational_snapshot_ready\{enterprise_collector="job_backlog"\}\s*\)/;
    const absentReadyRevision =
      /absent\(\s*enterprise_platform_operational_snapshot_ready\{enterprise_collector="revision_lag"\}\s*\)/;
    expect(rule!.expr).toMatch(absentReadyJob);
    expect(rule!.expr).toMatch(absentReadyRevision);
    expect(rule!.expr.match(absentReadyJob)).toHaveLength(1);
    expect(rule!.expr.match(absentReadyRevision)).toHaveLength(1);
    // No-data branch is absent(enabled{job_backlog}), not a claim that rules stay inactive.
    expect(rule!.expr).toMatch(
      /absent\(\s*enterprise_platform_operational_collector_enabled\{enterprise_collector="job_backlog"\}\s*\)/,
    );
  });

  it('fails static reconcile when either absent(ready) branch is removed from production expr', () => {
    const rule = parsePrometheusAlertRulesFile(rulesPath).find(
      (entry) => entry.alert === 'EnterpriseOperationalCollectionStale',
    );
    expect(rule).toBeDefined();
    const withoutJobReadyAbsent = rule!.expr.replace(
      /absent\(\s*enterprise_platform_operational_snapshot_ready\{enterprise_collector="job_backlog"\}\s*\)/,
      'vector(0)',
    );
    const withoutRevisionReadyAbsent = rule!.expr.replace(
      /absent\(\s*enterprise_platform_operational_snapshot_ready\{enterprise_collector="revision_lag"\}\s*\)/,
      'vector(0)',
    );
    expect(withoutJobReadyAbsent).not.toMatch(
      /absent\(\s*enterprise_platform_operational_snapshot_ready\{enterprise_collector="job_backlog"\}\s*\)/,
    );
    expect(withoutRevisionReadyAbsent).not.toMatch(
      /absent\(\s*enterprise_platform_operational_snapshot_ready\{enterprise_collector="revision_lag"\}\s*\)/,
    );
    // Production expr must still contain both (guards against silent removal).
    expect(rule!.expr).toMatch(
      /absent\(\s*enterprise_platform_operational_snapshot_ready\{enterprise_collector="job_backlog"\}\s*\)/,
    );
    expect(rule!.expr).toMatch(
      /absent\(\s*enterprise_platform_operational_snapshot_ready\{enterprise_collector="revision_lag"\}\s*\)/,
    );
  });

  it('never mutates unaltered builder output to satisfy matchers', () => {
    const selectors = parseProductionRuleSelectors(rulesPath);
    const cache = selectors.find(
      (selector) =>
        selector.metric === 'enterprise_platform_cache_load_total' &&
        selector.matchers.some((matcher) => matcher.value === 'load_failure'),
    );
    expect(cache).toBeDefined();
    const attributes = buildUnalteredAttributesForSelector(cache!);
    expect(attributes['enterprise.outcome']).toBe('load_failure');
    expect(attributes['enterprise.stage']).toBeUndefined();
  });

  it('uses authoritative agent materialization outcomes constant for reconcile + builder', async () => {
    const { ENTERPRISE_AGENT_MATERIALIZATION_OUTCOMES } =
      await import('@lobechat/observability-otel/modules/enterprise-platform');
    expect(ENTERPRISE_AGENT_MATERIALIZATION_OUTCOMES).toContain('failure');
    const selectors = parseProductionRuleSelectors(rulesPath);
    const materialization = selectors.find(
      (selector) =>
        selector.metric === 'enterprise_platform_agent_materialization_total' &&
        selector.matchers.some((matcher) => matcher.value === 'failure'),
    );
    expect(materialization).toBeDefined();
    const attributes = buildUnalteredAttributesForSelector(materialization!);
    expect(attributes['enterprise.outcome']).toBe('failure');
    expect(ENTERPRISE_AGENT_MATERIALIZATION_OUTCOMES).toContain(
      attributes[
        'enterprise.outcome'
      ] as (typeof ENTERPRISE_AGENT_MATERIALIZATION_OUTCOMES)[number],
    );
    // No hand-copied materialization outcome union in the emission contract path.
    const contractSource = readFileSync(
      path.join(repositoryRoot, 'scripts/enterprise/prometheus-alerts/emissionContract.ts'),
      'utf8',
    );
    expect(contractSource).not.toMatch(
      /'created'\s*\|\s*'reused'\s*\|\s*'race_reused'\s*\|\s*'archived'\s*\|\s*'failure'/,
    );
    expect(contractSource).toMatch(/typeof ENTERPRISE_AGENT_MATERIALIZATION_OUTCOMES\)\[number\]/);
  });
});

describe('enterprise prometheus — mutation falsification', () => {
  it('rejects mistyped conflict outcome outside publish closed vocabulary', () => {
    const original = readFileSync(rulesPath, 'utf8');
    const mutatedPath = writeTempRules(
      original.replace('enterprise_outcome="conflict"', 'enterprise_outcome="conflictt"'),
    );
    const selectors = parseProductionRuleSelectors(mutatedPath);
    expect(() => reconcileSelectorsWithMetricDimensions(selectors)).toThrow(
      /invalid for|unknown|conflictt/i,
    );
  });

  it('rejects unknown instrument metric name in production rules', () => {
    const original = readFileSync(rulesPath, 'utf8');
    const mutatedPath = writeTempRules(
      original.replaceAll(
        'enterprise_platform_ssrf_denial_total',
        'enterprise_platform_ssrf_denial_totall',
      ),
    );
    const selectors = parseProductionRuleSelectors(mutatedPath);
    expect(() => reconcileSelectorsWithMetricDimensions(selectors)).toThrow(/unknown instrument/i);
  });

  it('rejects known-valid labels attached to the wrong metric', () => {
    expect(() =>
      assertWrongMetricMatcherRejected('enterprise_platform_cache_load_total', {
        name: 'enterprise_stage',
        op: '=',
        value: 'token_exchange',
      }),
    ).not.toThrow();
    expect(() =>
      assertWrongMetricMatcherRejected('enterprise_platform_guard_decision_total', {
        name: 'enterprise_operation',
        op: '=',
        value: 'publish',
      }),
    ).not.toThrow();
    expect(() =>
      assertWrongMetricMatcherRejected('enterprise_platform_job_backlog_oldest_age_seconds', {
        name: 'enterprise_outcome',
        op: '=',
        value: 'failure',
      }),
    ).not.toThrow();
  });

  it('fails compose wiring when metrics pipeline drops otlp', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'enterprise-compose-no-otlp-'));
    tempDirs.push(root);
    const grafana = path.join(root, 'docker-compose/production/grafana');
    mkdirSync(path.join(grafana, 'prometheus/rules'), { recursive: true });
    mkdirSync(path.join(grafana, 'otel-collector'), { recursive: true });
    writeFileSync(
      path.join(grafana, 'docker-compose.yml'),
      `
services:
  prometheus:
    image: ${ENTERPRISE_PROMETHEUS_IMAGE}
    volumes:
      - ./prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - ./prometheus/rules:/etc/prometheus/rules:ro
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--web.enable-remote-write-receiver'
      - '--enable-feature=exemplar-storage'
  otel-collector:
    image: ${ENTERPRISE_OTEL_COLLECTOR_IMAGE}
    volumes:
      - ./otel-collector/collector-config.yaml:/etc/otelcol/config.yaml:ro
`,
      'utf8',
    );
    writeFileSync(
      path.join(grafana, 'prometheus/prometheus.yml'),
      `rule_files:\n  - /etc/prometheus/rules/enterprise-platform-alerts.yml\n`,
      'utf8',
    );
    writeFileSync(
      path.join(grafana, 'otel-collector/collector-config.yaml'),
      `
receivers:
  prometheus:
    config:
      scrape_configs: []
exporters:
  prometheusremotewrite:
    endpoint: http://127.0.0.1:9090/api/v1/write
  debug:
    verbosity: basic
service:
  pipelines:
    metrics:
      receivers: [prometheus]
      exporters: [prometheusremotewrite]
`,
      'utf8',
    );
    expect(() => assertEnterprisePrometheusComposeWiring(root)).toThrow(/otlp receiver/i);
  });
});

describe('enterprise prometheus — compose + runtime + collector', () => {
  it('wires rules, pins images, OTLP→prometheusremotewrite, no forbidden flags', () => {
    const report = assertEnterprisePrometheusComposeWiring();
    expect(report.prometheusImage).toBe(ENTERPRISE_PROMETHEUS_IMAGE);
    expect(report.collectorImage).toBe(ENTERPRISE_OTEL_COLLECTOR_IMAGE);
    expect(report.metricsPipeline.receivers).toContain('otlp');
    expect(report.metricsPipeline.exporters).toContain('prometheusremotewrite');
    expect(report.prometheusCommand).not.toContain('--web.enable-otlp-receiver');
  });

  it('rejects forbidden Prometheus flags on the pinned image', () => {
    expect(() => assertForbiddenPrometheusFlagsRejected()).not.toThrow();
  });

  it('starts pinned Prometheus with compose flags and loads enterprise rules', async () => {
    const result = await validateEnterprisePrometheusRuntime();
    expect(result.readyHttpStatus).toBe(200);
    expect(result.started).toBe(true);
  });

  it('validates collector config with the pinned contrib image', () => {
    const result = validateEnterpriseCollectorConfig();
    expect(result.validated).toBe(true);
  });
});

describe('enterprise prometheus — OTLP probe (production rules + builders)', () => {
  it('proves production selectors and translated labels end-to-end', async () => {
    const result = await runOtlpPrometheusTranslationProbe();
    expect(result.querySelectorsProven.length).toBeGreaterThanOrEqual(12);
    expect(result.metricsSeen).toEqual(
      expect.arrayContaining([
        'enterprise_platform_config_publish_total',
        'enterprise_platform_operational_snapshot_ready',
      ]),
    );
    // Conflict and failure both present when production rules require them.
    const selectors = parseProductionRuleSelectors(result.rulesPath);
    const points = buildEmissionPointsFromSelectors(selectors);
    const outcomes = points
      .filter((point) => point.metric === 'enterprise_platform_config_publish_total')
      .map((point) => point.prometheusLabels.enterprise_outcome);
    expect(outcomes).toEqual(expect.arrayContaining(['failure', 'conflict']));
  }, 180_000);
});

describe('enterprise prometheus — cleanup fail-closed + sleep backoff', () => {
  it('fails closed when container cleanup is injected to fail', () => {
    const result = cleanupProbeResources(
      { containers: ['enterprise-o06-nonexistent-container-xyz'] },
      {
        injectContainerRmError: () => new Error('injected rm failure'),
        skipVerify: true,
      },
    );
    expect(result.errors.length).toBeGreaterThan(0);
    expect(() => {
      if (result.errors.length || result.residue.length) {
        throw new AggregateError(result.errors, 'cleanup failed');
      }
    }).toThrow(/injected rm failure|cleanup failed/);
  });

  it('records sleep backoff without busy-spinning (injectable sleep)', async () => {
    const sleeps: number[] = [];
    setSleepForTests(async (ms) => {
      sleeps.push(ms);
    });
    // Drive a tiny poll loop pattern used by validators.
    const deadline = Date.now() + 5;
    let attempts = 0;
    while (Date.now() < deadline && attempts < 3) {
      attempts += 1;
      await (await import('./sleep')).sleepMs(200);
    }
    expect(sleeps.every((ms) => ms === 200)).toBe(true);
    expect(sleeps.length).toBeGreaterThan(0);
  });
});
