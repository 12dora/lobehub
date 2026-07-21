import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { assertCleanupClean, cleanupProbeResources, throwWithCleanup } from './cleanup';
import { assertEnterprisePrometheusComposeWiring } from './composeWiring';
import {
  ENTERPRISE_PROMETHEUS_FORBIDDEN_FLAGS,
  ENTERPRISE_PROMETHEUS_IMAGE,
  ENTERPRISE_PROMETHEUS_REQUIRED_FLAGS,
  resolveAlertRulesPath,
  resolvePrometheusConfigPath,
  resolveRepositoryRoot,
} from './constants';
import { sleepMs } from './sleep';

const dockerInfo = (): void => {
  try {
    execFileSync('docker', ['info'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000,
    });
  } catch (error) {
    throw new Error(
      `Docker is required for Prometheus runtime validation (fail closed): ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
};

const readPrometheusHelp = (image: string): string => {
  try {
    return execFileSync('docker', ['run', '--rm', image, '--help'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
  } catch (error) {
    const err = error as { stderr?: string; stdout?: string; message?: string };
    const combined = [err.stdout, err.stderr, err.message].filter(Boolean).join('\n');
    if (combined.includes('--config.file') || combined.includes('web.enable')) return combined;
    throw new Error(`Failed to read ${image} --help (fail closed):\n${combined}`, {
      cause: error,
    });
  }
};

const flagSupportedInHelp = (helpText: string, flag: string): boolean => {
  if (flag.startsWith('--enable-feature=')) {
    const feature = flag.slice('--enable-feature='.length);
    return helpText.includes(feature) || helpText.includes('enable-feature');
  }
  const bare = flag.split('=')[0]!;
  return helpText.includes(bare.replace(/^--/, ''));
};

export interface PrometheusRuntimeValidationResult {
  flags: string[];
  helpChecked: boolean;
  image: string;
  readyHttpStatus: number;
  started: boolean;
}

/**
 * Validate compose Prometheus flags against the pinned image and start a real process.
 * Cleanup is fail-closed.
 */
export const validateEnterprisePrometheusRuntime = async (options?: {
  image?: string;
  repositoryRoot?: string;
  injectContainerRmError?: (name: string) => Error | null;
}): Promise<PrometheusRuntimeValidationResult> => {
  const repositoryRoot = options?.repositoryRoot ?? resolveRepositoryRoot();
  const image = options?.image ?? ENTERPRISE_PROMETHEUS_IMAGE;
  const wiring = assertEnterprisePrometheusComposeWiring(repositoryRoot);
  const flags =
    wiring.prometheusCommand.length > 0
      ? wiring.prometheusCommand
      : [...ENTERPRISE_PROMETHEUS_REQUIRED_FLAGS];

  dockerInfo();

  for (const forbidden of ENTERPRISE_PROMETHEUS_FORBIDDEN_FLAGS) {
    if (flags.includes(forbidden)) {
      throw new Error(`Forbidden Prometheus flag present: ${forbidden}`);
    }
  }

  const helpText = readPrometheusHelp(image);
  for (const flag of flags) {
    if (flag.startsWith('--config.file')) continue;
    if (!flagSupportedInHelp(helpText, flag)) {
      throw new Error(
        `Prometheus image ${image} does not advertise support for runtime flag ${flag}`,
      );
    }
  }

  const promConfig = resolvePrometheusConfigPath(repositoryRoot);
  const rulesPath = resolveAlertRulesPath(repositoryRoot);
  if (!existsSync(promConfig) || !existsSync(rulesPath)) {
    throw new Error('Prometheus config or rules missing for runtime validation');
  }

  const containerName = `enterprise-prom-runtime-${Date.now()}`;
  const rulesDir = path.dirname(rulesPath);
  let readyHttpStatus = 0;
  let primaryError: unknown;
  let result: PrometheusRuntimeValidationResult | undefined;

  try {
    execFileSync(
      'docker',
      [
        'run',
        '-d',
        '--name',
        containerName,
        '-p',
        '127.0.0.1:0:9090',
        '-v',
        `${promConfig}:/etc/prometheus/prometheus.yml:ro`,
        '-v',
        `${rulesDir}:/etc/prometheus/rules:ro`,
        image,
        ...flags,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 },
    );

    const portLine = execFileSync('docker', ['port', containerName, '9090'], {
      encoding: 'utf8',
      timeout: 10_000,
    }).trim();
    const hostPort = portLine.split(':').pop();
    if (!hostPort) throw new Error(`Could not resolve published port for ${containerName}`);

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const code = execFileSync(
          'curl',
          ['-sS', '-o', '/dev/null', '-w', '%{http_code}', `http://127.0.0.1:${hostPort}/-/ready`],
          { encoding: 'utf8', timeout: 5_000 },
        ).trim();
        readyHttpStatus = Number(code);
        if (readyHttpStatus === 200) break;
      } catch {
        // retry
      }
      await sleepMs(200);
    }

    if (readyHttpStatus !== 200) {
      let logs = '';
      try {
        logs = execFileSync('docker', ['logs', containerName], {
          encoding: 'utf8',
          timeout: 10_000,
        });
      } catch {
        /* ignore log fetch failures */
      }
      throw new Error(
        `Prometheus runtime did not become ready (http ${readyHttpStatus}). logs:\n${logs.slice(0, 2000)}`,
      );
    }

    const rulesJson = execFileSync('curl', ['-sS', `http://127.0.0.1:${hostPort}/api/v1/rules`], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    if (!rulesJson.includes('enterprise-platform')) {
      throw new Error('Prometheus started but enterprise-platform rule group is missing');
    }

    result = {
      flags,
      helpChecked: true,
      image,
      readyHttpStatus,
      started: true,
    };
  } catch (error) {
    primaryError = error;
  } finally {
    const cleanup = cleanupProbeResources(
      { containers: [containerName] },
      { injectContainerRmError: options?.injectContainerRmError },
    );
    if (primaryError) {
      throwWithCleanup(primaryError, cleanup);
    }
    assertCleanupClean(cleanup);
  }

  if (!result) {
    throw new Error('Prometheus runtime validation completed without result (fail closed)');
  }
  return result;
};

export const assertForbiddenPrometheusFlagsRejected = (
  image: string = ENTERPRISE_PROMETHEUS_IMAGE,
): void => {
  dockerInfo();
  for (const flag of ENTERPRISE_PROMETHEUS_FORBIDDEN_FLAGS) {
    try {
      execFileSync('docker', ['run', '--rm', image, flag, '--version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      });
      throw new Error(`Expected ${image} to reject ${flag}, but the process succeeded`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Expected')) throw error;
      const err = error as { stderr?: string; stdout?: string; message?: string };
      const text = [err.stdout, err.stderr, err.message].filter(Boolean).join('\n');
      if (/unknown long flag|unknown flag|Error parsing command line/i.test(text)) {
        continue;
      }
      if (/unknown/i.test(text)) continue;
      throw new Error(`Unexpected failure probing forbidden flag ${flag}:\n${text}`, {
        cause: error,
      });
    }
  }
};
