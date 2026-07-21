/**
 * Label translation helpers only — not a hand-maintained stimulus/oracle catalog.
 * Selector expectations come from parseSelectors + emissionContract builders.
 */

/** OTel attribute key → Prometheus label after remote-write (dots → underscores). */
export const OTEL_TO_PROMETHEUS_LABEL_TRANSFORM = (otelKey: string): string =>
  otelKey.replaceAll('.', '_');

/** Assert rule expressions use Prometheus underscore labels, not OTel dots. */
export const assertRuleExprUsesPrometheusLabels = (expr: string): void => {
  if (/\benterprise\.[a-z_]+\b/.test(expr)) {
    throw new Error(
      `Rule expr still uses dotted OTel attribute keys; Prometheus labels are underscored: ${expr.slice(0, 160)}`,
    );
  }
};

export const promqlInstantSelector = (metric: string, labels: Record<string, string>): string => {
  const matchers = Object.entries(labels)
    .map(([key, value]) => `${key}="${value}"`)
    .join(',');
  return matchers.length > 0 ? `${metric}{${matchers}}` : metric;
};
