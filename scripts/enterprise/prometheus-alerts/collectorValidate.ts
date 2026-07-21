import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { assertEnterprisePrometheusComposeWiring } from './composeWiring';
import {
  ENTERPRISE_OTEL_COLLECTOR_CONFIG_CONTAINER_PATH,
  ENTERPRISE_OTEL_COLLECTOR_IMAGE,
  resolveCollectorConfigPath,
  resolveRepositoryRoot,
} from './constants';

export interface CollectorValidationResult {
  image: string;
  stdout: string;
  validated: true;
}

const dockerInfo = (): void => {
  try {
    execFileSync('docker', ['info'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000,
    });
  } catch (error) {
    throw new Error(
      `Docker is required for collector config validation (fail closed): ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
};

/**
 * Authoritative collector config validation via the pinned contrib image `validate` command.
 */
export const validateEnterpriseCollectorConfig = (options?: {
  image?: string;
  repositoryRoot?: string;
}): CollectorValidationResult => {
  const repositoryRoot = options?.repositoryRoot ?? resolveRepositoryRoot();
  const image = options?.image ?? ENTERPRISE_OTEL_COLLECTOR_IMAGE;
  const configPath = resolveCollectorConfigPath(repositoryRoot);

  // Structural pipeline checks first (fast drift).
  assertEnterprisePrometheusComposeWiring(repositoryRoot);

  if (!existsSync(configPath)) {
    throw new Error(`Collector config missing: ${configPath}`);
  }

  dockerInfo();

  try {
    const stdout = execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '-v',
        `${configPath}:${ENTERPRISE_OTEL_COLLECTOR_CONFIG_CONTAINER_PATH}:ro`,
        image,
        'validate',
        `--config=${ENTERPRISE_OTEL_COLLECTOR_CONFIG_CONTAINER_PATH}`,
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
      },
    );
    return { image, stdout, validated: true };
  } catch (error) {
    const err = error as { stderr?: string; stdout?: string; message?: string };
    const combined = [err.stdout, err.stderr, err.message].filter(Boolean).join('\n');
    throw new Error(
      `otelcol validate failed (fail closed) using ${image} on ${configPath}:\n${combined}`,
      { cause: error },
    );
  }
};

/** CLI entry for collector validation. */
export const main = (argv: string[] = process.argv.slice(2)): number => {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      [
        'Usage: bun run scripts/enterprise/prometheus-alerts/collectorValidate.ts',
        '',
        `Runs \`${ENTERPRISE_OTEL_COLLECTOR_IMAGE} validate\` against the reference collector config.`,
      ].join('\n'),
    );
    return 0;
  }
  const result = validateEnterpriseCollectorConfig();
  if (result.stdout.trim()) process.stdout.write(result.stdout);
  console.log(`✓ collector config validated (${result.image})`);
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
