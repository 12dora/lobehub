import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ENTERPRISE_ERROR_CODES } from '@/const/platform/errorCodes';

const RESOURCE_MANAGED_BY_PLATFORM = 'RESOURCE_MANAGED_BY_PLATFORM';
const MANAGED_RESOURCE_BY_PLATFORM = 'MANAGED_RESOURCE_BY_PLATFORM';

/** Mirror mapEnterpriseError normalization for locale-key shape. */
const normalizeEnterpriseErrorCode = (code: string): string =>
  code === RESOURCE_MANAGED_BY_PLATFORM ? MANAGED_RESOURCE_BY_PLATFORM : code;

const loadAdminLocale = (locale: 'en-US' | 'zh-CN'): Record<string, string> => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const filePath = path.join(here, '../../../../locales', locale, 'admin.json');
  return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, string>;
};

describe('enterprise.error.* locale catalog', () => {
  it('covers every effective ENTERPRISE_ERROR_CODES value in en-US and zh-CN', () => {
    const en = loadAdminLocale('en-US');
    const zh = loadAdminLocale('zh-CN');

    const effectiveCodes = new Set(
      Object.values(ENTERPRISE_ERROR_CODES).map((code) => normalizeEnterpriseErrorCode(code)),
    );

    const missingEn: string[] = [];
    const missingZh: string[] = [];
    const empty: string[] = [];

    for (const code of effectiveCodes) {
      const key = `enterprise.error.${code}`;
      const enVal = en[key];
      const zhVal = zh[key];
      if (!enVal) missingEn.push(key);
      if (!zhVal) missingZh.push(key);
      if (enVal !== undefined && enVal.trim().length === 0) empty.push(`en:${key}`);
      if (zhVal !== undefined && zhVal.trim().length === 0) empty.push(`zh:${key}`);
    }

    expect(missingEn, `missing en-US keys: ${missingEn.join(', ')}`).toEqual([]);
    expect(missingZh, `missing zh-CN keys: ${missingZh.join(', ')}`).toEqual([]);
    expect(empty, `empty translations: ${empty.join(', ')}`).toEqual([]);
  });
});
