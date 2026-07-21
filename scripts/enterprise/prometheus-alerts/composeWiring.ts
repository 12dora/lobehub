import { readFileSync } from 'node:fs';

import {
  ENTERPRISE_ALERT_RULES_CONTAINER_DIR,
  ENTERPRISE_ALERT_RULES_RELATIVE_PATH,
  ENTERPRISE_PROMETHEUS_CONFIG_CONTAINER_PATH,
  ENTERPRISE_PROMETHEUS_IMAGE,
  resolveGrafanaComposePath,
  resolvePrometheusConfigPath,
  resolveRepositoryRoot,
} from './constants';

export interface ComposeWiringReport {
  composePath: string;
  prometheusConfigPath: string;
  ruleFilesGlob: string;
  rulesHostPathFragment: string;
}

/**
 * Assert the production Grafana compose example loads the enterprise rules
 * from a read-only mount and that prometheus.yml declares rule_files.
 */
export const assertEnterprisePrometheusComposeWiring = (
  repositoryRoot: string = resolveRepositoryRoot(),
): ComposeWiringReport => {
  const composePath = resolveGrafanaComposePath(repositoryRoot);
  const prometheusConfigPath = resolvePrometheusConfigPath(repositoryRoot);
  const compose = readFileSync(composePath, 'utf8');
  const prometheusConfig = readFileSync(prometheusConfigPath, 'utf8');

  if (!compose.includes(ENTERPRISE_PROMETHEUS_IMAGE)) {
    throw new Error(
      `docker-compose must pin Prometheus image ${ENTERPRISE_PROMETHEUS_IMAGE} (found compose without pin)`,
    );
  }

  const rulesMount = `./prometheus/rules:${ENTERPRISE_ALERT_RULES_CONTAINER_DIR}:ro`;
  if (!compose.includes(rulesMount)) {
    throw new Error(
      `docker-compose must mount rules read-only as ${rulesMount} so Prometheus can load ${ENTERPRISE_ALERT_RULES_RELATIVE_PATH}`,
    );
  }

  const configMount = `./prometheus/prometheus.yml:${ENTERPRISE_PROMETHEUS_CONFIG_CONTAINER_PATH}:ro`;
  if (!compose.includes(configMount)) {
    throw new Error(`docker-compose must mount prometheus.yml read-only as ${configMount}`);
  }

  if (
    !/rule_files:[\t\v\f\r \xA0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]*\n\s*-\s*\/etc\/prometheus\/rules\/\*\.yml/.test(
      prometheusConfig,
    )
  ) {
    throw new Error(
      'prometheus.yml must declare rule_files: /etc/prometheus/rules/*.yml so compose loads enterprise rules',
    );
  }

  // Reference stack must not claim a notification backend.
  if (
    /alertmanager_config|alerting:[\t\v\f\r \xA0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]*\n\s*alertmanagers:/.test(
      prometheusConfig,
    )
  ) {
    throw new Error(
      'prometheus.yml must not configure Alertmanager receivers in the reference stack (deployment-owned)',
    );
  }

  return {
    composePath,
    prometheusConfigPath,
    ruleFilesGlob: '/etc/prometheus/rules/*.yml',
    rulesHostPathFragment: './prometheus/rules',
  };
};
