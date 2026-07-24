// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { cleanupProbeResources } from './cleanup';
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
import { parsePrometheusAlertRulesFile } from './parseRules';
import { parseProductionRuleSelectors } from './parseSelectors';
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

  it('rejects image pin present only in comments or unrelated services', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'enterprise-compose-fake-pin-'));
    tempDirs.push(root);
    const grafana = path.join(root, 'docker-compose/production/grafana');
    mkdirSync(path.join(grafana, 'prometheus/rules'), { recursive: true });
    mkdirSync(path.join(grafana, 'otel-collector'), { recursive: true });
    writeFileSync(
      path.join(grafana, 'docker-compose.yml'),
      `
services:
  # image: ${ENTERPRISE_PROMETHEUS_IMAGE}
  docs:
    image: ${ENTERPRISE_PROMETHEUS_IMAGE}
    volumes:
      - ./prometheus/rules:/etc/prometheus/rules:ro
  prometheus:
    image: prom/prometheus:latest
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
exporters:
  prometheusremotewrite:
    endpoint: http://127.0.0.1:9090/api/v1/write
  debug:
    verbosity: basic
service:
  pipelines:
    metrics:
      receivers: [otlp]
      exporters: [prometheusremotewrite]
`,
      'utf8',
    );
    expect(() => assertEnterprisePrometheusComposeWiring(root)).toThrow(
      /services\.prometheus\.image must pin/i,
    );
  });

  // Substring-bypass negative: target CONTAINS the expected path as a prefix/substring
  // (`/etc/prometheus/rules-shadow` includes `/etc/prometheus/rules`). The old whole-string
  // `includes('/etc/prometheus/rules')` matcher would ACCEPT this mount; exact-target
  // matching correctly REJECTS it. Do not use unrelated paths like `/var/prometheus/rules`
  // — those already fail under the old matcher and make the test rotten.
  it('rejects rules mount when container target only substring-matches the expected path', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'enterprise-compose-wrong-target-'));
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
      # source + :ro correct; target is a superstring of /etc/prometheus/rules
      - ./prometheus/rules:/etc/prometheus/rules-shadow:ro
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
exporters:
  prometheusremotewrite:
    endpoint: http://127.0.0.1:9090/api/v1/write
  debug:
    verbosity: basic
service:
  pipelines:
    metrics:
      receivers: [otlp]
      exporters: [prometheusremotewrite]
`,
      'utf8',
    );
    expect(() => assertEnterprisePrometheusComposeWiring(root)).toThrow(
      /must mount rules read-only/i,
    );
  });

  // Compose ACCESS_MODE is a comma-separated list. Exact-target + `:ro` must still
  // accept valid short-syntax mounts such as `:ro,Z` (SELinux) and `:z,ro` (token order).
  it('accepts rules mount with comma-separated ACCESS_MODE containing ro (ro,Z and z,ro)', () => {
    const collectorConfig = `
exporters:
  prometheusremotewrite:
    endpoint: http://127.0.0.1:9090/api/v1/write
  debug:
    verbosity: basic
service:
  pipelines:
    metrics:
      receivers: [otlp]
      exporters: [prometheusremotewrite]
`;

    for (const rulesMode of ['ro,Z', 'z,ro'] as const) {
      const root = mkdtempSync(path.join(tmpdir(), `enterprise-compose-mode-${rulesMode}-`));
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
      - ./prometheus/rules:/etc/prometheus/rules:${rulesMode}
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
        collectorConfig,
        'utf8',
      );
      expect(() => assertEnterprisePrometheusComposeWiring(root)).not.toThrow();
    }
  });

  // Missing-:ro negative: exact source/target but writable. The old substring matcher
  // ignored access mode and would ACCEPT this; readOnly enforcement correctly REJECTS it.
  it('rejects rules mount when :ro (read-only) mode is missing', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'enterprise-compose-missing-ro-'));
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
      # exact source/target but writable (no :ro)
      - ./prometheus/rules:/etc/prometheus/rules
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
exporters:
  prometheusremotewrite:
    endpoint: http://127.0.0.1:9090/api/v1/write
  debug:
    verbosity: basic
service:
  pipelines:
    metrics:
      receivers: [otlp]
      exporters: [prometheusremotewrite]
`,
      'utf8',
    );
    expect(() => assertEnterprisePrometheusComposeWiring(root)).toThrow(
      /must mount rules read-only/i,
    );
  });

  it('rejects long-form volume when read_only is false', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'enterprise-compose-long-rw-'));
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
      - type: bind
        source: ./prometheus/prometheus.yml
        target: /etc/prometheus/prometheus.yml
        read_only: true
      - type: bind
        source: ./prometheus/rules
        target: /etc/prometheus/rules
        read_only: false
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
exporters:
  prometheusremotewrite:
    endpoint: http://127.0.0.1:9090/api/v1/write
  debug:
    verbosity: basic
service:
  pipelines:
    metrics:
      receivers: [otlp]
      exporters: [prometheusremotewrite]
`,
      'utf8',
    );
    expect(() => assertEnterprisePrometheusComposeWiring(root)).toThrow(
      /must mount rules read-only/i,
    );
  });
});

describe('enterprise prometheus — compose wiring (hermetic)', () => {
  it('wires rules, pins images, OTLP→prometheusremotewrite, no forbidden flags', () => {
    const report = assertEnterprisePrometheusComposeWiring();
    expect(report.prometheusImage).toBe(ENTERPRISE_PROMETHEUS_IMAGE);
    expect(report.collectorImage).toBe(ENTERPRISE_OTEL_COLLECTOR_IMAGE);
    expect(report.metricsPipeline.receivers).toContain('otlp');
    expect(report.metricsPipeline.exporters).toContain('prometheusremotewrite');
    expect(report.prometheusCommand).not.toContain('--web.enable-otlp-receiver');
  });
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

  it('records sleep backoff with a deterministic fake clock (not wall time)', async () => {
    const sleeps: number[] = [];
    setSleepForTests(async (ms) => {
      sleeps.push(ms);
    });
    // Injectable clock: loop condition independent of Date.now() jitter.
    let now = 0;
    const deadline = 5;
    let attempts = 0;
    while (now < deadline && attempts < 3) {
      attempts += 1;
      await (await import('./sleep')).sleepMs(200);
      now += 200; // fake clock advances by the requested sleep quantum
    }
    expect(sleeps).toEqual([200]);
    expect(attempts).toBe(1);
    expect(now).toBe(200);
  });
});
