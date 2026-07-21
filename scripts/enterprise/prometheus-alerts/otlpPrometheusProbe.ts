import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { assertCleanupClean, cleanupProbeResources, throwWithCleanup } from './cleanup';
import {
  ENTERPRISE_OTEL_COLLECTOR_IMAGE,
  ENTERPRISE_PROMETHEUS_IMAGE,
  resolveAlertRulesPath,
  resolveRepositoryRoot,
} from './constants';
import {
  buildEmissionPointsFromSelectors,
  type EmissionPoint,
  otelKeyToPrometheusLabel,
} from './emissionContract';
import { parseProductionRuleSelectors } from './parseSelectors';
import { sleepMs } from './sleep';

export interface OtlpProbeResult {
  emissionPoints: number;
  metricsSeen: string[];
  querySelectorsProven: string[];
  rulesPath: string;
}

const PROBE_PREFIX = 'enterprise-o06-probe';

const dockerInfo = (): void => {
  try {
    execFileSync('docker', ['info'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000,
    });
  } catch (error) {
    throw new Error(
      `Docker is required for the OTLP→Prometheus probe (fail closed): ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
};

const curlJson = (url: string, init?: { method?: string; body?: string; headers?: string[] }) => {
  const args = ['-sS', '--max-time', '15'];
  if (init?.method) args.push('-X', init.method);
  for (const header of init?.headers ?? []) {
    args.push('-H', header);
  }
  if (init?.body !== undefined) {
    args.push('--data-binary', init.body);
  }
  args.push(url);
  return execFileSync('curl', args, { encoding: 'utf8', timeout: 20_000 });
};

const buildOtlpPayload = (points: EmissionPoint[], nowNano: string): string => {
  // Group data points by metric name for a compact OTLP payload.
  const byMetric = new Map<string, EmissionPoint[]>();
  for (const point of points) {
    const list = byMetric.get(point.metric) ?? [];
    list.push(point);
    byMetric.set(point.metric, list);
  }

  const metrics = [...byMetric.entries()].map(([name, group]) => {
    const isCounter = group[0]!.isCounter;
    if (isCounter) {
      return {
        name,
        sum: {
          aggregationTemporality: 2,
          isMonotonic: true,
          dataPoints: group.map((point) => ({
            asInt: String(point.value),
            attributes: Object.entries(point.attributes).map(([key, value]) => ({
              key,
              value: { stringValue: value },
            })),
            timeUnixNano: nowNano,
          })),
        },
      };
    }
    return {
      name,
      gauge: {
        dataPoints: group.map((point) => ({
          asDouble: point.value,
          attributes: Object.entries(point.attributes).map(([key, value]) => ({
            key,
            value: { stringValue: value },
          })),
          timeUnixNano: nowNano,
        })),
      },
    };
  });

  return JSON.stringify({
    resourceMetrics: [
      {
        resource: {
          attributes: [{ key: 'service.name', value: { stringValue: 'enterprise-o06-probe' } }],
        },
        scopeMetrics: [{ scope: { name: 'enterprise-o06-probe' }, metrics }],
      },
    ],
  });
};

export interface OtlpProbeOptions {
  /** Test hook: inject cleanup failures. */
  injectContainerRmError?: (name: string) => Error | null;
  injectNetworkRmError?: (name: string) => Error | null;
  repositoryRoot?: string;
  rulesPath?: string;
}

/**
 * Disposable E2E probe:
 * 1. Parse production rule selectors (oracle source 1)
 * 2. Build emission via real attribute builders + closed vocab (oracle source 2)
 * 3. OTLP → pinned collector → Prometheus remote-write
 * 4. Query production selectors and prove labels/metrics
 * Cleanup is fail-closed (residue or rm errors fail the gate).
 */
export const runOtlpPrometheusTranslationProbe = async (
  options: OtlpProbeOptions = {},
): Promise<OtlpProbeResult> => {
  dockerInfo();

  const repositoryRoot = options.repositoryRoot ?? resolveRepositoryRoot();
  const rulesPath = options.rulesPath ?? resolveAlertRulesPath(repositoryRoot);
  const selectors = parseProductionRuleSelectors(rulesPath);
  if (selectors.length === 0) {
    throw new Error('No selectors parsed from production rules (fail closed)');
  }
  const emissionPoints = buildEmissionPointsFromSelectors(selectors);
  if (emissionPoints.length === 0) {
    throw new Error('No emission points derived from production selectors (fail closed)');
  }

  // Require both publish failure and conflict when production rules include both.
  const publishOutcomes = new Set(
    emissionPoints
      .filter((point) => point.metric === 'enterprise_platform_config_publish_total')
      .map((point) => point.prometheusLabels.enterprise_outcome),
  );
  if (
    selectors.some(
      (selector) =>
        selector.metric === 'enterprise_platform_config_publish_total' &&
        selector.matchers.some(
          (matcher) => matcher.name === 'enterprise_outcome' && matcher.value === 'conflict',
        ),
    ) &&
    !publishOutcomes.has('conflict')
  ) {
    throw new Error(
      'Emission contract missing publish conflict series required by production rules',
    );
  }
  if (
    selectors.some(
      (selector) =>
        selector.metric === 'enterprise_platform_config_publish_total' &&
        selector.matchers.some(
          (matcher) => matcher.name === 'enterprise_outcome' && matcher.value === 'failure',
        ),
    ) &&
    !publishOutcomes.has('failure')
  ) {
    throw new Error(
      'Emission contract missing publish failure series required by production rules',
    );
  }

  const id = `${Date.now()}`;
  const network = `${PROBE_PREFIX}-net-${id}`;
  const promName = `${PROBE_PREFIX}-prom-${id}`;
  const colName = `${PROBE_PREFIX}-col-${id}`;
  const tempDir = mkdtempSync(path.join(tmpdir(), `${PROBE_PREFIX}-`));
  const promConfigPath = path.join(tempDir, 'prometheus.yml');
  const collectorConfigPath = path.join(tempDir, 'collector.yaml');
  const containers = [promName, colName];
  const networks = [network];
  const tempDirs = [tempDir];

  writeFileSync(
    promConfigPath,
    `global:
  scrape_interval: 15s
  evaluation_interval: 15s
scrape_configs: []
`,
  );
  writeFileSync(
    collectorConfigPath,
    `receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
exporters:
  prometheusremotewrite:
    endpoint: http://${promName}:9090/api/v1/write
    tls:
      insecure: true
service:
  pipelines:
    metrics:
      receivers: [otlp]
      exporters: [prometheusremotewrite]
`,
  );

  let primaryError: unknown;
  let result: OtlpProbeResult | undefined;

  try {
    execFileSync('docker', ['network', 'create', network], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });

    execFileSync(
      'docker',
      [
        'run',
        '-d',
        '--name',
        promName,
        '--network',
        network,
        '-p',
        '127.0.0.1:0:9090',
        '-v',
        `${promConfigPath}:/etc/prometheus/prometheus.yml:ro`,
        ENTERPRISE_PROMETHEUS_IMAGE,
        '--config.file=/etc/prometheus/prometheus.yml',
        '--web.enable-remote-write-receiver',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 },
    );

    execFileSync(
      'docker',
      [
        'run',
        '-d',
        '--name',
        colName,
        '--network',
        network,
        '-p',
        '127.0.0.1:0:4318',
        '-v',
        `${collectorConfigPath}:/etc/otelcol/config.yaml:ro`,
        ENTERPRISE_OTEL_COLLECTOR_IMAGE,
        '--config=/etc/otelcol/config.yaml',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 },
    );

    const promPort = execFileSync('docker', ['port', promName, '9090'], {
      encoding: 'utf8',
      timeout: 10_000,
    })
      .trim()
      .split(':')
      .pop();
    const colPort = execFileSync('docker', ['port', colName, '4318'], {
      encoding: 'utf8',
      timeout: 10_000,
    })
      .trim()
      .split(':')
      .pop();
    if (!promPort || !colPort) throw new Error('Failed to resolve probe published ports');

    const readyDeadline = Date.now() + 40_000;
    while (Date.now() < readyDeadline) {
      try {
        const code = execFileSync(
          'curl',
          ['-sS', '-o', '/dev/null', '-w', '%{http_code}', `http://127.0.0.1:${promPort}/-/ready`],
          { encoding: 'utf8', timeout: 5_000 },
        ).trim();
        if (code === '200') break;
      } catch {
        /* retry */
      }
      await sleepMs(200);
    }

    const nowNano = `${BigInt(Date.now()) * 1_000_000n}`;
    const payload = buildOtlpPayload(emissionPoints, nowNano);
    const otlpResponse = curlJson(`http://127.0.0.1:${colPort}/v1/metrics`, {
      method: 'POST',
      headers: ['Content-Type: application/json'],
      body: payload,
    });
    if (otlpResponse.includes('"error"') && !otlpResponse.includes('partialSuccess')) {
      throw new Error(`OTLP export failed: ${otlpResponse.slice(0, 500)}`);
    }

    const querySelectorsProven: string[] = [];
    const metricsSeen: string[] = [];
    const queryDeadline = Date.now() + 45_000;
    let lastError = '';

    while (Date.now() < queryDeadline) {
      try {
        querySelectorsProven.length = 0;
        metricsSeen.length = 0;
        for (const point of emissionPoints) {
          // Query the exact emitted series (builder labels), not a bare metric that may
          // return an arbitrary series when multiple collectors share a name.
          const labelMatchers = Object.entries(point.prometheusLabels)
            .map(([key, value]) => `${key}="${value}"`)
            .join(',');
          const selector =
            labelMatchers.length > 0 ? `${point.metric}{${labelMatchers}}` : point.querySelector;
          const raw = curlJson(
            `http://127.0.0.1:${promPort}/api/v1/query?query=${encodeURIComponent(selector)}`,
          );
          const parsed = JSON.parse(raw) as {
            status: string;
            data?: { result?: Array<{ metric: Record<string, string>; value: [number, string] }> };
          };
          if (parsed.status !== 'success' || !parsed.data?.result?.length) {
            throw new Error(`No series for production selector ${selector}: ${raw.slice(0, 300)}`);
          }
          const sample = parsed.data.result[0]!;
          if (sample.metric.__name__ !== point.metric) {
            throw new Error(
              `Metric name mismatch: expected ${point.metric}, got ${sample.metric.__name__}`,
            );
          }
          for (const [promLabel, expected] of Object.entries(point.prometheusLabels)) {
            if (sample.metric[promLabel] !== expected) {
              throw new Error(
                `Label ${promLabel} expected ${expected}, got ${sample.metric[promLabel]} on ${point.metric}; full=${JSON.stringify(sample.metric)}`,
              );
            }
          }
          for (const otelKey of Object.keys(point.attributes)) {
            if (otelKey in sample.metric) {
              throw new Error(`OTel dotted key leaked into Prometheus labels: ${otelKey}`);
            }
            const promKey = otelKeyToPrometheusLabel(otelKey);
            if (!(promKey in sample.metric)) {
              throw new Error(
                `Missing translated label ${promKey} (from ${otelKey}) on ${point.metric}`,
              );
            }
          }
          if (!metricsSeen.includes(point.metric)) metricsSeen.push(point.metric);
          querySelectorsProven.push(selector);
        }
        // Additionally prove every production-rule selector (including failure and conflict)
        // returns at least one series after translation.
        for (const production of selectors) {
          const raw = curlJson(
            `http://127.0.0.1:${promPort}/api/v1/query?query=${encodeURIComponent(production.querySelector)}`,
          );
          const parsed = JSON.parse(raw) as {
            status: string;
            data?: { result?: unknown[] };
          };
          if (parsed.status !== 'success' || !parsed.data?.result?.length) {
            throw new Error(
              `Production rule selector empty after translation: ${production.querySelector} (alert ${production.alert})`,
            );
          }
        }

        lastError = '';
        break;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        await sleepMs(250);
      }
    }

    if (lastError || querySelectorsProven.length !== emissionPoints.length) {
      throw new Error(
        `OTLP→Prometheus translation probe failed (fail closed): ${lastError || 'incomplete selectors'}`,
      );
    }

    result = {
      emissionPoints: emissionPoints.length,
      metricsSeen,
      querySelectorsProven,
      rulesPath,
    };
  } catch (error) {
    primaryError = error;
  } finally {
    const cleanup = cleanupProbeResources(
      { containers, networks, tempDirs },
      {
        injectContainerRmError: options.injectContainerRmError,
        injectNetworkRmError: options.injectNetworkRmError,
      },
    );
    if (primaryError) {
      throwWithCleanup(primaryError, cleanup);
    }
    assertCleanupClean(cleanup);
  }

  if (!result) {
    throw new Error('OTLP probe completed without result (fail closed)');
  }
  return result;
};

export const main = async (argv: string[] = process.argv.slice(2)): Promise<number> => {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      [
        'Usage: bun run scripts/enterprise/prometheus-alerts/otlpPrometheusProbe.ts',
        '',
        'Parse production rules + real emission builders → OTLP → Prometheus label proof.',
      ].join('\n'),
    );
    return 0;
  }
  const result = await runOtlpPrometheusTranslationProbe();
  console.log(
    `✓ OTLP→Prometheus probe proved ${result.querySelectorsProven.length} production selectors (${result.metricsSeen.length} metrics) from ${result.rulesPath}`,
  );
  return 0;
};

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
