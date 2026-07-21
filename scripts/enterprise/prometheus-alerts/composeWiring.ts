import { readFileSync } from 'node:fs';

import {
  ENTERPRISE_ALERT_RULES_CONTAINER_DIR,
  ENTERPRISE_ALERT_RULES_RELATIVE_PATH,
  ENTERPRISE_OTEL_COLLECTOR_CONFIG_CONTAINER_PATH,
  ENTERPRISE_OTEL_COLLECTOR_IMAGE,
  ENTERPRISE_PROMETHEUS_CONFIG_CONTAINER_PATH,
  ENTERPRISE_PROMETHEUS_FORBIDDEN_FLAGS,
  ENTERPRISE_PROMETHEUS_IMAGE,
  ENTERPRISE_PROMETHEUS_REQUIRED_FLAGS,
  resolveCollectorConfigPath,
  resolveGrafanaComposePath,
  resolvePrometheusConfigPath,
  resolveRepositoryRoot,
} from './constants';

export interface ComposeWiringReport {
  collectorImage: string;
  composePath: string;
  metricsPipeline: { exporters: string[]; receivers: string[] };
  prometheusCommand: string[];
  prometheusConfigPath: string;
  prometheusImage: string;
  ruleFilesGlob: string;
  rulesHostPathFragment: string;
}

const extractServiceBlock = (compose: string, serviceName: string): string => {
  const lines = compose.split('\n');
  const start = lines.findIndex((line) => line.match(new RegExp(`^  ${serviceName}:\\s*$`)));
  if (start < 0) throw new Error(`compose missing service ${serviceName}`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {2}[a-z0-9][\w-]*:\s*$/.test(lines[index]!)) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
};

const extractCommandFlags = (serviceBlock: string): string[] => {
  const flags: string[] = [];
  for (const line of serviceBlock.split('\n')) {
    const match = line.match(/^\s+-\s+'([^']+)'\s*$/) ?? line.match(/^\s+-\s+"([^"]+)"\s*$/);
    if (match?.[1]?.startsWith('--')) flags.push(match[1]);
  }
  return flags;
};

/**
 * Assert compose + prometheus.yml + collector config wire the enterprise reference stack.
 * Fail closed on missing mounts, wrong pins, forbidden Prometheus flags, or broken metrics pipeline.
 */
export const assertEnterprisePrometheusComposeWiring = (
  repositoryRoot: string = resolveRepositoryRoot(),
): ComposeWiringReport => {
  const composePath = resolveGrafanaComposePath(repositoryRoot);
  const prometheusConfigPath = resolvePrometheusConfigPath(repositoryRoot);
  const collectorConfigPath = resolveCollectorConfigPath(repositoryRoot);
  const compose = readFileSync(composePath, 'utf8');
  const prometheusConfig = readFileSync(prometheusConfigPath, 'utf8');
  const collectorConfig = readFileSync(collectorConfigPath, 'utf8');

  if (!compose.includes(ENTERPRISE_PROMETHEUS_IMAGE)) {
    throw new Error(
      `docker-compose must pin Prometheus image ${ENTERPRISE_PROMETHEUS_IMAGE} (found compose without pin)`,
    );
  }
  if (!compose.includes(ENTERPRISE_OTEL_COLLECTOR_IMAGE)) {
    throw new Error(
      `docker-compose must pin OTel collector image ${ENTERPRISE_OTEL_COLLECTOR_IMAGE}`,
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

  const collectorMount = `./otel-collector/collector-config.yaml:${ENTERPRISE_OTEL_COLLECTOR_CONFIG_CONTAINER_PATH}:ro`;
  if (!compose.includes(collectorMount)) {
    throw new Error(`docker-compose must mount collector config read-only as ${collectorMount}`);
  }

  if (
    !/rule_files:[\t\v\f\r \xA0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]*\n\s*-\s*\/etc\/prometheus\/rules\/enterprise-platform-alerts\.yml/.test(
      prometheusConfig,
    )
  ) {
    throw new Error(
      'prometheus.yml must declare rule_files: /etc/prometheus/rules/enterprise-platform-alerts.yml (not a bare *.yml glob that would load *.test.yml fixtures)',
    );
  }

  if (
    /alertmanager_config|alerting:[\t\v\f\r \xA0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]*\n\s*alertmanagers:/.test(
      prometheusConfig,
    )
  ) {
    throw new Error(
      'prometheus.yml must not configure Alertmanager receivers in the reference stack (deployment-owned)',
    );
  }

  const prometheusBlock = extractServiceBlock(compose, 'prometheus');
  const prometheusCommand = extractCommandFlags(prometheusBlock);
  for (const flag of ENTERPRISE_PROMETHEUS_REQUIRED_FLAGS) {
    if (!prometheusCommand.includes(flag)) {
      throw new Error(`prometheus service must pass runtime flag ${flag}`);
    }
  }
  for (const flag of ENTERPRISE_PROMETHEUS_FORBIDDEN_FLAGS) {
    // Only command entries count — comments may mention the forbidden flag by name.
    if (prometheusCommand.includes(flag)) {
      throw new Error(
        `prometheus service must not pass unsupported flag ${flag} for ${ENTERPRISE_PROMETHEUS_IMAGE}`,
      );
    }
  }

  // Collector metrics pipeline: OTLP + prometheus scrape → prometheusremotewrite.
  if (!collectorConfig.includes('prometheusremotewrite:')) {
    throw new Error('collector config must declare prometheusremotewrite exporter');
  }
  if (/\blogging:\s*$/m.test(collectorConfig)) {
    throw new Error('collector config must not use deprecated logging exporter alias; use debug');
  }
  if (!collectorConfig.includes('debug:')) {
    throw new Error('collector config must use canonical debug exporter id');
  }

  // Match the metrics pipeline block: indented lines under `metrics:`.
  const metricsSectionMatch = collectorConfig.match(/metrics:\s*\n((?:[ \t].+\n)+)/u);
  if (!metricsSectionMatch) {
    throw new Error('collector config missing metrics pipeline');
  }
  const metricsSection = metricsSectionMatch[1] ?? '';
  const receiversMatch = metricsSection.match(/receivers:\s*\[([^\]]+)\]/u);
  const exportersMatch = metricsSection.match(/exporters:\s*\[([^\]]+)\]/u);
  if (!receiversMatch?.[1]) {
    throw new Error('collector metrics pipeline missing receivers');
  }
  if (!exportersMatch?.[1]) {
    throw new Error('collector metrics pipeline missing exporters');
  }
  const receivers = receiversMatch[1].split(',').map((part) => part.trim());
  const exporters = exportersMatch[1].split(',').map((part) => part.trim());
  if (!receivers.includes('otlp')) {
    throw new Error(
      'collector metrics pipeline must include otlp receiver so app enterprise metrics reach Prometheus',
    );
  }
  if (!exporters.includes('prometheusremotewrite')) {
    throw new Error('collector metrics pipeline must export to prometheusremotewrite');
  }

  return {
    collectorImage: ENTERPRISE_OTEL_COLLECTOR_IMAGE,
    composePath,
    metricsPipeline: { exporters, receivers },
    prometheusCommand,
    prometheusConfigPath,
    prometheusImage: ENTERPRISE_PROMETHEUS_IMAGE,
    ruleFilesGlob: '/etc/prometheus/rules/enterprise-platform-alerts.yml',
    rulesHostPathFragment: './prometheus/rules',
  };
};
