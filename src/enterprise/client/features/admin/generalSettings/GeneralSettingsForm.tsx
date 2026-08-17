'use client';

import { Flexbox, Text, TextArea } from '@lobehub/ui';
import { Switch } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { GeneralSettingsDraft } from './useGeneralSettingsEditor';

const styles = createStaticStyles(({ css }) => ({
  allowlistReveal: css`
    display: grid;
    grid-template-rows: 0fr;
    opacity: 0;
    transition:
      grid-template-rows ${cssVar.motionDurationMid} ${cssVar.motionEaseInOut},
      opacity ${cssVar.motionDurationMid} ${cssVar.motionEaseInOut};

    &[data-open='true'] {
      grid-template-rows: 1fr;
      opacity: 1;
    }

    @media (prefers-reduced-motion: reduce) {
      transition: none;
    }
  `,
  allowlistRevealInner: css`
    overflow: hidden;
    min-height: 0;
  `,
  card: css`
    display: flex;
    flex-direction: column;

    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};
  `,
  divider: css`
    height: 1px;
    margin: 0;
    border: none;
    background: ${cssVar.colorBorderSecondary};
  `,
  hint: css`
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
  row: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px 24px;
    align-items: flex-start;
    justify-content: space-between;

    padding: 16px;
  `,
  rowText: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;

    min-width: 220px;
  `,
}));

export interface GeneralSettingsFormProps {
  disabled: boolean;
  draft: GeneralSettingsDraft;
  onPatch: (next: Partial<GeneralSettingsDraft>) => void;
}

const GeneralSettingsForm = memo<GeneralSettingsFormProps>(({ disabled, draft, onPatch }) => {
  const { t } = useTranslation('admin');

  return (
    <section className={styles.card}>
      {/* Open registration */}
      <div className={styles.row}>
        <div className={styles.rowText}>
          <Text strong>{t('generalSettings.openRegistration.title')}</Text>
          <Text type="secondary">{t('generalSettings.openRegistration.desc')}</Text>
        </div>
        <Switch
          checked={draft.openRegistration}
          disabled={disabled}
          onChange={(checked) => onPatch({ openRegistration: checked })}
        />
      </div>

      <hr className={styles.divider} />

      {/* Email domain allowlist */}
      <div className={styles.row}>
        <div className={styles.rowText}>
          <Text strong>{t('generalSettings.emailAllowlist.title')}</Text>
          <Text type="secondary">{t('generalSettings.emailAllowlist.desc')}</Text>
          <div
            aria-hidden={!draft.emailDomainAllowlistEnabled}
            className={styles.allowlistReveal}
            data-open={draft.emailDomainAllowlistEnabled}
          >
            <div className={styles.allowlistRevealInner}>
              <Flexbox gap={6} style={{ paddingTop: 8 }}>
                <TextArea
                  disabled={disabled || !draft.emailDomainAllowlistEnabled}
                  placeholder={t('generalSettings.emailAllowlist.placeholder')}
                  rows={4}
                  value={draft.emailDomainText}
                  onChange={(event) => onPatch({ emailDomainText: event.target.value })}
                />
                <span className={styles.hint}>{t('generalSettings.emailAllowlist.hint')}</span>
              </Flexbox>
            </div>
          </div>
        </div>
        <Switch
          checked={draft.emailDomainAllowlistEnabled}
          disabled={disabled}
          onChange={(checked) => onPatch({ emailDomainAllowlistEnabled: checked })}
        />
      </div>
    </section>
  );
});

GeneralSettingsForm.displayName = 'GeneralSettingsForm';

export default GeneralSettingsForm;
