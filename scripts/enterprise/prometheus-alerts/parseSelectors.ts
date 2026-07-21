import { extractMetricNamesFromExpr, parsePrometheusAlertRulesFile } from './parseRules';

export type MatcherOp = '=' | '=~' | '!=' | '!~';

export interface LabelMatcher {
  name: string;
  op: MatcherOp;
  value: string;
}

/** One metric selector occurrence extracted from a production alert expr. */
export interface RuleMetricSelector {
  alert: string;
  matchers: LabelMatcher[];
  metric: string;
  /** Instant PromQL selector for query proof (equality matchers only; regex uses first alternative). */
  querySelector: string;
}

const MATCHER_RE = /([a-z_]\w*)\s*(=~|!~|=|!=)\s*"((?:\\.|[^"\\])*)"/gi;

/**
 * Parse label matchers from a `{...}` block body.
 */
export const parseMatcherBlock = (body: string): LabelMatcher[] => {
  const matchers: LabelMatcher[] = [];
  MATCHER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MATCHER_RE.exec(body)) !== null) {
    matchers.push({
      name: match[1]!,
      op: match[2] as MatcherOp,
      value: match[3]!.replaceAll('\\"', '"'),
    });
  }
  return matchers;
};

/**
 * Extract every enterprise_platform metric selector (with optional label matchers)
 * from a PromQL expression.
 */
export const extractSelectorsFromExpr = (alert: string, expr: string): RuleMetricSelector[] => {
  const selectors: RuleMetricSelector[] = [];
  const withBraces = expr.matchAll(/\b(enterprise_platform_[a-z0-9_]+)\s*\{([^}]*)\}/g);
  const seen = new Set<string>();

  for (const match of withBraces) {
    const metric = match[1]!;
    const matchers = parseMatcherBlock(match[2] ?? '');
    const key = `${alert}|${metric}|${JSON.stringify(matchers)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selectors.push({
      alert,
      matchers,
      metric,
      querySelector: buildQuerySelector(metric, matchers),
    });
  }

  // Bare metric references (no braces) still need coverage for emission/query.
  for (const metric of extractMetricNamesFromExpr(expr)) {
    const already = [...seen].some((key) => key.startsWith(`${alert}|${metric}|`));
    if (already) continue;
    // Only add bare if the metric never appears with braces in this expr.
    if (new RegExp(`\\b${metric}\\s*\\{`).test(expr)) continue;
    const key = `${alert}|${metric}|[]`;
    if (seen.has(key)) continue;
    seen.add(key);
    selectors.push({
      alert,
      matchers: [],
      metric,
      querySelector: metric,
    });
  }

  return selectors;
};

/** Build an instant query selector from equality matchers (regex → first alternative). */
export const buildQuerySelector = (metric: string, matchers: LabelMatcher[]): string => {
  if (matchers.length === 0) return metric;
  const parts = matchers.map((matcher) => {
    if (matcher.op === '=' || matcher.op === '!=') {
      return `${matcher.name}${matcher.op}"${matcher.value}"`;
    }
    // =~ / !~ : use first alternative for representative query proof
    const first = matcher.value.split('|')[0] ?? matcher.value;
    const op = matcher.op === '=~' ? '=' : '!=';
    return `${matcher.name}${op}"${first}"`;
  });
  return `${metric}{${parts.join(',')}}`;
};

/** Parse the production rule file into every selector each of the 12 rules depends on. */
export const parseProductionRuleSelectors = (rulesPath: string): RuleMetricSelector[] => {
  const rules = parsePrometheusAlertRulesFile(rulesPath);
  return rules.flatMap((rule) => extractSelectorsFromExpr(rule.alert, rule.expr));
};

/** Representative equality value for a matcher (regex → first alt). */
export const representativeMatcherValue = (matcher: LabelMatcher): string => {
  if (matcher.op === '=~' || matcher.op === '!~') {
    return matcher.value.split('|')[0] ?? matcher.value;
  }
  return matcher.value;
};
