import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ENTERPRISE_OTEL_COLLECTOR_IMAGE, ENTERPRISE_PROMETHEUS_IMAGE } from './constants';
import {
  ENTERPRISE_ALERT_SELECTOR_FAMILIES,
  OTEL_TO_PROMETHEUS_LABEL,
  promqlInstantSelector,
} from './metricTranslation';

export interface OtlpProbeResult {
  familiesProven: string[];
  labelTranslation: typeof OTEL_TO_PROMETHEUS_LABEL;
  metricsSeen: string[];
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

const sleepMs = (ms: number): void => {
  const waitUntil = Date.now() + ms;
  while (Date.now() < waitUntil) {
    /* bounded busy-wait for probe polling */
  }
};

const dockerRmForce = (names: string[]): void => {
  for (const name of names) {
    try {
      execFileSync('docker', ['rm', '-f', name], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      });
    } catch {
      /* ignore */
    }
  }
};

const dockerNetworkRm = (name: string): void => {
  try {
    execFileSync('docker', ['network', 'rm', name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
  } catch {
    /* ignore */
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

const buildOtlpPayload = (nowNano: string): string => {
  const metrics = ENTERPRISE_ALERT_SELECTOR_FAMILIES.map((family) => {
    const attributes = Object.entries(family.otelAttributes).map(([key, value]) => ({
      key,
      value: { stringValue: value },
    }));
    const isCounter = family.metric.endsWith('_total');
    if (isCounter) {
      return {
        name: family.metric,
        sum: {
          aggregationTemporality: 2,
          isMonotonic: true,
          dataPoints: [
            {
              asInt: '5',
              attributes,
              timeUnixNano: nowNano,
            },
          ],
        },
      };
    }
    return {
      name: family.metric,
      gauge: {
        dataPoints: [
          {
            asDouble: family.metric.includes('ready') ? 0 : 42,
            attributes,
            timeUnixNano: nowNano,
          },
        ],
      },
    };
  });

  return JSON.stringify({
    resourceMetrics: [
      {
        resource: {
          attributes: [{ key: 'service.name', value: { stringValue: 'enterprise-o06-probe' } }],
        },
        scopeMetrics: [
          {
            scope: { name: 'enterprise-o06-probe' },
            metrics,
          },
        ],
      },
    ],
  });
};

/**
 * Disposable end-to-end probe: pinned collector + Prometheus, OTLP inject, PromQL proof.
 * Fail closed if Docker/images/config/translation are unavailable. Always cleans residue.
 */
export const runOtlpPrometheusTranslationProbe = (): OtlpProbeResult => {
  dockerInfo();

  const id = `${Date.now()}`;
  const network = `${PROBE_PREFIX}-net-${id}`;
  const promName = `${PROBE_PREFIX}-prom-${id}`;
  const colName = `${PROBE_PREFIX}-col-${id}`;
  const tempDir = mkdtempSync(path.join(tmpdir(), `${PROBE_PREFIX}-`));
  const promConfigPath = path.join(tempDir, 'prometheus.yml');
  const collectorConfigPath = path.join(tempDir, 'collector.yaml');

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

  const metricsSeen: string[] = [];
  const familiesProven: string[] = [];

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
        '127.0.0.1::9090',
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
        '127.0.0.1::4318',
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

    // Wait for ready endpoints.
    const readyDeadline = Date.now() + 40_000;
    while (Date.now() < readyDeadline) {
      try {
        const ready = curlJson(`http://127.0.0.1:${promPort}/-/ready`);
        if (ready.includes('Prometheus Server is Ready') || ready.trim() === '') {
          // /-/ready returns empty body with 200; curlJson doesn't check status.
        }
        const code = execFileSync(
          'curl',
          ['-sS', '-o', '/dev/null', '-w', '%{http_code}', `http://127.0.0.1:${promPort}/-/ready`],
          { encoding: 'utf8', timeout: 5_000 },
        ).trim();
        if (code === '200') break;
      } catch {
        /* retry */
      }
      sleepMs(300);
    }

    const nowNano = `${BigInt(Date.now()) * 1_000_000n}`;
    const payload = buildOtlpPayload(nowNano);
    const otlpResponse = curlJson(`http://127.0.0.1:${colPort}/v1/metrics`, {
      method: 'POST',
      headers: ['Content-Type: application/json'],
      body: payload,
    });
    if (otlpResponse.includes('"error"') && !otlpResponse.includes('partialSuccess')) {
      throw new Error(`OTLP export failed: ${otlpResponse.slice(0, 500)}`);
    }

    // Poll until all families are queryable.
    const queryDeadline = Date.now() + 45_000;
    let lastError = '';
    while (Date.now() < queryDeadline) {
      try {
        familiesProven.length = 0;
        metricsSeen.length = 0;
        for (const family of ENTERPRISE_ALERT_SELECTOR_FAMILIES) {
          const selector = promqlInstantSelector(family.metric, {
            ...family.prometheusLabels,
          });
          const raw = curlJson(
            `http://127.0.0.1:${promPort}/api/v1/query?query=${encodeURIComponent(selector)}`,
          );
          const parsed = JSON.parse(raw) as {
            status: string;
            data?: { result?: Array<{ metric: Record<string, string>; value: [number, string] }> };
          };
          if (parsed.status !== 'success' || !parsed.data?.result?.length) {
            throw new Error(`No series for ${selector}: ${raw.slice(0, 300)}`);
          }
          const sample = parsed.data.result[0]!;
          if (sample.metric.__name__ !== family.metric) {
            throw new Error(
              `Metric name mismatch: expected ${family.metric}, got ${sample.metric.__name__}`,
            );
          }
          for (const [promLabel, expected] of Object.entries(family.prometheusLabels)) {
            if (sample.metric[promLabel] !== expected) {
              throw new Error(
                `Label ${promLabel} expected ${expected}, got ${sample.metric[promLabel]} on ${family.metric}; full=${JSON.stringify(sample.metric)}`,
              );
            }
          }
          // Ensure OTel dotted keys did not leak as Prometheus labels for this family.
          for (const otelKey of Object.keys(family.otelAttributes)) {
            if (otelKey in sample.metric) {
              throw new Error(`OTel dotted key leaked into Prometheus labels: ${otelKey}`);
            }
            const expectedProm = OTEL_TO_PROMETHEUS_LABEL[otelKey];
            if (expectedProm && !(expectedProm in sample.metric)) {
              throw new Error(
                `Missing translated label ${expectedProm} (from ${otelKey}) on ${family.metric}`,
              );
            }
          }
          if (!metricsSeen.includes(family.metric)) metricsSeen.push(family.metric);
          familiesProven.push(family.family);
        }
        lastError = '';
        break;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        sleepMs(500);
      }
    }

    if (lastError || familiesProven.length !== ENTERPRISE_ALERT_SELECTOR_FAMILIES.length) {
      throw new Error(
        `OTLP→Prometheus translation probe failed (fail closed): ${lastError || 'incomplete families'}`,
      );
    }

    return {
      familiesProven: [...familiesProven],
      labelTranslation: OTEL_TO_PROMETHEUS_LABEL,
      metricsSeen: [...metricsSeen],
    };
  } catch (error) {
    throw new Error(
      `OTLP→Prometheus probe failed (fail closed): ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  } finally {
    dockerRmForce([promName, colName]);
    dockerNetworkRm(network);
    rmSync(tempDir, { force: true, recursive: true });
  }
};

export const main = (argv: string[] = process.argv.slice(2)): number => {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      [
        'Usage: bun run scripts/enterprise/prometheus-alerts/otlpPrometheusProbe.ts',
        '',
        'Disposable probe: pinned collector + Prometheus, OTLP inject, PromQL proof of',
        'metric names and translated labels for every reference selector family.',
      ].join('\n'),
    );
    return 0;
  }
  const result = runOtlpPrometheusTranslationProbe();
  console.log(
    `✓ OTLP→Prometheus probe proved ${result.familiesProven.length} selector families (${result.metricsSeen.length} metrics)`,
  );
  return 0;
};

if (import.meta.main) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
