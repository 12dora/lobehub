import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Pinned Prometheus image used for compose and for authoritative `promtool check rules`. */
export const ENTERPRISE_PROMETHEUS_IMAGE = 'prom/prometheus:v2.55.1' as const;

/** Rule file relative to repository root. */
export const ENTERPRISE_ALERT_RULES_RELATIVE_PATH =
  'docker-compose/production/grafana/prometheus/rules/enterprise-platform-alerts.yml' as const;

/** Prometheus config relative to repository root. */
export const ENTERPRISE_PROMETHEUS_CONFIG_RELATIVE_PATH =
  'docker-compose/production/grafana/prometheus/prometheus.yml' as const;

/** Grafana production compose file relative to repository root. */
export const ENTERPRISE_GRAFANA_COMPOSE_RELATIVE_PATH =
  'docker-compose/production/grafana/docker-compose.yml' as const;

/** Container path where compose mounts the rules directory (read-only). */
export const ENTERPRISE_ALERT_RULES_CONTAINER_DIR = '/etc/prometheus/rules' as const;

/** Container path where compose mounts prometheus.yml (read-only). */
export const ENTERPRISE_PROMETHEUS_CONFIG_CONTAINER_PATH =
  '/etc/prometheus/prometheus.yml' as const;

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repository root (scripts/enterprise/prometheus-alerts → ../../..). */
export const resolveRepositoryRoot = (from: string = here): string =>
  path.resolve(from, '../../..');

export const resolveAlertRulesPath = (repositoryRoot: string): string =>
  path.join(repositoryRoot, ENTERPRISE_ALERT_RULES_RELATIVE_PATH);

export const resolvePrometheusConfigPath = (repositoryRoot: string): string =>
  path.join(repositoryRoot, ENTERPRISE_PROMETHEUS_CONFIG_RELATIVE_PATH);

export const resolveGrafanaComposePath = (repositoryRoot: string): string =>
  path.join(repositoryRoot, ENTERPRISE_GRAFANA_COMPOSE_RELATIVE_PATH);
