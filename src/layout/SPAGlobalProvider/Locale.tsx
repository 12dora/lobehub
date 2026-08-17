import { ConfigProvider } from 'antd';
import dayjs from 'dayjs';
import type { PropsWithChildren } from 'react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { isRtlLang } from 'rtl-detect';

import Editor from '@/layout/GlobalProvider/Editor';
import { createI18nNext } from '@/locales/create';
import type { DayjsLocaleGlobEntry } from '@/utils/dayjsLocale';
import { loadDayjsLocaleModule, normalizeDayjsLocale } from '@/utils/dayjsLocale';
import { getAntdLocale } from '@/utils/locale';

const dayjsLocaleLoaders: Record<string, DayjsLocaleGlobEntry> = {
  'ar': () => import('dayjs/locale/ar'),
  'bg': () => import('dayjs/locale/bg'),
  'de': () => import('dayjs/locale/de'),
  'en': () => import('dayjs/locale/en'),
  'es': () => import('dayjs/locale/es'),
  'fa': () => import('dayjs/locale/fa'),
  'fr': () => import('dayjs/locale/fr'),
  'it': () => import('dayjs/locale/it'),
  'ja': () => import('dayjs/locale/ja'),
  'ko': () => import('dayjs/locale/ko'),
  'nl': () => import('dayjs/locale/nl'),
  'pl': () => import('dayjs/locale/pl'),
  'pt-br': () => import('dayjs/locale/pt-br'),
  'ru': () => import('dayjs/locale/ru'),
  'tr': () => import('dayjs/locale/tr'),
  'vi': () => import('dayjs/locale/vi'),
  'zh-cn': () => import('dayjs/locale/zh-cn'),
  'zh-tw': () => import('dayjs/locale/zh-tw'),
};

const updateDayjs = async (lang: string) => {
  const locale = normalizeDayjsLocale(lang);
  const loader = dayjsLocaleLoaders[locale] ?? dayjsLocaleLoaders.en;

  try {
    const mod = await loadDayjsLocaleModule(loader);

    dayjs.locale(mod.default);
  } catch (error) {
    console.error('error', error);
    console.error(`dayjs locale for ${lang} not found, fallback to en`);
    const fallback = await loadDayjsLocaleModule(dayjsLocaleLoaders.en!);
    dayjs.locale(fallback.default);
  }
};

interface LocaleLayoutProps extends PropsWithChildren {
  antdLocale?: any;
  defaultLang?: string;
}

const Locale = memo<LocaleLayoutProps>(({ children, defaultLang, antdLocale }) => {
  const [i18n] = useState(() => createI18nNext(defaultLang));
  const [lang, setLang] = useState(defaultLang);
  const [locale, setLocale] = useState(antdLocale);
  const antdLocaleGenerationRef = useRef(0);

  /**
   * antd's built-in copy (date pickers, table filters, pagination, modal buttons…) comes from
   * `ConfigProvider locale`. `getAntdLocale` throws for languages antd does not ship — keep the
   * previous locale in that case instead of blanking the whole app back to en_US.
   *
   * Mount + init/languageChanged can race: apply only the latest requested language.
   */
  const applyAntdLocale = useCallback((lng: string) => {
    const generation = ++antdLocaleGenerationRef.current;
    void getAntdLocale(lng)
      .then((next) => {
        if (generation !== antdLocaleGenerationRef.current) return;
        setLocale(next);
      })
      .catch(() => {});
  }, []);

  // Seed dayjs AND antd on mount (don't wait for i18n init) to avoid "a few seconds ago" or
  // "Select date" showing in English when the UI is already in Chinese. The `languageChanged`
  // listener below cannot do this: with bundled resources i18next emits that event
  // synchronously inside `init()`, i.e. before any effect subscribes to it.
  useEffect(() => {
    if (!defaultLang) return;
    void updateDayjs(defaultLang);
    applyAntdLocale(defaultLang);
  }, [applyAntdLocale, defaultLang]);

  if (!i18n.instance.isInitialized)
    i18n.init().then(async () => {
      // The effective language can differ from `defaultLang` (detection / fallback chain), and
      // the `languageChanged` event for it has already fired — resolve it explicitly here.
      const resolvedLang = i18n.instance.language || defaultLang;
      if (!resolvedLang) return;
      setLang(resolvedLang);
      applyAntdLocale(resolvedLang);
      await updateDayjs(resolvedLang);
    });

  useEffect(() => {
    const handleLang = async (lng: string) => {
      setLang(lng);
      applyAntdLocale(lng);
      await updateDayjs(lng);
    };

    i18n.instance.on('languageChanged', handleLang);
    return () => {
      i18n.instance.off('languageChanged', handleLang);
    };
  }, [applyAntdLocale, i18n]);

  const documentDir = isRtlLang(lang!) ? 'rtl' : 'ltr';

  return (
    <ConfigProvider
      direction={documentDir}
      locale={locale}
      theme={{
        components: {
          Button: {
            contentFontSizeSM: 12,
          },
        },
      }}
    >
      <Editor>{children}</Editor>
    </ConfigProvider>
  );
});

Locale.displayName = 'Locale';

export default Locale;
