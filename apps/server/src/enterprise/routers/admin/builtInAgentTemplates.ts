import arSuggestQuestions from '../../../../../../locales/ar/suggestQuestions.json';
import bgBGSuggestQuestions from '../../../../../../locales/bg-BG/suggestQuestions.json';
import deDESuggestQuestions from '../../../../../../locales/de-DE/suggestQuestions.json';
import esESSuggestQuestions from '../../../../../../locales/es-ES/suggestQuestions.json';
import faIRSuggestQuestions from '../../../../../../locales/fa-IR/suggestQuestions.json';
import frFRSuggestQuestions from '../../../../../../locales/fr-FR/suggestQuestions.json';
import itITSuggestQuestions from '../../../../../../locales/it-IT/suggestQuestions.json';
import jaJPSuggestQuestions from '../../../../../../locales/ja-JP/suggestQuestions.json';
import koKRSuggestQuestions from '../../../../../../locales/ko-KR/suggestQuestions.json';
import nlNLSuggestQuestions from '../../../../../../locales/nl-NL/suggestQuestions.json';
import plPLSuggestQuestions from '../../../../../../locales/pl-PL/suggestQuestions.json';
import ptBRSuggestQuestions from '../../../../../../locales/pt-BR/suggestQuestions.json';
import ruRUSuggestQuestions from '../../../../../../locales/ru-RU/suggestQuestions.json';
import trTRSuggestQuestions from '../../../../../../locales/tr-TR/suggestQuestions.json';
import viVNSuggestQuestions from '../../../../../../locales/vi-VN/suggestQuestions.json';
import zhCNSuggestQuestions from '../../../../../../locales/zh-CN/suggestQuestions.json';
import zhTWSuggestQuestions from '../../../../../../locales/zh-TW/suggestQuestions.json';
import enUSSuggestQuestions from '../../../../../../packages/locales/src/default/suggestQuestions';

/**
 * Built-in create-agent examples (`suggestQuestions:agent.01` … `agent.40`).
 *
 * Catalogs are **bundled** via static module imports (en-US TS source + one JSON per
 * supported locale). Do not `readFileSync` the source tree and do not `import()` with a
 * template string — the standalone Docker image does not preserve that layout, and a
 * module-scope fs read would also run when ENABLE_PLATFORM_ADMIN is off (this file is
 * pulled in by the admin/platform routers).
 *
 * After an operator import the stored copy is single-locale; first-run auto-seed and
 * `importBuiltins` resolve the same catalog users would otherwise see in i18next.
 */
const BUILTIN_COUNT = 40;
const FALLBACK_LOCALE = 'en-US';

type SuggestQuestionsCatalog = Record<string, string>;

/** Locales with a bundled `suggestQuestions` catalog — matches `locales/<lang>/`. */
export const BUILTIN_AGENT_TEMPLATE_LOCALES = [
  'ar',
  'bg-BG',
  'de-DE',
  'en-US',
  'es-ES',
  'fa-IR',
  'fr-FR',
  'it-IT',
  'ja-JP',
  'ko-KR',
  'nl-NL',
  'pl-PL',
  'pt-BR',
  'ru-RU',
  'tr-TR',
  'vi-VN',
  'zh-CN',
  'zh-TW',
] as const;
export type BuiltInAgentTemplateLocale = (typeof BUILTIN_AGENT_TEMPLATE_LOCALES)[number];

const CATALOGS: Record<BuiltInAgentTemplateLocale, SuggestQuestionsCatalog> = {
  'ar': arSuggestQuestions,
  'bg-BG': bgBGSuggestQuestions,
  'de-DE': deDESuggestQuestions,
  'en-US': enUSSuggestQuestions,
  'es-ES': esESSuggestQuestions,
  'fa-IR': faIRSuggestQuestions,
  'fr-FR': frFRSuggestQuestions,
  'it-IT': itITSuggestQuestions,
  'ja-JP': jaJPSuggestQuestions,
  'ko-KR': koKRSuggestQuestions,
  'nl-NL': nlNLSuggestQuestions,
  'pl-PL': plPLSuggestQuestions,
  'pt-BR': ptBRSuggestQuestions,
  'ru-RU': ruRUSuggestQuestions,
  'tr-TR': trTRSuggestQuestions,
  'vi-VN': viVNSuggestQuestions,
  'zh-CN': zhCNSuggestQuestions,
  'zh-TW': zhTWSuggestQuestions,
} as Record<BuiltInAgentTemplateLocale, SuggestQuestionsCatalog>;

const CATALOG_BY_TAG = new Map(
  BUILTIN_AGENT_TEMPLATE_LOCALES.map((locale) => [locale.toLowerCase(), locale]),
);

/** First catalog per language (`zh-CN` before `zh-TW` so bare `zh` is not traditional). */
const CATALOG_BY_LANGUAGE = new Map<string, BuiltInAgentTemplateLocale>();
for (const locale of BUILTIN_AGENT_TEMPLATE_LOCALES) {
  const language = locale.split('-')[0]!.toLowerCase();
  if (!CATALOG_BY_LANGUAGE.has(language)) CATALOG_BY_LANGUAGE.set(language, locale);
}

/** Script / region subtags that should resolve to Traditional Chinese (`zh-TW`). */
const TRADITIONAL_CHINESE_SUBTAGS = new Set(['hant', 'hk', 'mo', 'tw']);

const TWO_LETTER = /^[a-z]{2}$/;

/**
 * Map a console / i18next locale onto a bundled catalog.
 *
 * Order: exact tag → language-region (`en-GB` has no catalog, falls through) → language
 * (`zh` → zh-CN, `zh-Hant` / `zh-HK` → zh-TW, `pt` → pt-BR, `en-GB` → en-US) → en-US.
 */
export const resolveBuiltInAgentTemplateLocale = (locale?: string): BuiltInAgentTemplateLocale => {
  const tag = (locale ?? '').trim().replaceAll('_', '-').toLowerCase();
  if (!tag) return FALLBACK_LOCALE;

  const exact = CATALOG_BY_TAG.get(tag);
  if (exact) return exact;

  const parts = tag.split('-').filter(Boolean);
  const language = parts[0];
  if (!language) return FALLBACK_LOCALE;

  const region = parts.findLast((part) => TWO_LETTER.test(part) && part !== language);
  if (region) {
    const languageRegion = CATALOG_BY_TAG.get(`${language}-${region}`);
    if (languageRegion) return languageRegion;
  }

  if (language === 'zh') {
    return parts.some((part) => TRADITIONAL_CHINESE_SUBTAGS.has(part)) ? 'zh-TW' : 'zh-CN';
  }

  return CATALOG_BY_LANGUAGE.get(language) ?? FALLBACK_LOCALE;
};

const catalogFor = (locale?: string): SuggestQuestionsCatalog =>
  CATALOGS[resolveBuiltInAgentTemplateLocale(locale)];

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

/** Resolve the 40 built-in create-agent examples for `importBuiltins` and the unmanaged preview. */
export const builtInAgentTemplatesForImport = (locale?: string): BuiltInAgentTemplateRow[] =>
  builtInAgentTemplatesFromCatalog(catalogFor(locale));
