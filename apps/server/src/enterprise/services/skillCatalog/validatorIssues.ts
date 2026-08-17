import { canonicalizePlatformSkillContent } from '@/database/models/platform';

import type { SkillValidationIssue } from '../../contracts/skillCatalog';

const LONE_SURROGATE_PATTERN =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

export const issue = (
  code: SkillValidationIssue['code'],
  path: SkillValidationIssue['path'],
  message: string,
  severity: SkillValidationIssue['severity'] = 'error',
): SkillValidationIssue => ({ code, message, path, severity });

const compareCodepoint = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

export const compareIssues = (left: SkillValidationIssue, right: SkillValidationIssue) =>
  compareCodepoint(left.severity, right.severity) ||
  compareCodepoint(left.code, right.code) ||
  compareCodepoint(JSON.stringify(left.path), JSON.stringify(right.path));

export const issueKey = (item: SkillValidationIssue) =>
  `${item.severity}:${item.code}:${JSON.stringify(item.path)}`;

export const hasNonCanonicalString = (value: unknown, seen = new WeakSet<object>()): boolean => {
  if (typeof value === 'string') return canonicalizePlatformSkillContent(value) !== value;
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  return (Array.isArray(value) ? value : Object.values(value)).some((item) =>
    hasNonCanonicalString(item, seen),
  );
};

export const hasLoneSurrogate = (value: unknown, seen = new WeakSet<object>()): boolean => {
  if (typeof value === 'string') return LONE_SURROGATE_PATTERN.test(value);
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  return (Array.isArray(value) ? value : Object.values(value)).some((item) =>
    hasLoneSurrogate(item, seen),
  );
};
