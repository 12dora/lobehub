'use client';

import { Alert } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { AdminLoadingSurface } from '@/enterprise/client/features/admin/pages/AdminStateSurfaces';
import type {
  AdminBrowserProfileOptions,
  AdminBrowserProfileSummary,
  AdminSystemInfraSettings,
  AdminSystemSandboxSettings,
  AdminSystemTestDependencyResult,
} from '@/enterprise/client/services/adminSystem';
import type { AdminSystemInfraDependency } from '@/server/enterprise/contracts/adminSystem';

import { BrowserProfileCard } from './infra/BrowserProfileCard';
import type { BrowserProfileSaveInput } from './infra/browserProfileSelection';
import { MailCard } from './infra/MailCard';
import { ObjectStorageCard } from './infra/ObjectStorageCard';
import { SandboxCard } from './infra/SandboxCard';
import { infraSettingsStyles as styles } from './styles';

export interface SystemGeneralPageViewProps {
  canOperate: boolean;
  data?: AdminSystemInfraSettings;
  error: unknown;
  isLoading: boolean;
  onProfileRegenerate?: () => Promise<void>;
  onProfileRetry?: () => void;
  onProfileSave?: (input: BrowserProfileSaveInput) => Promise<void>;
  onRetry: () => void;
  onTest: (dependency: AdminSystemInfraDependency) => void;
  probeBusy: Partial<Record<AdminSystemInfraDependency, boolean>>;
  probeResults: Partial<Record<AdminSystemInfraDependency, AdminSystemTestDependencyResult>>;
  profileData?: AdminBrowserProfileSummary;
  profileError?: unknown;
  profileIsLoading?: boolean;
  profileOptions?: AdminBrowserProfileOptions;
  sandboxData?: AdminSystemSandboxSettings;
  sandboxModuleEnabled?: boolean;
}

/**
 * 基础设施 tab body — object storage and mail service.
 *
 * Both dependencies can be taken over from the environment and edited here. The encryption key
 * is deliberately absent: it decrypts everything else, so it must exist before any database read
 * and can never be configured from the admin panel — its health is reported on the 系统 status
 * page instead.
 *
 * The page chrome (title, tabs) lives in `SystemGeneralPage`; this component is only the body of
 * one tab so the 网络代理 tab can share the same shell.
 */
export const SystemGeneralPageView = memo<SystemGeneralPageViewProps>(
  ({
    canOperate,
    data,
    error,
    isLoading,
    onProfileRegenerate = async () => undefined,
    onProfileRetry = () => undefined,
    onProfileSave = async () => undefined,
    onRetry,
    onTest,
    probeBusy,
    probeResults,
    profileData,
    profileError,
    profileIsLoading = false,
    profileOptions,
    sandboxData,
    sandboxModuleEnabled,
  }) => {
    const { t } = useTranslation('admin');

    /** The settings request owns the page-level state — the fingerprint request never does. */
    const pageFailed = Boolean(error) && !data;
    const pageLoading = !pageFailed && isLoading && !data;
    /** Whether the fingerprint request itself has anything to say yet. */
    const profileActive = Boolean(profileData) || Boolean(profileError) || profileIsLoading;
    /**
     * The fingerprint card is fed by its OWN request, so an object-storage/mail outage must not
     * take a profile that loaded fine — and its 重新生成 action — off the page with it. It only
     * steps aside while the page itself is painting a state and there is no profile to show.
     */
    const showProfileCard =
      pageFailed || pageLoading ? Boolean(profileData) : Boolean(data) || profileActive;
    const showGrid = Boolean(data) || showProfileCard;

    return (
      <>
        {error && !data ? (
          <Alert
            showIcon
            description={t('systemGeneral.loadFailedDescription')}
            message={t('systemGeneral.loadFailed')}
            type="error"
            action={
              <Button size="small" type="primary" onClick={onRetry}>
                {t('systemGeneral.retry')}
              </Button>
            }
          />
        ) : isLoading && !data ? (
          <AdminLoadingSurface />
        ) : null}

        {/*
          One page state at a time, per REQUEST. The two settings cards are the settings
          request: without their data there is nothing to render, and painting them next to the
          page-level alert reported the same failure in two voices. The fingerprint card is a
          different request and keeps its own loading/empty/error states — gating it on the
          settings response deleted a perfectly good profile, and the only way to regenerate
          one, whenever object storage or mail failed to load.
        */}
        {showGrid ? (
          <div className={styles.grid}>
            {data ? (
              <>
                <ObjectStorageCard
                  canOperate={canOperate}
                  probe={probeResults.objectStorage}
                  probing={Boolean(probeBusy.objectStorage)}
                  view={data.objectStorage}
                  onTest={() => onTest('objectStorage')}
                />
                <MailCard
                  canOperate={canOperate}
                  probe={probeResults.mail}
                  probing={Boolean(probeBusy.mail)}
                  view={data.mail}
                  onTest={() => onTest('mail')}
                />
                {sandboxModuleEnabled === undefined ? null : (
                  <SandboxCard
                    canOperate={canOperate}
                    moduleEnabled={sandboxModuleEnabled}
                    view={sandboxData}
                  />
                )}
              </>
            ) : null}
            {showProfileCard ? (
              <BrowserProfileCard
                canOperate={canOperate}
                data={profileData}
                // Suppressed only where the page-level alert above already owns the failure:
                // two alerts for one outage, with two 重试 of different weight, is the state
                // this page was fixed out of.
                error={pageFailed ? undefined : profileError}
                isLoading={profileIsLoading}
                options={profileOptions}
                onRegenerate={onProfileRegenerate}
                onRetry={onProfileRetry}
                onSave={onProfileSave}
              />
            ) : null}
          </div>
        ) : null}
      </>
    );
  },
);

SystemGeneralPageView.displayName = 'AdminSystemGeneralPageView';
