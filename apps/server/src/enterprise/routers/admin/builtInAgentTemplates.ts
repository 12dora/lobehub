import zhCNSuggestQuestions from '../../../../../../locales/zh-CN/suggestQuestions.json';
import enUSSuggestQuestions from '../../../../../../packages/locales/src/default/suggestQuestions';

/**
 * Built-in create-agent examples (`suggestQuestions:agent.01` … `agent.40`).
 *
 * Catalogs are **bundled** via static module imports (en-US TS source + zh-CN JSON). Do not
 * `readFileSync` the source tree — the standalone Docker image does not preserve that layout,
 * and a module-scope fs read would also run when ENABLE_PLATFORM_ADMIN is off (this file is
 * pulled in by the admin/platform routers).
 *
 * Other locales fall back to en-US — matching task-template market import, the stored copy is
 * single-locale after an operator import.
 */
const BUILTIN_COUNT = 40;

type SuggestQuestionsCatalog = Record<string, string>;

const EN_US_CATALOG = enUSSuggestQuestions as SuggestQuestionsCatalog;
const ZH_CN_CATALOG = zhCNSuggestQuestions as SuggestQuestionsCatalog;

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
 * Always emit one slot per `agent.01` … `agent.40`. Empty title / prompt (missing locale keys)
 * stay on the row so the importer can count them as `skipped`.
 *
 * Catalog resolution and the 40-key walk happen here, on demand — not at module evaluation.
 */
export const builtInAgentTemplatesFromCatalog = (
  catalog: SuggestQuestionsCatalog,
): BuiltInAgentTemplateRow[] => {
  const rows: BuiltInAgentTemplateRow[] = [];
  for (let index = 1; index <= BUILTIN_COUNT; index += 1) {
    const nn = pad(index);
    rows.push({
      description: '',
      identifier: `agent-${nn}`,
      systemRole: catalog[`agent.${nn}.prompt`]?.trim() ?? '',
      title: catalog[`agent.${nn}.title`]?.trim() ?? '',
    });
  }
  return rows;
};

/** Resolve the 40 built-in create-agent examples for `importBuiltins`. */
export const builtInAgentTemplatesForImport = (locale?: string): BuiltInAgentTemplateRow[] =>
  builtInAgentTemplatesFromCatalog(catalogFor(locale));
