import { readFileSync } from 'node:fs';

import { parse as parseYaml } from 'yaml';

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

type ComposeVolumeLong = {
  read_only?: boolean;
  source?: string;
  target?: string;
  type?: string;
};

type ComposeService = {
  command?: string | string[];
  image?: string;
  volumes?: Array<string | ComposeVolumeLong>;
};

type ComposeDocument = {
  services?: Record<string, ComposeService | undefined>;
};

/** Parsed bind mount with exact source/target and read-only mode. */
type ParsedVolumeMount = {
  readOnly: boolean;
  source: string;
  target: string;
};

const asStringArray = (command: string | string[] | undefined): string[] => {
  if (!command) return [];
  if (Array.isArray(command)) return command.map(String);
  // YAML scalar form: "prometheus --config.file=..."
  return String(command).split(/\s+/u).filter(Boolean);
};

/**
 * Parse a Compose volume entry (short `src:target[:mode]` or long-form object).
 * Returns null when the entry cannot be interpreted as a bind-style mount.
 */
const parseVolumeMount = (entry: string | ComposeVolumeLong): ParsedVolumeMount | null => {
  if (typeof entry !== 'string') {
    const source = entry.source?.trim() ?? '';
    const target = entry.target?.trim() ?? '';
    if (!source || !target) return null;
    return {
      readOnly: entry.read_only === true,
      source,
      target,
    };
  }

  const raw = entry.trim();
  if (!raw) return null;

  // Short syntax: source:target[:ACCESS_MODE]. ACCESS_MODE is a comma-separated
  // list (Compose): ro/rw plus SELinux z/Z, consistency cached/delegated/consistent,
  // propagation private/rprivate/shared/…, etc. Split from the right so Windows-style
  // drive sources still work if present.
  const segments = raw.split(':');
  if (segments.length < 2) return null;

  const knownModeTokens = new Set([
    'ro',
    'rw',
    'rro',
    'z',
    'Z',
    'cached',
    'delegated',
    'consistent',
    'private',
    'rprivate',
    'shared',
    'rshared',
    'slave',
    'rslave',
    'nocopy',
  ]);
  let modeTokens: string[] = [];
  let target: string;
  let source: string;

  const last = segments.at(-1) ?? '';
  const candidateTokens = last
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
  const lastIsAccessMode =
    segments.length >= 3 &&
    candidateTokens.length > 0 &&
    candidateTokens.every((token) => knownModeTokens.has(token));

  if (lastIsAccessMode) {
    modeTokens = candidateTokens;
    target = segments.at(-2) ?? '';
    source = segments.slice(0, -2).join(':');
  } else {
    target = segments.at(-1) ?? '';
    source = segments.slice(0, -1).join(':');
  }

  if (!source || !target) return null;
  return {
    // Read-only when any ACCESS_MODE token is ro/rro (e.g. `ro,Z` or `z,ro`).
    readOnly: modeTokens.includes('ro') || modeTokens.includes('rro'),
    source,
    target,
  };
};

/**
 * Exact mount match: source path, container target path, and read-only when required.
 * Substring / wrong-target / missing `:ro` must not satisfy the gate.
 */
const serviceHasMount = (
  service: ComposeService,
  expected: { readOnly?: boolean; source: string; target: string },
): boolean => {
  const volumes = service.volumes ?? [];
  return volumes.some((entry) => {
    const parsed = parseVolumeMount(entry);
    if (!parsed) return false;
    if (parsed.source !== expected.source) return false;
    if (parsed.target !== expected.target) return false;
    if (expected.readOnly && !parsed.readOnly) return false;
    return true;
  });
};

/**
 * Assert compose + prometheus.yml + collector config wire the enterprise reference stack.
 * Fail closed on missing mounts, wrong pins, forbidden Prometheus flags, or broken metrics pipeline.
 *
 * Image / command / volume checks use parsed YAML service blocks — not whole-file string includes —
 * so pins in comments or unrelated services cannot satisfy the gate.
 */
export const assertEnterprisePrometheusComposeWiring = (
  repositoryRoot: string = resolveRepositoryRoot(),
): ComposeWiringReport => {
  const composePath = resolveGrafanaComposePath(repositoryRoot);
  const prometheusConfigPath = resolvePrometheusConfigPath(repositoryRoot);
  const collectorConfigPath = resolveCollectorConfigPath(repositoryRoot);
  const composeText = readFileSync(composePath, 'utf8');
  const prometheusConfig = readFileSync(prometheusConfigPath, 'utf8');
  const collectorConfig = readFileSync(collectorConfigPath, 'utf8');

  let compose: ComposeDocument;
  try {
    compose = parseYaml(composeText) as ComposeDocument;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`docker-compose YAML parse failed: ${message}`, { cause: error });
  }

  const services = compose.services ?? {};
  const prometheusService = services.prometheus;
  const collectorService = services['otel-collector'] ?? services.otelcollector;
  if (!prometheusService || typeof prometheusService !== 'object') {
    throw new Error('docker-compose missing services.prometheus');
  }
  if (!collectorService || typeof collectorService !== 'object') {
    throw new Error('docker-compose missing services.otel-collector');
  }

  if (prometheusService.image !== ENTERPRISE_PROMETHEUS_IMAGE) {
    throw new Error(
      `services.prometheus.image must pin ${ENTERPRISE_PROMETHEUS_IMAGE} (got ${String(prometheusService.image ?? 'missing')})`,
    );
  }
  if (collectorService.image !== ENTERPRISE_OTEL_COLLECTOR_IMAGE) {
    throw new Error(
      `services.otel-collector.image must pin ${ENTERPRISE_OTEL_COLLECTOR_IMAGE} (got ${String(collectorService.image ?? 'missing')})`,
    );
  }

  const rulesMount = `./prometheus/rules:${ENTERPRISE_ALERT_RULES_CONTAINER_DIR}:ro`;
  if (
    !serviceHasMount(prometheusService, {
      readOnly: true,
      source: './prometheus/rules',
      target: ENTERPRISE_ALERT_RULES_CONTAINER_DIR,
    })
  ) {
    throw new Error(
      `services.prometheus must mount rules read-only as ${rulesMount} so Prometheus can load ${ENTERPRISE_ALERT_RULES_RELATIVE_PATH}`,
    );
  }

  const configMount = `./prometheus/prometheus.yml:${ENTERPRISE_PROMETHEUS_CONFIG_CONTAINER_PATH}:ro`;
  if (
    !serviceHasMount(prometheusService, {
      readOnly: true,
      source: './prometheus/prometheus.yml',
      target: ENTERPRISE_PROMETHEUS_CONFIG_CONTAINER_PATH,
    })
  ) {
    throw new Error(`services.prometheus must mount prometheus.yml read-only as ${configMount}`);
  }

  const collectorMount = `./otel-collector/collector-config.yaml:${ENTERPRISE_OTEL_COLLECTOR_CONFIG_CONTAINER_PATH}:ro`;
  if (
    !serviceHasMount(collectorService, {
      readOnly: true,
      source: './otel-collector/collector-config.yaml',
      target: ENTERPRISE_OTEL_COLLECTOR_CONFIG_CONTAINER_PATH,
    })
  ) {
    throw new Error(
      `services.otel-collector must mount collector config read-only as ${collectorMount}`,
    );
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

  const prometheusCommand = asStringArray(prometheusService.command).filter((part) =>
    part.startsWith('--'),
  );
  for (const flag of ENTERPRISE_PROMETHEUS_REQUIRED_FLAGS) {
    if (!prometheusCommand.includes(flag)) {
      throw new Error(`prometheus service must pass runtime flag ${flag}`);
    }
  }
  for (const flag of ENTERPRISE_PROMETHEUS_FORBIDDEN_FLAGS) {
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
    collectorImage: collectorService.image ?? ENTERPRISE_OTEL_COLLECTOR_IMAGE,
    composePath,
    metricsPipeline: { exporters, receivers },
    prometheusCommand,
    prometheusConfigPath,
    prometheusImage: prometheusService.image ?? ENTERPRISE_PROMETHEUS_IMAGE,
    ruleFilesGlob: '/etc/prometheus/rules/enterprise-platform-alerts.yml',
    rulesHostPathFragment: './prometheus/rules',
  };
};
