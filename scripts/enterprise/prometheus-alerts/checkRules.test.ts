// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { checkEnterprisePrometheusRules } from './checkRules';
import { validateEnterpriseCollectorConfig } from './collectorValidate';
import { assertEnterprisePrometheusComposeWiring } from './composeWiring';
import {
  ENTERPRISE_OTEL_COLLECTOR_IMAGE,
  ENTERPRISE_PROMETHEUS_IMAGE,
  resolveAlertRulesPath,
  resolveRepositoryRoot,
} from './constants';
import {
  assertRuleExprUsesPrometheusLabels,
  ENTERPRISE_ALERT_SELECTOR_FAMILIES,
  OTEL_TO_PROMETHEUS_LABEL,
} from './metricTranslation';
import { runOtlpPrometheusTranslationProbe } from './otlpPrometheusProbe';
import { parsePrometheusAlertRulesFile } from './parseRules';
import {
  assertForbiddenPrometheusFlagsRejected,
  validateEnterprisePrometheusRuntime,
} from './prometheusRuntime';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { force: true, recursive: true });
  }
});

const writeTempRules = (contents: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'enterprise-prom-rules-'));
  tempDirs.push(dir);
  const rulesPath = path.join(dir, 'enterprise-platform-alerts.yml');
  writeFileSync(rulesPath, contents, 'utf8');
  return rulesPath;
};

describe('enterprise prometheus rules — promtool validation', () => {
  it('passes promtool check rules for the checked-in reference file (fail closed)', () => {
    const result = checkEnterprisePrometheusRules();
    expect(result.image).toBe(ENTERPRISE_PROMETHEUS_IMAGE);
    expect(result.stdout.toLowerCase()).toMatch(/success|checking/);
  });

  it('fails closed on invalid PromQL expressions', () => {
    const rulesPath = writeTempRules(`
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
          runbook: docs/enterprise/runbooks/enterprise-prometheus-alerts.md#broken
`);
    expect(() => checkEnterprisePrometheusRules({ rulesPath })).toThrow(
      /promtool check rules failed/i,
    );
  });

  it('fails closed when the rules file is missing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'enterprise-prom-missing-'));
    tempDirs.push(dir);
    expect(() =>
      checkEnterprisePrometheusRules({ rulesPath: path.join(dir, 'does-not-exist.yml') }),
    ).toThrow(/missing/i);
  });
});

describe('enterprise prometheus rules — compose + collector wiring', () => {
  it('loads rules via read-only mounts, pins images, and wires OTLP→prometheusremotewrite', () => {
    const report = assertEnterprisePrometheusComposeWiring();
    expect(report.ruleFilesGlob).toBe('/etc/prometheus/rules/*.yml');
    expect(report.rulesHostPathFragment).toBe('./prometheus/rules');
    expect(report.prometheusImage).toBe(ENTERPRISE_PROMETHEUS_IMAGE);
    expect(report.collectorImage).toBe(ENTERPRISE_OTEL_COLLECTOR_IMAGE);
    expect(report.metricsPipeline.receivers).toContain('otlp');
    expect(report.metricsPipeline.exporters).toContain('prometheusremotewrite');
    expect(report.prometheusCommand).not.toContain('--web.enable-otlp-receiver');
    expect(report.prometheusCommand).toContain('--web.enable-remote-write-receiver');
  });

  it('fails when compose loses the read-only rules mount', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'enterprise-compose-'));
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
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--web.enable-remote-write-receiver'
  otel-collector:
    image: ${ENTERPRISE_OTEL_COLLECTOR_IMAGE}
    volumes:
      - ./otel-collector/collector-config.yaml:/etc/otelcol/config.yaml:ro
`,
      'utf8',
    );
    writeFileSync(
      path.join(grafana, 'prometheus/prometheus.yml'),
      `
global:
  scrape_interval: 15s
rule_files:
  - /etc/prometheus/rules/*.yml
`,
      'utf8',
    );
    writeFileSync(
      path.join(grafana, 'otel-collector/collector-config.yaml'),
      `
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
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
    expect(() => assertEnterprisePrometheusComposeWiring(root)).toThrow(/read-only/i);
  });

  it('fails when collector metrics pipeline drops otlp', () => {
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
      `rule_files:\n  - /etc/prometheus/rules/*.yml\n`,
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

describe('enterprise prometheus rules — structural drift guards', () => {
  it('parses exactly twelve unique alert identities from the reference YAML', () => {
    const rules = parsePrometheusAlertRulesFile(resolveAlertRulesPath(resolveRepositoryRoot()));
    expect(rules).toHaveLength(12);
    expect(new Set(rules.map((rule) => rule.alert)).size).toBe(12);
  });

  it('uses proven Prometheus underscore labels in every rule expr', () => {
    const rules = parsePrometheusAlertRulesFile(resolveAlertRulesPath(resolveRepositoryRoot()));
    for (const rule of rules) {
      expect(() => assertRuleExprUsesPrometheusLabels(rule.expr)).not.toThrow();
      expect(rule.expr).not.toContain('enterprise.');
    }
  });

  it('encodes exact selector families used by reference rules', () => {
    const rules = parsePrometheusAlertRulesFile(resolveAlertRulesPath(resolveRepositoryRoot()));
    const blob = rules.map((rule) => rule.expr).join('\n');
    for (const family of ENTERPRISE_ALERT_SELECTOR_FAMILIES) {
      expect(blob, family.family).toContain(family.metric);
    }
    // Counter outcome selector must use translated label key.
    expect(blob).toContain('enterprise_outcome=');
    expect(blob).not.toContain('enterprise.outcome');
    expect(OTEL_TO_PROMETHEUS_LABEL['enterprise.outcome']).toBe('enterprise_outcome');
    expect(OTEL_TO_PROMETHEUS_LABEL['enterprise.scope']).toBe('enterprise_scope');
  });

  it('EnterpriseOperationalCollectionStale covers ready=0 and age stale', () => {
    const rules = parsePrometheusAlertRulesFile(resolveAlertRulesPath(resolveRepositoryRoot()));
    const operational = rules.find((rule) => rule.alert === 'EnterpriseOperationalCollectionStale');
    expect(operational).toBeDefined();
    expect(operational!.expr).toMatch(/operational_snapshot_age_seconds/);
    expect(operational!.expr).toMatch(/operational_snapshot_ready/);
    expect(operational!.expr).toMatch(/==\s*0/);
    expect(operational!.expr.toLowerCase()).toContain('or');
    expect(operational!.expr).toMatch(/\bmax\s*\(\s*enterprise_platform_operational_snapshot_age/);
    expect(operational!.expr).toMatch(
      /\bmax\s*\(\s*enterprise_platform_operational_snapshot_ready/,
    );
  });

  it('detects duplicate alert names as drift', () => {
    const rulesPath = writeTempRules(`
groups:
  - name: dupes
    rules:
      - alert: SameName
        expr: vector(1) > 0
        labels:
          severity: warning
          component: a
        annotations:
          summary: one
          runbook: docs/x.md#a
      - alert: SameName
        expr: vector(1) > 0
        labels:
          severity: warning
          component: b
        annotations:
          summary: two
          runbook: docs/x.md#b
`);
    const rules = parsePrometheusAlertRulesFile(rulesPath);
    const names = rules.map((rule) => rule.alert);
    expect(new Set(names).size).toBeLessThan(names.length);
  });
});

describe('enterprise prometheus — runtime and collector validation', () => {
  it('rejects forbidden flags on the pinned Prometheus image', () => {
    expect(() => assertForbiddenPrometheusFlagsRejected()).not.toThrow();
  });

  it('starts pinned Prometheus with compose flags and loads enterprise rules', () => {
    const result = validateEnterprisePrometheusRuntime();
    expect(result.image).toBe(ENTERPRISE_PROMETHEUS_IMAGE);
    expect(result.readyHttpStatus).toBe(200);
    expect(result.started).toBe(true);
    expect(result.flags).not.toContain('--web.enable-otlp-receiver');
  });

  it('validates collector config with the pinned contrib image', () => {
    const result = validateEnterpriseCollectorConfig();
    expect(result.image).toBe(ENTERPRISE_OTEL_COLLECTOR_IMAGE);
    expect(result.validated).toBe(true);
  });
});

describe('enterprise prometheus — OTLP translation probe', () => {
  it('proves metric names and translated labels for every selector family (fail closed)', () => {
    const result = runOtlpPrometheusTranslationProbe();
    expect(result.familiesProven).toHaveLength(ENTERPRISE_ALERT_SELECTOR_FAMILIES.length);
    expect(result.metricsSeen).toEqual(
      expect.arrayContaining(ENTERPRISE_ALERT_SELECTOR_FAMILIES.map((f) => f.metric)),
    );
    expect(result.labelTranslation['enterprise.outcome']).toBe('enterprise_outcome');
    expect(result.labelTranslation['enterprise.scope']).toBe('enterprise_scope');
  }, 180_000);
});
