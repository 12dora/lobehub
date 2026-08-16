import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  AUDIT_ACTIONS,
  AUDIT_TARGET_TYPES,
} from '../../../../../../../apps/server/src/enterprise/services/audit/auditActionCatalog';
import { AUDIT_LOG_TARGET_TYPES } from '../operationLogs/targetTypes';

const loadAdminLocale = (locale: 'en-US' | 'zh-CN'): Record<string, string> => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const filePath = path.join(here, '../../../../../../../locales', locale, 'admin.json');
  return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, string>;
};

describe('audit log locale catalog (server-emitted)', () => {
  it('uses the server audit catalogs as the sole coverage source (finite, non-empty)', () => {
    // Locale coverage asserts against AUDIT_ACTIONS / AUDIT_TARGET_TYPES directly —
    // no client-side hand-mirrored token list.
    expect(AUDIT_ACTIONS.length).toBeGreaterThan(100);
    expect(AUDIT_TARGET_TYPES.length).toBeGreaterThan(10);
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
    expect(new Set(AUDIT_TARGET_TYPES).size).toBe(AUDIT_TARGET_TYPES.length);
  });

  it('has en-US and zh-CN labels for every server-emitted action and target type', () => {
    const en = loadAdminLocale('en-US');
    const zh = loadAdminLocale('zh-CN');

    const missing: string[] = [];
    for (const action of AUDIT_ACTIONS) {
      const key = `audit.logs.action.${action}`;
      if (!en[key]?.trim()) missing.push(`en:${key}`);
      if (!zh[key]?.trim()) missing.push(`zh:${key}`);
    }
    for (const target of AUDIT_TARGET_TYPES) {
      const key = `audit.logs.targetType.${target}`;
      if (!en[key]?.trim()) missing.push(`en:${key}`);
      if (!zh[key]?.trim()) missing.push(`zh:${key}`);
    }

    expect(missing, `missing audit labels:\n${missing.join('\n')}`).toEqual([]);
  });

  it('mirrors every server AUDIT_TARGET_TYPES entry in the operation-log filter', () => {
    const client = new Set<string>(AUDIT_LOG_TARGET_TYPES);
    const missing = AUDIT_TARGET_TYPES.filter((target) => !client.has(target));
    expect(missing, `client filter missing targets:\n${missing.join('\n')}`).toEqual([]);
  });
});
