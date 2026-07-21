# Runbook: Enterprise Prometheus reference alerts

**Owner role:** `platform-sre` (thresholds / routing) · `enterprise-platform` (metric semantics)\
**Scope:** Checked-in reference rules only — **not** a claim that alerts are deployed or that notifications are configured.

## What shipped in-repo

| Artifact                          | Path                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Reference rules                   | `docker-compose/production/grafana/prometheus/rules/enterprise-platform-alerts.yml`                    |
| Prometheus config (`rule_files`)  | `docker-compose/production/grafana/prometheus/prometheus.yml`                                          |
| Compose mount (read-only)         | `docker-compose/production/grafana/docker-compose.yml` → `./prometheus/rules:/etc/prometheus/rules:ro` |
| Intent ↔ rule metadata            | `apps/server/src/enterprise/observability/alertIntents.ts` (`status: reference-rule`)                  |
| Authoritative rule validator      | `bun run enterprise:check-prometheus-rules` → `promtool check rules` in `prom/prometheus:v2.55.1`      |
| Collector config validator        | `bun run enterprise:check-otel-collector` → pinned `otel/opentelemetry-collector-contrib:0.120.0`      |
| OTLP→Prometheus translation probe | `bun run enterprise:probe-otlp-prometheus` (disposable Docker; fail closed; no residue)                |

Intent metadata is **1:1** with YAML `alert:` names. Unit tests reconcile keys, metrics, and identities; they do **not** replace `promtool`.

## Explicit non-goals

- **No Alertmanager (or other) receiver** is configured in the reference compose stack.
- A **firing rule without a receiver is still observable** in the Prometheus UI (`/alerts`, `/rules`).
- **Production notifications, routing trees, inhibition, and silences are deployment-owned.** Do not treat the reference defaults as production policy, and do not claim production deployment from this repository path alone.
- Metrics emission (OTel) remains independent of alerting backends. Without a scrape/remote-write path, rules evaluate empty series and stay inactive.

## Validate rules (local / CI)

```bash
# Fail closed if Docker or validation is unavailable, or if YAML/PromQL/config is invalid.
bun run enterprise:check-prometheus-rules
bun run enterprise:check-otel-collector
bun run enterprise:probe-otlp-prometheus

# Compose structure (does not start the stack)
docker compose -f docker-compose/production/grafana/docker-compose.yml --env-file docker-compose/production/grafana/.env.example config --quiet
```

Focused tests (reconciliation + promtool + runtime + OTLP probe):

```bash
bunx vitest run --silent='passed-only' \
  apps/server/src/enterprise/observability/alertIntents.test.ts \
  scripts/enterprise/prometheus-alerts/checkRules.test.ts
```

## Threshold and window tuning

All windows, thresholds, and `for` durations in the YAML are **reference defaults**. Before production use:

1. Copy the rule file (or overlay) into deployment config management.
2. Adjust ratios / absolute rates using 7–14 days of baseline traffic.
3. Keep **zero-traffic guards** on ratio alerts (`and sum(rate(...)) > 0`) so idle clusters do not fire on Inf/NaN.
4. For **cluster snapshot gauges** (`job_backlog_oldest_age_seconds`, `revision_lag_instances`, `operational_snapshot_age_seconds`), aggregate with **`max`** (or `max by (...)` then `sum` for multi-reason lag). **Never `sum` across replicas** — every process may publish the same cluster snapshot.
5. Do **not** add high-cardinality labels (user, tenant, instance id, URL, raw error).

| Alert                                       | Intent key                     | Default signal (customize)               | Default `for` |
| ------------------------------------------- | ------------------------------ | ---------------------------------------- | ------------- |
| `EnterpriseConfigPublishFailureRatio`       | `publish_failure_ratio`        | failure ratio > 10% / 15m                | 10m           |
| `EnterpriseConfigPublishConflictRatio`      | `publish_conflict_ratio`       | conflict ratio > 20% / 15m               | 15m           |
| `EnterpriseInvalidationDegraded`            | `invalidation_degraded`        | any degraded invalidation rate > 0 / 10m | 10m           |
| `EnterpriseCacheFailureRate`                | `cache_failure_rate`           | load\_failure ratio > 10% / 10m          | 10m           |
| `EnterpriseGuardDenialSpike`                | `guard_denial_spike`           | denied rate > 1/s / 5m                   | 10m           |
| `EnterpriseHeartbeatFailure`                | `heartbeat_failure`            | failure rate > 0 / 5m                    | 5m            |
| `EnterpriseSsrfDenialSpike`                 | `ssrf_denial_spike`            | denial rate > 2/s / 5m                   | 10m           |
| `EnterpriseOidcLoginFailureRatio`           | `oidc_login_failure_ratio`     | failure ratio > 20% / 15m                | 10m           |
| `EnterpriseAgentMaterializationFailureRate` | `materialization_failure_rate` | failure ratio > 10% / 15m                | 10m           |
| `EnterpriseJobBacklogStalled`               | `job_backlog_stalled`          | max oldest age > 1800s                   | 15m           |
| `EnterpriseRevisionLag`                     | `revision_lag`                 | max-by-reason sum lag instances > 0      | 15m           |
| `EnterpriseOperationalCollectionStale`      | `operational_collection_stale` | max age > 180s **or** max ready == 0     | 5m            |

Severity labels (`critical` / `warning`) and `component` are stable defaults for routing keys — remap in the deployment overlay if your severity taxonomy differs.

## Notification receivers and routing (deployment-owned)

1. Deploy Alertmanager (or vendor equivalent) **outside** this reference file, or extend compose only in private overlays.
2. Point Prometheus `alerting.alertmanagers` at that receiver in **deployment** config — do not commit production webhook URLs or credentials here.
3. Route by `severity`, `component`, and optional deployment labels (`team`, `env`).
4. Page on `critical` (publish failures, heartbeat). Ticket/Slack on `warning` unless the deployment policy says otherwise.
5. Document ownership in the deployment runbook; this repository only provides PromQL references.

## Rollout / canary

1. Load rules in a non-production Prometheus first; confirm `promtool check rules` and UI `/rules` show the twelve alerts.
2. Canary with **elevated thresholds** or longer `for` to measure noise for 24–48h.
3. Inspect dashboards / Explore for the underlying series before tightening thresholds.
4. Only then attach notification receivers.
5. Roll forward by overlay version; keep the previous rule file for rollback.

## Inhibition and silence

- Prefer **silences** with explicit ticket IDs during planned maintenance (collector pause, Redis upgrade, IdP change windows).
- Use **inhibition** so a confirmed `EnterpriseHeartbeatFailure` can suppress dependent lag/backlog noise if that matches ops practice — define inhibition in Alertmanager, not in the rule file.
- Never silence without an expiry.

## Dashboard inspection

When an alert fires (or is pending):

1. Prometheus → **Alerts** / **Graph** the `expr` from the rule.
2. Confirm metric presence via OTLP → collector → Prometheus remote-write (compose example) or the deployment scrape path.
3. Admin System page (enterprise) for jobs / instance revisions — UI is complementary, not a substitute for PromQL.
4. Structured enterprise logs for failure classes only (no secrets / raw payloads).

## Rollback

1. Remove or revert the deployment overlay that loads `enterprise-platform-alerts.yml` (or raise thresholds to effectively disable).
2. Reload Prometheus (`/-/reload` if enabled, or restart).
3. Confirm `/rules` no longer evaluates the rolled-back group.
4. Leave metric emission unchanged — rolling back alerts does not require disabling OTel instruments.
5. Record the change in the deployment change log; do not delete historical firing evidence needed for postmortems.

## Per-alert operator notes

### EnterpriseConfigPublishFailureRatio

Check recent config publish/rollback operations, database health, and concurrent publishers. Metric: `enterprise_platform_config_publish_total{enterprise_outcome="failure"}`.

### EnterpriseConfigPublishConflictRatio

Conflicts (`enterprise_outcome=conflict`) usually mean optimistic concurrency contention. Identify overlapping admin sessions or automation.

### EnterpriseInvalidationDegraded

Outcomes `disabled|error|partial_failure|unavailable` on `enterprise_platform_invalidation_total`. Inspect Redis connectivity and invalidation backend mode.

### EnterpriseCacheFailureRate

`enterprise_platform_cache_load_total{enterprise_outcome="load_failure"}`. Database load path for branding/skill\_catalog caches.

### EnterpriseGuardDenialSpike

`enterprise_outcome=denied` on managed-resource guards. May be legitimate policy — tune absolute rate to baseline before paging.

### EnterpriseHeartbeatFailure

`enterprise_platform_instance_heartbeat_total{enterprise_outcome="failure"}`. Instance registration/tick failures break multi-instance convergence views.

### EnterpriseSsrfDenialSpike

`enterprise_platform_ssrf_denial_total` by closed `enterprise_category`. Distinguish scanners from allowlist regressions.

### EnterpriseOidcLoginFailureRatio

`enterprise_platform_oidc_login_total{enterprise_outcome="failure"}`. Use closed `enterprise_failure_category` / `enterprise_stage` only — no tokens in metrics.

### EnterpriseAgentMaterializationFailureRate

`enterprise_platform_agent_materialization_total{enterprise_outcome="failure"}`. Check agent catalog publication and materialization job health.

### EnterpriseJobBacklogStalled

`max(enterprise_platform_job_backlog_oldest_age_seconds)`. Worker saturation, claim failures, or collector correctness. **Use max, not sum.**

### EnterpriseRevisionLag

Identity domain lag after the rollout window. `max by (enterprise_domain, enterprise_reason)` then sum. Confirm heartbeats and revision reporters.

### EnterpriseOperationalCollectionStale

Fires when **either**:

1. `max(enterprise_platform_operational_snapshot_ready) == 0` — active collectors never produced a first successful snapshot (the **age gauge is absent** until first success; ready still emits 0), or
2. `max(enterprise_platform_operational_snapshot_age_seconds) > 180` — a snapshot existed but became stale.

Aggregate replicas with **max**, never sum. Job backlog and revision-lag gauges stop reflecting production if collection stalls.

## Related

- Module boundary: `apps/server/src/enterprise/observability/README.md`
- Instruments: `packages/observability-otel/src/modules/enterprise-platform`
- Compose observability guide: `docs/self-hosting/advanced/observability/grafana.mdx`
