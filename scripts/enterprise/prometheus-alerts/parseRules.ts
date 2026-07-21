import { readFileSync } from 'node:fs';

import { parse } from 'yaml';

export interface ParsedPrometheusAlertRule {
  alert: string;
  annotations: Record<string, string>;
  expr: string;
  for?: string;
  labels: Record<string, string>;
}

export interface ParsedPrometheusRuleGroup {
  name: string;
  rules: ParsedPrometheusAlertRule[];
}

export interface ParsedPrometheusRuleFile {
  groups: ParsedPrometheusRuleGroup[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asStringRecord = (value: unknown): Record<string, string> => {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
};

/**
 * Parse a Prometheus rule YAML file into alert rules.
 * Throws on structural problems so drift tests fail closed.
 */
export const parsePrometheusAlertRulesFile = (filePath: string): ParsedPrometheusAlertRule[] => {
  const raw = readFileSync(filePath, 'utf8');
  const document = parse(raw) as unknown;

  if (!isRecord(document) || !Array.isArray(document.groups)) {
    throw new Error(`Invalid Prometheus rule file (missing groups): ${filePath}`);
  }

  const alerts: ParsedPrometheusAlertRule[] = [];

  for (const group of document.groups) {
    if (!isRecord(group) || !Array.isArray(group.rules)) {
      throw new Error(`Invalid rule group in ${filePath}`);
    }
    for (const rule of group.rules) {
      if (!isRecord(rule)) throw new Error(`Invalid rule entry in ${filePath}`);
      if (typeof rule.alert !== 'string' || rule.alert.length === 0) {
        // Recording rules are not part of the enterprise intent mapping.
        if (typeof rule.record === 'string') continue;
        throw new Error(`Rule without alert name in ${filePath}`);
      }
      if (typeof rule.expr !== 'string' || rule.expr.trim().length === 0) {
        throw new Error(`Alert ${rule.alert} is missing expr in ${filePath}`);
      }
      alerts.push({
        alert: rule.alert,
        annotations: asStringRecord(rule.annotations),
        expr: rule.expr,
        ...(typeof rule.for === 'string' ? { for: rule.for } : {}),
        labels: asStringRecord(rule.labels),
      });
    }
  }

  return alerts;
};

/** Extract metric identifiers referenced by a PromQL expression (best-effort). */
export const extractMetricNamesFromExpr = (expr: string): string[] => {
  const matches = expr.matchAll(/\b(enterprise_platform_[a-z0-9_]+)\b/g);
  return [...new Set([...matches].map((match) => match[1]!))];
};
