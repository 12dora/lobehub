'use client';

import { Alert, Skeleton, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { useReducedMotion } from 'motion/react';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import { useBranding } from '@/enterprise/client/providers/RuntimeBrandingProvider';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import { useUnsavedChangesGuard } from '../primitives/useUnsavedChangesGuard';
import { BrandingFields } from './BrandingFields';
import { BrandingPageAlerts } from './BrandingPageAlerts';
import { BrandingPreview } from './BrandingPreview';
import { usePruneLegacyBrandingDrafts } from './pruneLegacyBrandingDrafts';
import { hasBrandingChanges, useBrandingEditorStore } from './store';
import { useFetchAdminBranding } from './useAdminBranding';
import { useBrandingHydration } from './useBrandingHydration';
import { useBrandingPageActions } from './useBrandingPageActions';

const styles = createStaticStyles(({ css }) => ({
  actions: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  `,
  content: css`
    display: grid;
    grid-template-columns: minmax(0, 1.35fr) minmax(320px, 0.65fr);
    gap: 16px;
    align-items: start;

    @media (width <= 960px) {
      grid-template-columns: 1fr;
    }
  `,
  editor: css`
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-width: 0;
  `,
  preview: css`
    position: sticky;
    inset-block-start: 16px;

    display: flex;
    flex-direction: column;
    gap: 12px;
  `,
  status: css`
    color: ${cssVar.colorTextSecondary};
  `,
}));

const BrandingPage = memo(() => {
  const { t } = useTranslation('admin');
  const reduceMotion = useReducedMotion();
  const runtimeBranding = useBranding();
  const admin = useAdminAccess();
  const canRead = admin.permissions.includes(PLATFORM_PERMISSIONS.BRANDING_READ);
  const canUpdate = admin.permissions.includes(PLATFORM_PERMISSIONS.BRANDING_UPDATE);
  const canPublish = admin.permissions.includes(PLATFORM_PERMISSIONS.BRANDING_PUBLISH);
  /** Saving is publishing now — both write permissions are required to change anything. */
  const canSave = canUpdate && canPublish;
  usePruneLegacyBrandingDrafts();
  const { data, error, isLoading, mutate } = useFetchAdminBranding({
    adminAllowed: admin.status === 'allowed',
    canRead,
  });
  const { baseline, branding, patch } = useBrandingEditorStore();
  const { noteObservedSnapshot } = useBrandingHydration(data);
  const {
    actionError,
    actionNotice,
    busy,
    conflict,
    dirty,
    formatError,
    refreshWarning,
    reload,
    reloadFailed,
    retryLoad,
    retryRefresh,
    retryingLoad,
    retryingRefresh,
    save,
    upload,
    valid,
  } = useBrandingPageActions({
    authMethod: admin.authMethod,
    canSave,
    data,
    mutate,
    noteObservedSnapshot,
  });
  const changed = hasBrandingChanges(branding, baseline);

  const unsavedMessages = useMemo(
    () => ({
      cancelText: t('branding.unsaved.stay'),
      content: t('branding.unsaved.description'),
      okText: t('branding.unsaved.leave'),
      title: t('branding.unsaved.title'),
    }),
    [t],
  );
  // Armed by the values themselves, not by save eligibility: edits are just as losable while
  // a save is in flight or the editor is conflicted.
  useUnsavedChangesGuard({ enabled: changed, messages: unsavedMessages });

  const labels = useMemo(
    () => ({
      ...Object.fromEntries(
        [
          'assets',
          'defaultAgentDisplayName',
          'desktop',
          'desktopIcon',
          'desktopProductName',
          'effectiveCurrent',
          'email',
          'emailFrom',
          'emailSenderName',
          'faviconUrl',
          'homeUrl',
          'iconUrl',
          'identity',
          'legalName',
          'links',
          'logoUrl',
          'name',
          'nameRequired',
          'ogImageUrl',
          'pageTitleTemplate',
          'primaryColor',
          'privacyUrl',
          'rebuildRequired',
          'shortName',
          'supportUrl',
          'termsUrl',
          'theme',
          'upload',
        ].map((key) => [key, t(`branding.fields.${key}` as never)]),
      ),
      exportDesktop: t('branding.actions.exportDesktop'),
    }),
    [t],
  );

  if (isLoading || (!data && !error)) {
    return (
      <div aria-label={t('branding.loading')} role="status">
        <Skeleton title active={!reduceMotion} paragraph={{ rows: 8 }} />
      </div>
    );
  }
  if (error) {
    return (
      <Alert
        extraIsolate
        showIcon
        message={formatError(error)}
        type="error"
        extra={
          <Button loading={retryingLoad} onClick={() => void retryLoad()}>
            {t('branding.actions.retry')}
          </Button>
        }
      />
    );
  }
  if (!data || !branding) return <Text>{t('branding.empty')}</Text>;

  return (
    <AdminPageTemplate
      description={t('branding.description', { platformName: runtimeBranding.name })}
      title={t('branding.title', { platformName: runtimeBranding.name })}
      actions={
        <div className={styles.actions}>
          <Button
            disabled={!canSave || !dirty || !valid || busy || conflict}
            loading={busy}
            type="primary"
            onClick={() => void save()}
          >
            {t('branding.actions.save')}
          </Button>
        </div>
      }
      banner={
        <BrandingPageAlerts
          actionError={actionError}
          actionNotice={actionNotice}
          canSave={canSave}
          conflict={conflict}
          refreshWarning={refreshWarning}
          reload={reload}
          reloadFailed={reloadFailed}
          retryRefresh={retryRefresh}
          retryingRefresh={retryingRefresh}
          storageConfigured={data.storageConfigured}
        />
      }
      notice={
        data.updatedAt ? (
          <span className={styles.status}>
            {t('branding.lastSaved', { time: new Date(data.updatedAt).toLocaleString() })}
          </span>
        ) : null
      }
    >
      <div className={styles.content}>
        <div className={styles.editor}>
          <BrandingFields
            branding={branding}
            disabled={!canSave || conflict || busy}
            effective={runtimeBranding}
            labels={labels}
            storageConfigured={data.storageConfigured}
            onPatch={patch}
            onUpload={(kind, file) => void upload(kind, file)}
          />
        </div>
        <aside className={styles.preview}>
          <Text as="h2">{t('branding.preview.title')}</Text>
          <Text type="secondary">{t('branding.preview.description')}</Text>
          <BrandingPreview
            branding={branding}
            effective={runtimeBranding}
            title={t('branding.preview.frameTitle')}
            copy={{
              defaultAgent: t('branding.preview.defaultAgent'),
              defaultName: t('branding.preview.defaultName'),
              emailFrom: t('branding.preview.emailFrom'),
              home: t('branding.fields.homeUrl'),
              links: t('branding.preview.links'),
              primaryColor: t('branding.fields.primaryColor'),
              privacy: t('branding.fields.privacyUrl'),
              signIn: t('branding.preview.signIn'),
              support: t('branding.fields.supportUrl'),
              terms: t('branding.fields.termsUrl'),
              workspace: t('branding.preview.workspace'),
            }}
          />
        </aside>
      </div>
    </AdminPageTemplate>
  );
});

BrandingPage.displayName = 'BrandingPage';

export default BrandingPage;
