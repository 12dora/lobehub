// @vitest-environment node
/**
 * Opt-in Docker/network-dependent enterprise Prometheus gates.
 *
 * Run explicitly (not part of the hermetic unit suite):
 *   ENTERPRISE_PROM_INTEGRATION=1 bunx vitest run scripts/enterprise/prometheus-alerts/checkRules.integration.test.ts
 *
 * Requires: Docker daemon, ability to pull/run pinned Prometheus + OTel images.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { checkEnterprisePrometheusRules, testEnterprisePrometheusRules } from './checkRules';
import { validateEnterpriseCollectorConfig } from './collectorValidate';
import { ENTERPRISE_OTEL_COLLECTOR_IMAGE, ENTERPRISE_PROMETHEUS_IMAGE } from './constants';
import { buildEmissionPointsFromSelectors } from './emissionContract';
import { runOtlpPrometheusTranslationProbe } from './otlpPrometheusProbe';
import { parseProductionRuleSelectors } from './parseSelectors';
import {
  assertForbiddenPrometheusFlagsRejected,
  validateEnterprisePrometheusRuntime,
} from './prometheusRuntime';

const enabled = process.env.ENTERPRISE_PROM_INTEGRATION === '1';
const describeIntegration = enabled ? describe : describe.skip;

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { force: true, recursive: true });
  }
});

const writeTempRules = (contents: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'enterprise-prom-rules-int-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'enterprise-platform-alerts.yml');
  writeFileSync(file, contents, 'utf8');
  return file;
};

describeIntegration('enterprise prometheus — docker integration (opt-in)', () => {
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

  // Migrated from the hermetic unit suite (F11): invalid PromQL must still fail closed
  // under real promtool — kept opt-in so ordinary unit runs stay Docker-free.
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
    expect(ENTERPRISE_OTEL_COLLECTOR_IMAGE.length).toBeGreaterThan(0);
  });

  it('proves production selectors and translated labels end-to-end', async () => {
    const result = await runOtlpPrometheusTranslationProbe();
    expect(result.querySelectorsProven.length).toBeGreaterThanOrEqual(12);
    expect(result.metricsSeen).toEqual(
      expect.arrayContaining([
        'enterprise_platform_config_publish_total',
        'enterprise_platform_operational_snapshot_ready',
      ]),
    );
    const selectors = parseProductionRuleSelectors(result.rulesPath);
    const points = buildEmissionPointsFromSelectors(selectors);
    const outcomes = points
      .filter((point) => point.metric === 'enterprise_platform_config_publish_total')
      .map((point) => point.prometheusLabels.enterprise_outcome);
    expect(outcomes).toEqual(expect.arrayContaining(['failure', 'conflict']));
  }, 180_000);
});
