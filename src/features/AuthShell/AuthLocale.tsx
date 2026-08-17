'use client';

import { ConfigProvider } from 'antd';
import { memo, type PropsWithChildren, useCallback, useEffect, useRef, useState } from 'react';
import { isRtlLang } from 'rtl-detect';

import { getAntdLocale } from '@/utils/locale';

import { createAuthI18n } from './createAuthI18n';

interface AuthLocaleProps extends PropsWithChildren {
  defaultLang?: string;
}

const AuthLocale = memo<AuthLocaleProps>(({ children, defaultLang }) => {
  const [i18n] = useState(() => createAuthI18n(defaultLang));
  const [lang, setLang] = useState(defaultLang ?? 'en-US');
  const [locale, setLocale] = useState<any>();
  const antdLocaleGenerationRef = useRef(0);

  /** `getAntdLocale` throws for languages antd does not ship — keep the previous locale then. */
  const applyAntdLocale = useCallback((lng: string) => {
    const generation = ++antdLocaleGenerationRef.current;
    void getAntdLocale(lng)
      .then((next) => {
        if (generation !== antdLocaleGenerationRef.current) return;
        setLocale(next);
      })
      .catch(() => {});
  }, []);

  if (!i18n.instance.isInitialized) {
    i18n.init();
  }

  // Seed antd's built-in copy on mount: i18next emits `languageChanged` synchronously inside
  // `init()`, so the subscription below never sees the initial language.
  useEffect(() => {
    applyAntdLocale(lang);
  }, [applyAntdLocale, lang]);

  useEffect(() => {
    const handleLang = (lng: string) => {
      setLang((prev) => (prev === lng ? prev : lng));
    };

    i18n.instance.on('languageChanged', handleLang);
    return () => {
      i18n.instance.off('languageChanged', handleLang);
    };
  }, [i18n]);

  const documentDir = isRtlLang(lang) ? 'rtl' : 'ltr';

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
      {children}
    </ConfigProvider>
  );
});

AuthLocale.displayName = 'AuthLocale';

export default AuthLocale;
