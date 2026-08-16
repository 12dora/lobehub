'use client';

import { Flexbox, Icon, Text } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';
import { ExternalLinkIcon } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

const styles = createStaticStyles(({ css, cssVar }) => ({
  hint: css`
    font-size: 12px;
    color: ${cssVar.colorTextDescription};
  `,
  /** Inline external link: the connect steps used to name pages with nothing to click. */
  link: css`
    display: inline-flex;
    gap: 4px;
    align-items: center;

    font-size: 12px;
    color: ${cssVar.colorLink};
    white-space: nowrap;
  `,
}));

/** Where the operator signs in; step 1 named it without offering anything to click. */
const CHATGPT_HOME_URL = 'https://chatgpt.com';
/**
 * The one-click fallback. It answers with the account's ACCESS TOKEN and no session cookie
 * (next-auth never echoes an HttpOnly cookie in a body), so a paste from here cannot renew
 * itself — the copy says so, and the live detection repeats it before anything is submitted.
 */
const CHATGPT_SESSION_URL = 'https://chatgpt.com/api/auth/session';

/**
 * What to do BEFORE there is anything to paste, as three steps with the pages they name
 * one click away. The cURL route leads because it is a single right-click; the cookie
 * route rides along in the same line for operators who prefer it.
 */
const SharedOAuthSessionSteps = memo(() => {
  const { t } = useTranslation('admin');

  return (
    <Flexbox gap={4}>
      <Flexbox horizontal align={'center'} gap={8}>
        <Text className={styles.hint}>
          {t('aiProviderSettings.sharedOAuth.paste.sessionStep1')}
        </Text>
        <a
          className={styles.link}
          href={CHATGPT_HOME_URL}
          rel={'noopener noreferrer'}
          target={'_blank'}
        >
          {t('aiProviderSettings.sharedOAuth.paste.openChatGPT')}
          <Icon icon={ExternalLinkIcon} size={12} />
        </a>
      </Flexbox>
      <Text className={styles.hint}>{t('aiProviderSettings.sharedOAuth.paste.sessionStep2')}</Text>
      <Text className={styles.hint}>{t('aiProviderSettings.sharedOAuth.paste.sessionStep3')}</Text>
      {/* Secondary on purpose: it trades the whole point of this flow (renewing itself)
          for one click, so it is stated as the compromise it is — never as an equal path. */}
      <Flexbox horizontal align={'center'} gap={8} style={{ flexWrap: 'wrap' }}>
        <Text className={styles.hint} type={'secondary'}>
          {t('aiProviderSettings.sharedOAuth.paste.sessionQuickTry')}
        </Text>
        <a
          className={styles.link}
          href={CHATGPT_SESSION_URL}
          rel={'noopener noreferrer'}
          target={'_blank'}
        >
          {t('aiProviderSettings.sharedOAuth.paste.openSessionPage')}
          <Icon icon={ExternalLinkIcon} size={12} />
        </a>
      </Flexbox>
    </Flexbox>
  );
});

SharedOAuthSessionSteps.displayName = 'AdminSharedOAuthSessionSteps';

export default SharedOAuthSessionSteps;
