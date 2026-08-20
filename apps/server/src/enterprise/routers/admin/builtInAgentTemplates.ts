import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import enUSSuggestQuestions from '../../../../../../packages/locales/src/default/suggestQuestions';

/**
 * Built-in create-agent examples (`suggestQuestions:agent.01` … `agent.40`).
 *
 * en-US is the TypeScript source of truth; zh-CN is the hand-written JSON preview.
 * Other locales fall back to en-US — matching task-template market import, the stored
 * copy is single-locale after an operator import.
 */
const BUILTIN_COUNT = 40;

type SuggestQuestionsCatalog = Record<string, string>;

const EN_US_CATALOG = enUSSuggestQuestions as SuggestQuestionsCatalog;

const ZH_CN_CATALOG: SuggestQuestionsCatalog = JSON.parse(
  readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../../../../locales/zh-CN/suggestQuestions.json',
    ),
    'utf8',
  ),
) as SuggestQuestionsCatalog;

const catalogFor = (locale?: string): SuggestQuestionsCatalog => {
  const normalized = (locale ?? 'en-US').trim().toLowerCase().replaceAll('_', '-');
  if (normalized === 'zh-cn' || normalized === 'zh' || normalized.startsWith('zh-')) {
    return ZH_CN_CATALOG;
  }
  return EN_US_CATALOG;
};

const pad = (index: number) => String(index).padStart(2, '0');

export interface BuiltInAgentTemplateRow {
  description: string;
  identifier: string;
  systemRole: string;
  title: string;
}

/**
 * Resolve the 40 built-in create-agent examples for `importBuiltins`.
 * Empty title / prompt keys are omitted (the caller counts them as skipped).
 */
export const builtInAgentTemplatesForImport = (locale?: string): BuiltInAgentTemplateRow[] => {
  const catalog = catalogFor(locale);
  const rows: BuiltInAgentTemplateRow[] = [];

  for (let index = 1; index <= BUILTIN_COUNT; index += 1) {
    const nn = pad(index);
    const title = catalog[`agent.${nn}.title`]?.trim() ?? '';
    const systemRole = catalog[`agent.${nn}.prompt`]?.trim() ?? '';
    if (!title || !systemRole) continue;
    rows.push({
      description: '',
      identifier: `agent-${nn}`,
      systemRole,
      title,
    });
  }

  return rows;
};
