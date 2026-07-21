import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  ENTERPRISE_ALERT_RULES_CONTAINER_DIR,
  ENTERPRISE_PROMETHEUS_IMAGE,
  resolveAlertRulesPath,
  resolveRepositoryRoot,
} from './constants';

export interface PromtoolCheckResult {
  image: string;
  rulesPath: string;
  stdout: string;
}

const dockerInfo = (): void => {
  try {
    execFileSync('docker', ['info'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Docker is required to run promtool check rules (fail closed). docker info failed: ${detail}`,
      { cause: error },
    );
  }
};

/**
 * Run authoritative `promtool check rules` via the pinned Prometheus container.
 * Fail closed when Docker, the image, or the rules are unavailable/invalid.
 */
export const checkEnterprisePrometheusRules = (options?: {
  image?: string;
  repositoryRoot?: string;
  rulesPath?: string;
}): PromtoolCheckResult => {
  const repositoryRoot = options?.repositoryRoot ?? resolveRepositoryRoot();
  const rulesPath = options?.rulesPath ?? resolveAlertRulesPath(repositoryRoot);
  const image = options?.image ?? ENTERPRISE_PROMETHEUS_IMAGE;

  if (!existsSync(rulesPath)) {
    throw new Error(`Enterprise alert rules file is missing: ${rulesPath}`);
  }

  dockerInfo();

  const rulesDir = path.dirname(rulesPath);
  const rulesFileName = path.basename(rulesPath);
  const containerRulesPath = path.posix.join(ENTERPRISE_ALERT_RULES_CONTAINER_DIR, rulesFileName);

  try {
    const stdout = execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '--entrypoint',
        'promtool',
        '-v',
        `${rulesDir}:${ENTERPRISE_ALERT_RULES_CONTAINER_DIR}:ro`,
        image,
        'check',
        'rules',
        containerRulesPath,
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 180_000,
      },
    );
    return { image, rulesPath, stdout };
  } catch (error) {
    const err = error as { message?: string; stderr?: string; stdout?: string; status?: number };
    const stdout = typeof err.stdout === 'string' ? err.stdout : '';
    const stderr = typeof err.stderr === 'string' ? err.stderr : '';
    const combined = [stdout, stderr, err.message ?? String(error)].filter(Boolean).join('\n');
    throw new Error(
      `promtool check rules failed (fail closed) using ${image} on ${rulesPath}:\n${combined}`,
      { cause: error },
    );
  }
};

/** CLI entry: exit 0 on success, non-zero on failure. */
export const main = (argv: string[] = process.argv.slice(2)): number => {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      [
        'Usage: bun run scripts/enterprise/prometheus-alerts/checkRules.ts',
        '',
        `Runs \`promtool check rules\` in ${ENTERPRISE_PROMETHEUS_IMAGE} against the`,
        'enterprise platform reference alert rules. Fail closed if Docker or validation',
        'is unavailable.',
      ].join('\n'),
    );
    return 0;
  }

  const result = checkEnterprisePrometheusRules();
  process.stdout.write(result.stdout);
  if (!result.stdout.endsWith('\n')) process.stdout.write('\n');
  console.log(`✓ promtool check rules passed (${result.image})`);
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
