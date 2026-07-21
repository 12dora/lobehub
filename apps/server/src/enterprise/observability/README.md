# Enterprise observability boundary

This module emits low-cardinality OpenTelemetry metrics and sanitized structured debug logs for
enterprise configuration operations. It does not configure an OTLP exporter or require OTLP
credentials; without an installed OpenTelemetry provider the API is naturally a no-op.

## Alert intents and reference rules

`ENTERPRISE_ALERT_INTENTS` is backend-neutral metadata with a **1:1** link to checked-in Prometheus
**reference rules** (`status: 'reference-rule'`, stable `ruleName`). The rule file is:

`docker-compose/production/grafana/prometheus/rules/enterprise-platform-alerts.yml`

Those rules are loaded by the production Grafana/Prometheus compose example (`rule_files` +
read-only `./prometheus/rules` mount). Validation is authoritative via:

- `bun run enterprise:check-prometheus-rules` — `promtool check rules` in pinned `prom/prometheus:v2.55.1`
- `bun run enterprise:check-otel-collector` — pinned `otel/opentelemetry-collector-contrib:0.120.0 validate`
- `bun run enterprise:probe-otlp-prometheus` — disposable OTLP→remote-write→PromQL label proof

Unit tests reconcile intent keys, metrics, rule identities, collector pipeline, and exact selectors
so metadata cannot drift from YAML; they do **not** replace promtool or the OTLP probe.

`EnterpriseOperationalCollectionStale` is gated by
`enterprise_platform_operational_collector_enabled` (0/1 for every known collector after
activate). Disabled collectors (enabled=0) do not false-alert. Enabled collectors fire on
ready==0 / absent ready / age>180. **No-data:** `absent(enabled{job_backlog})` means the required
collector-enabled signal is not reaching Prometheus — app/runtime down, activation never reached,
exporter/collector failure, remote-write/scrape/ingestion loss, or config omission are all
plausible and not distinguished. That branch deliberately fires after `for`; it does not stay
inactive when signals are missing. Semantic fixtures live in `promtool test rules`.

**Notification receivers and production routing are not configured in this repository.** A firing
rule without a receiver is still observable in the Prometheus UI. Deployments must own Alertmanager
(or equivalent) receivers, thresholds, windows, inhibition, silences, and on-call ownership before
treating reference defaults as production policy. This module does **not** claim that alerts were
deployed to production.

Operator guidance: `docs/enterprise/runbooks/enterprise-prometheus-alerts.md`.

## Operational gauges

The operational collector reads aggregate-only job backlog and production OIDC startup-instance
facts once per minute, then exposes the last successful in-memory snapshot through synchronous
observable gauges. Gauge callbacks never query the database. Revision lag is intentionally limited
to `identity` until other domains have production revision reporters; no status-service diagnostic
or cache-loading path is invoked for metrics.

Operational gauges use `enterprise.scope=cluster`. Every persistent process may publish the same
cluster snapshot, so dashboards and alert rules must aggregate replicas with `max` or select the
latest sample. Never `sum` these gauges across server replicas. Job type, instance ID, revision
token, and diagnostic identifiers are deliberately absent from metric labels.

## Redaction

Metrics never accept user, actor, resource, instance, request, IP, URL, error-message, or arbitrary
string labels. Structured logs are reserved for failures and degraded outcomes and pass through the
enterprise log redactor.
