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

export interface PromtoolTestResult {
  image: string;
  stdout: string;
  testPath: string;
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
      `Docker is required to run promtool (fail closed). docker info failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
};

/**
 * Run authoritative `promtool check rules` via the pinned Prometheus container.
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
    const err = error as { message?: string; stderr?: string; stdout?: string };
    const combined = [err.stdout, err.stderr, err.message ?? String(error)]
      .filter(Boolean)
      .join('\n');
    throw new Error(
      `promtool check rules failed (fail closed) using ${image} on ${rulesPath}:\n${combined}`,
      { cause: error },
    );
  }
};

/**
 * Run authoritative `promtool test rules` semantic fixtures for the reference rules.
 */
export const testEnterprisePrometheusRules = (options?: {
  image?: string;
  repositoryRoot?: string;
  testPath?: string;
}): PromtoolTestResult => {
  const repositoryRoot = options?.repositoryRoot ?? resolveRepositoryRoot();
  const rulesPath = resolveAlertRulesPath(repositoryRoot);
  const testPath =
    options?.testPath ?? path.join(path.dirname(rulesPath), 'enterprise-platform-alerts.test.yml');
  const image = options?.image ?? ENTERPRISE_PROMETHEUS_IMAGE;

  if (!existsSync(testPath)) {
    throw new Error(`Enterprise alert rule test file is missing: ${testPath}`);
  }
  if (!existsSync(rulesPath)) {
    throw new Error(`Enterprise alert rules file is missing: ${rulesPath}`);
  }

  dockerInfo();

  const rulesDir = path.dirname(rulesPath);
  const testFileName = path.basename(testPath);
  const containerTestPath = path.posix.join(ENTERPRISE_ALERT_RULES_CONTAINER_DIR, testFileName);

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
        'test',
        'rules',
        containerTestPath,
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 180_000,
      },
    );
    return { image, stdout, testPath };
  } catch (error) {
    const err = error as { message?: string; stderr?: string; stdout?: string };
    const combined = [err.stdout, err.stderr, err.message ?? String(error)]
      .filter(Boolean)
      .join('\n');
    throw new Error(
      `promtool test rules failed (fail closed) using ${image} on ${testPath}:\n${combined}`,
      { cause: error },
    );
  }
};

export const main = (argv: string[] = process.argv.slice(2)): number => {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      [
        'Usage: bun run scripts/enterprise/prometheus-alerts/checkRules.ts [--test]',
        '',
        `Runs promtool check rules (and optionally test rules) in ${ENTERPRISE_PROMETHEUS_IMAGE}.`,
      ].join('\n'),
    );
    return 0;
  }

  const check = checkEnterprisePrometheusRules();
  process.stdout.write(check.stdout);
  if (!check.stdout.endsWith('\n')) process.stdout.write('\n');
  console.log(`✓ promtool check rules passed (${check.image})`);

  // Always run semantic fixtures with check — both are required gates.
  const tested = testEnterprisePrometheusRules();
  process.stdout.write(tested.stdout);
  if (!tested.stdout.endsWith('\n')) process.stdout.write('\n');
  console.log(`✓ promtool test rules passed (${tested.image})`);
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
