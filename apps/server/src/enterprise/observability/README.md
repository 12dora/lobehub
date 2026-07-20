# Enterprise observability boundary

This module emits low-cardinality OpenTelemetry metrics and sanitized structured debug logs for
enterprise configuration operations. It does not configure an OTLP exporter or require OTLP
credentials; without an installed OpenTelemetry provider the API is naturally a no-op.

`ENTERPRISE_ALERT_INTENTS` is backend-neutral design metadata only. No alert rules, receivers,
notifications, or production alert backend are installed by this module. Deployments must select
thresholds, windows, routing, and ownership before any of these intents become active alerts.

Metrics never accept user, actor, resource, instance, request, IP, URL, error-message, or arbitrary
string labels. Structured logs are reserved for failures and degraded outcomes and pass through the
enterprise log redactor.
