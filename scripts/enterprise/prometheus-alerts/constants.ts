import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Pinned Prometheus image used for compose, promtool, and runtime startup validation. */
export const ENTERPRISE_PROMETHEUS_IMAGE = 'prom/prometheus:v2.55.1' as const;

/**
 * Pinned OTel Collector contrib image (prometheusremotewrite lives in contrib, not core).
 * Keep in lockstep with docker-compose/production/grafana/docker-compose.yml.
 */
export const ENTERPRISE_OTEL_COLLECTOR_IMAGE =
  'otel/opentelemetry-collector-contrib:0.120.0' as const;

/** Flags required on the pinned Prometheus runtime (must appear in image --help). */
export const ENTERPRISE_PROMETHEUS_REQUIRED_FLAGS = [
  '--config.file=/etc/prometheus/prometheus.yml',
  '--web.enable-remote-write-receiver',
  '--enable-feature=exemplar-storage',
] as const;

/**
 * Flags that must never appear for the pinned Prometheus version.
 * `--web.enable-otlp-receiver` is unsupported on v2.55.1 and prevents process start.
 */
export const ENTERPRISE_PROMETHEUS_FORBIDDEN_FLAGS = ['--web.enable-otlp-receiver'] as const;

/** Rule file relative to repository root. */
export const ENTERPRISE_ALERT_RULES_RELATIVE_PATH =
  'docker-compose/production/grafana/prometheus/rules/enterprise-platform-alerts.yml' as const;

/** Prometheus config relative to repository root. */
export const ENTERPRISE_PROMETHEUS_CONFIG_RELATIVE_PATH =
  'docker-compose/production/grafana/prometheus/prometheus.yml' as const;

/** Collector config relative to repository root. */
export const ENTERPRISE_OTEL_COLLECTOR_CONFIG_RELATIVE_PATH =
  'docker-compose/production/grafana/otel-collector/collector-config.yaml' as const;

/** Grafana production compose file relative to repository root. */
export const ENTERPRISE_GRAFANA_COMPOSE_RELATIVE_PATH =
  'docker-compose/production/grafana/docker-compose.yml' as const;

/** Container path where compose mounts the rules directory (read-only). */
export const ENTERPRISE_ALERT_RULES_CONTAINER_DIR = '/etc/prometheus/rules' as const;

/** Container path where compose mounts prometheus.yml (read-only). */
export const ENTERPRISE_PROMETHEUS_CONFIG_CONTAINER_PATH =
  '/etc/prometheus/prometheus.yml' as const;

/** Container path where compose mounts the collector config (read-only). */
export const ENTERPRISE_OTEL_COLLECTOR_CONFIG_CONTAINER_PATH = '/etc/otelcol/config.yaml' as const;

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repository root (scripts/enterprise/prometheus-alerts → ../../..). */
export const resolveRepositoryRoot = (from: string = here): string =>
  path.resolve(from, '../../..');

export const resolveAlertRulesPath = (repositoryRoot: string): string =>
  path.join(repositoryRoot, ENTERPRISE_ALERT_RULES_RELATIVE_PATH);

export const resolvePrometheusConfigPath = (repositoryRoot: string): string =>
  path.join(repositoryRoot, ENTERPRISE_PROMETHEUS_CONFIG_RELATIVE_PATH);

export const resolveCollectorConfigPath = (repositoryRoot: string): string =>
  path.join(repositoryRoot, ENTERPRISE_OTEL_COLLECTOR_CONFIG_RELATIVE_PATH);

export const resolveGrafanaComposePath = (repositoryRoot: string): string =>
  path.join(repositoryRoot, ENTERPRISE_GRAFANA_COMPOSE_RELATIVE_PATH);
