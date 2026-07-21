// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { checkEnterprisePrometheusRules } from './checkRules';
import { assertEnterprisePrometheusComposeWiring } from './composeWiring';
import {
  ENTERPRISE_PROMETHEUS_IMAGE,
  resolveAlertRulesPath,
  resolveRepositoryRoot,
} from './constants';
import { parsePrometheusAlertRulesFile } from './parseRules';

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

describe('enterprise prometheus rules — compose wiring', () => {
  it('loads rules via read-only mounts and rule_files without Alertmanager receivers', () => {
    const report = assertEnterprisePrometheusComposeWiring();
    expect(report.ruleFilesGlob).toBe('/etc/prometheus/rules/*.yml');
    expect(report.rulesHostPathFragment).toBe('./prometheus/rules');
  });

  it('fails when compose loses the read-only rules mount', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'enterprise-compose-'));
    tempDirs.push(root);
    const grafana = path.join(root, 'docker-compose/production/grafana');
    mkdirSync(path.join(grafana, 'prometheus/rules'), { recursive: true });
    writeFileSync(
      path.join(grafana, 'docker-compose.yml'),
      `
services:
  prometheus:
    image: prom/prometheus:v2.55.1
    volumes:
      - ./prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro
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
    expect(() => assertEnterprisePrometheusComposeWiring(root)).toThrow(/read-only/i);
  });
});

describe('enterprise prometheus rules — structural drift guards', () => {
  it('parses exactly twelve unique alert identities from the reference YAML', () => {
    const rules = parsePrometheusAlertRulesFile(resolveAlertRulesPath(resolveRepositoryRoot()));
    expect(rules).toHaveLength(12);
    expect(new Set(rules.map((rule) => rule.alert)).size).toBe(12);
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
