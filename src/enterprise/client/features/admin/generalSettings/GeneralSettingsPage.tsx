'use client';

import { Alert, Flexbox, Text, TextArea } from '@lobehub/ui';
import { Button, Switch, toast } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import AsyncBoundary from '@/components/AsyncBoundary';
import Loading from '@/components/Loading/BrandTextLoading';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import { adminAuthSettingsService } from '@/enterprise/client/services/adminAuthSettings';
import {
  isValidEmailDomainPattern,
  normalizeEmailDomainAllowlist,
} from '@/types/platform/authSettings';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import { useFetchAdminAuthSettings } from './useAdminAuthSettings';

const styles = createStaticStyles(({ css }) => ({
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
  footer: css`
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: flex-end;
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

interface GeneralSettingsDraft {
  emailDomainAllowlistEnabled: boolean;
  emailDomainText: string;
  openRegistration: boolean;
}

const GeneralSettingsPage = memo<{ embedded?: boolean }>(({ embedded }) => {
  const { t } = useTranslation('admin');
  const { permissions } = useAdminAccess();
  const canView = permissions.includes(PLATFORM_PERMISSIONS.IDENTITY_READ);
  const canUpdate = permissions.includes(PLATFORM_PERMISSIONS.IDENTITY_UPDATE);

  const { data, error, isLoading, mutate } = useFetchAdminAuthSettings(canView);

  const [draft, setDraft] = useState<GeneralSettingsDraft | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!data) return;
    setDraft({
      emailDomainAllowlistEnabled: data.emailDomainAllowlistEnabled,
      emailDomainText: data.emailDomainAllowlist.join('\n'),
      openRegistration: data.openRegistration,
    });
  }, [data]);

  const dirty = useMemo(() => {
    if (!data || !draft) return false;
    return (
      draft.openRegistration !== data.openRegistration ||
      draft.emailDomainAllowlistEnabled !== data.emailDomainAllowlistEnabled ||
      normalizeEmailDomainAllowlist(draft.emailDomainText).join('\n') !==
        data.emailDomainAllowlist.join('\n')
    );
  }, [data, draft]);

  const patch = (next: Partial<GeneralSettingsDraft>) =>
    setDraft((current) => (current ? { ...current, ...next } : current));

  const handleSave = async () => {
    if (!draft || !canUpdate || saving) return;
    const domains = normalizeEmailDomainAllowlist(draft.emailDomainText);
    const invalid = domains.find((entry) => !isValidEmailDomainPattern(entry));
    if (invalid) {
      toast.error(t('generalSettings.emailAllowlist.invalid', { domain: invalid }));
      return;
    }

    setSaving(true);
    try {
      const saved = await adminAuthSettingsService.update({
        emailDomainAllowlist: domains,
        emailDomainAllowlistEnabled: draft.emailDomainAllowlistEnabled,
        openRegistration: draft.openRegistration,
      });
      await mutate(saved, { revalidate: false });
      setDraft({
        emailDomainAllowlistEnabled: saved.emailDomainAllowlistEnabled,
        emailDomainText: saved.emailDomainAllowlist.join('\n'),
        openRegistration: saved.openRegistration,
      });
      toast.success(t('generalSettings.saved'));
    } catch {
      toast.error(t('generalSettings.saveError'));
    } finally {
      setSaving(false);
    }
  };

  const renderLoaded = () => {
    if (!draft) return <Loading debugId="AdminGeneralSettings > Hydrate" />;
    const disabled = !canUpdate;

    return (
      <AdminPageTemplate
        description={t('generalSettings.desc')}
        hideTitle={embedded}
        title={t('generalSettings.title')}
      >
        {disabled ? <Alert showIcon message={t('generalSettings.readOnly')} type="info" /> : null}

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
              onChange={(checked) => patch({ openRegistration: checked })}
            />
          </div>

          <hr className={styles.divider} />

          {/* Email domain allowlist */}
          <div className={styles.row}>
            <div className={styles.rowText}>
              <Text strong>{t('generalSettings.emailAllowlist.title')}</Text>
              <Text type="secondary">{t('generalSettings.emailAllowlist.desc')}</Text>
              {draft.emailDomainAllowlistEnabled ? (
                <Flexbox gap={6} style={{ marginTop: 8 }}>
                  <TextArea
                    disabled={disabled}
                    placeholder={t('generalSettings.emailAllowlist.placeholder')}
                    rows={4}
                    value={draft.emailDomainText}
                    onChange={(event) => patch({ emailDomainText: event.target.value })}
                  />
                  <span className={styles.hint}>{t('generalSettings.emailAllowlist.hint')}</span>
                </Flexbox>
              ) : null}
            </div>
            <Switch
              checked={draft.emailDomainAllowlistEnabled}
              disabled={disabled}
              onChange={(checked) => patch({ emailDomainAllowlistEnabled: checked })}
            />
          </div>
        </section>

        {canUpdate ? (
          <div className={styles.footer}>
            <Button
              disabled={!dirty}
              loading={saving}
              type="primary"
              onClick={() => void handleSave()}
            >
              {t('generalSettings.save')}
            </Button>
          </div>
        ) : null}
      </AdminPageTemplate>
    );
  };

  return (
    <AsyncBoundary
      data={data}
      error={error}
      errorVariant="page"
      isLoading={isLoading}
      loading={<Loading debugId="AdminGeneralSettings" />}
      onRetry={() => void mutate()}
    >
      {data ? renderLoaded() : null}
    </AsyncBoundary>
  );
});

GeneralSettingsPage.displayName = 'GeneralSettingsPage';

export default GeneralSettingsPage;
