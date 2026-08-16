import { DEFAULT_MODEL_PROVIDER_LIST } from 'model-bank/modelProviders';
import { describe, expect, it } from 'vitest';

import enUS from '../../../../locales/en-US/providers.json';
import zhCN from '../../../../locales/zh-CN/providers.json';
import locales from './providers';

/**
 * `providers.ts` is the single source of truth, but only en-US reads it at runtime
 * (`loadI18nNamespaceModule` imports the TS module for the default language and a JSON file
 * for everything else). A key that never reaches the JSON is therefore invisible in
 * development and shows up as raw English on the provider cards of every other locale —
 * which is exactly how `chatgpt.description` went missing.
 *
 * Only en-US and zh-CN are asserted: they are hand-written alongside the source, while the
 * remaining locales are filled by `bun run i18n` before the PR and are allowed to lag.
 */
const SYNCED_LOCALES = { 'en-US': enUS, 'zh-CN': zhCN } as Record<string, Record<string, string>>;

/** The `{{name}}` slots a string carries — the one thing a translation may never change. */
const interpolations = (value: string) => (value.match(/\{\{[^}]+\}\}/g) ?? []).sort();

describe('providers locale source', () => {
  it('emits a description key for every builtin provider card', () => {
    const missing = DEFAULT_MODEL_PROVIDER_LIST.filter((card) => card.description)
      .map((card) => `${card.id}.description`)
      .filter((key) => !(key in locales));

    expect(missing).toEqual([]);
  });

  it.each(Object.keys(SYNCED_LOCALES))('keeps %s in sync with the default source', (locale) => {
    const json = SYNCED_LOCALES[locale];
    const missing = Object.keys(locales).filter((key) => !(key in json));

    expect(missing).toEqual([]);
  });

  /**
   * en-US is not a translation, it is a byte-for-byte mirror of the TypeScript source — the
   * dev-language runtime reads the TS module while every other environment reads this JSON,
   * so a value that drifts here ships copy nobody ever reviewed. Key presence alone kept that
   * green, which is how a stale English string can outlive the source edit that replaced it.
   */
  it('mirrors every en-US value byte for byte', () => {
    const drifted = Object.entries(locales)
      .filter(([key, value]) => enUS[key as keyof typeof enUS] !== value)
      .map(([key]) => key);

    expect(drifted).toEqual([]);
  });

  /**
   * zh-CN is hand-translated, so its VALUES must differ — but an interpolation slot is not
   * prose: a dropped or renamed `{{name}}` renders the placeholder raw to the user.
   */
  it('keeps every zh-CN interpolation slot', () => {
    const broken = Object.entries(locales)
      .filter(
        ([key, value]) =>
          interpolations(zhCN[key as keyof typeof zhCN] ?? '').join() !==
          interpolations(value).join(),
      )
      .map(([key]) => key);

    expect(broken).toEqual([]);
  });

  it.each(Object.keys(SYNCED_LOCALES))('ships no stale key in %s', (locale) => {
    // A key the source no longer emits is dead weight the translation pipeline keeps
    // carrying — and a hint that a provider was renamed without its copy following.
    const stale = Object.keys(SYNCED_LOCALES[locale]).filter((key) => !(key in locales));

    expect(stale).toEqual([]);
  });
});
