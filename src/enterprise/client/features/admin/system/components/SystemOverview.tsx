'use client';

import { Alert, Block, Flexbox, Icon, Tag, Text } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import {
  Box,
  Boxes,
  CircleAlert,
  Container,
  FileImage,
  KeyRound,
  Mail,
  Network,
  Server,
  Waypoints,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import {
  deriveSsoPresentation,
  type SsoAuthSnapshot,
} from '@/enterprise/client/features/admin/system/controller';
import type { AdminSystemStatus } from '@/enterprise/client/services/adminSystem';

import { OperationalStatus } from './OperationalStatus';

const styles = createStaticStyles(({ css }) => ({
  build: css`
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 16px;
    align-items: center;

    @media (width <= 640px) {
      grid-template-columns: 1fr;
    }
  `,
  code: css`
    font-family: ${cssVar.fontFamilyCode};
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  `,
  dependency: css`
    min-width: 0;
  `,
  dependencyGrid: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 8px;
  `,
  flagGrid: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 8px;
  `,
  sectionTitle: css`
    margin: 0;
    font-size: ${cssVar.fontSizeLG};
    font-weight: ${cssVar.fontWeightStrong};
  `,
}));

const DEPENDENCIES = [
  ['database', Boxes],
  ['redis', Network],
  ['objectStorage', Box],
  ['mail', Mail],
  ['keyManagement', KeyRound],
] as const;

interface SectionTitleProps {
  children: ReactNode;
}

const SectionTitle = ({ children }: SectionTitleProps) => (
  <Text as="h2" className={styles.sectionTitle}>
    {children}
  </Text>
);

export const BuildSummary = memo<{ status: AdminSystemStatus }>(({ status }) => {
  const { t } = useTranslation('admin');
  return (
    <Block className={styles.build} padding={16} variant="outlined">
      <Flexbox gap={4}>
        <Flexbox horizontal align="center" gap={8}>
          <Icon icon={Server} size={18} />
          <Text strong>{t('system.build.title')}</Text>
        </Flexbox>
        <Text className={styles.code}>{status.build.version}</Text>
      </Flexbox>
      <Flexbox gap={4}>
        <Text type="secondary">{t('system.snapshotAt')}</Text>
        <Text>{status.snapshotAt.toLocaleString()}</Text>
      </Flexbox>
    </Block>
  );
});

BuildSummary.displayName = 'AdminSystemBuildSummary';

export const DependencyGrid = memo<{ status: AdminSystemStatus }>(({ status }) => {
  const { t } = useTranslation('admin');
  const documentRender = status.dependencies.documentRender;
  return (
    <Flexbox gap={8}>
      <SectionTitle>{t('system.dependencies.title')}</SectionTitle>
      <div className={styles.dependencyGrid}>
        {DEPENDENCIES.map(([key, icon]) => {
          const dependency = status.dependencies[key];
          return (
            <Block className={styles.dependency} key={key} padding={12} variant="outlined">
              <Flexbox gap={8}>
                <Flexbox horizontal align="center" gap={8} justify="space-between">
                  <Flexbox horizontal align="center" gap={8}>
                    <Icon icon={icon} size={16} />
                    <Text strong>{t(`system.dependencies.${key}` as never)}</Text>
                  </Flexbox>
                  <OperationalStatus status={dependency.status} />
                </Flexbox>
                {dependency.errorCategory ? (
                  <Text type="secondary">
                    {t(`system.values.dependencyError.${dependency.errorCategory}` as never)}
                  </Text>
                ) : null}
              </Flexbox>
            </Block>
          );
        })}
        {status.dependencies.sandbox ? (
          <Block className={styles.dependency} key="sandbox" padding={12} variant="outlined">
            <Flexbox gap={8}>
              <Flexbox horizontal align="center" gap={8} justify="space-between">
                <Flexbox horizontal align="center" gap={8}>
                  <Icon icon={Container} size={16} />
                  <Text strong>{t('system.dependencies.sandbox')}</Text>
                </Flexbox>
                <OperationalStatus status={status.dependencies.sandbox.status} />
              </Flexbox>
              <Text className={styles.code} type="secondary">
                {t('system.sandbox.daemon', {
                  value: t(
                    status.dependencies.sandbox.daemonReachable
                      ? 'systemGeneral.values.yes'
                      : 'systemGeneral.values.no',
                  ),
                })}
              </Text>
              <Text className={styles.code} type="secondary">
                {t('system.sandbox.image', {
                  value: t(
                    status.dependencies.sandbox.imagePresent
                      ? 'systemGeneral.values.yes'
                      : 'systemGeneral.values.no',
                  ),
                })}
              </Text>
              <Text className={styles.code} type="secondary">
                {t('system.sandbox.containers', {
                  active: status.dependencies.sandbox.activeContainers,
                  max: status.dependencies.sandbox.maxContainers,
                })}
              </Text>
              {status.dependencies.sandbox.lastError ? (
                <Text type="secondary">{status.dependencies.sandbox.lastError}</Text>
              ) : status.dependencies.sandbox.errorCategory ? (
                <Text type="secondary">
                  {t(
                    `system.values.dependencyError.${status.dependencies.sandbox.errorCategory}` as never,
                  )}
                </Text>
              ) : null}
            </Flexbox>
          </Block>
        ) : null}
        {documentRender ? (
          <Block className={styles.dependency} key="documentRender" padding={12} variant="outlined">
            <Flexbox gap={8}>
              <Flexbox horizontal align="center" gap={8} justify="space-between">
                <Flexbox horizontal align="center" gap={8}>
                  <Icon icon={FileImage} size={16} />
                  <Text strong>{t('system.dependencies.documentRender')}</Text>
                </Flexbox>
                <OperationalStatus status={documentRender.status} />
              </Flexbox>
              <Text className={styles.code} type="secondary">
                {t('system.documentRender.sidecar', {
                  value: t(
                    documentRender.configured
                      ? 'systemGeneral.values.yes'
                      : 'systemGeneral.values.no',
                  ),
                })}
              </Text>
              {documentRender.version ? (
                <Text className={styles.code} type="secondary">
                  {t('system.documentRender.version', { version: documentRender.version })}
                </Text>
              ) : null}
              {typeof documentRender.latencyMs === 'number' ? (
                <Text className={styles.code} type="secondary">
                  {t('systemGeneral.test.latency', { ms: documentRender.latencyMs })}
                </Text>
              ) : null}
              <Text className={styles.code} type="secondary">
                {t('system.documentRender.queue', {
                  pending: documentRender.queuePending,
                  running: documentRender.queueRunning,
                })}
              </Text>
              {documentRender.lastError ? (
                <Text type="secondary">{documentRender.lastError}</Text>
              ) : documentRender.errorCategory ? (
                <Text type="secondary">
                  {t(`system.values.dependencyError.${documentRender.errorCategory}` as never)}
                </Text>
              ) : null}
            </Flexbox>
          </Block>
        ) : null}
      </div>
      {status.instanceStatus.status === 'unavailable' ||
      status.instanceStatus.status === 'degraded' ? (
        <Alert
          showIcon
          message={t('system.instances.partialUnavailable')}
          type="warning"
          description={
            status.instanceStatus.errorCategory
              ? t(`system.values.dependencyError.${status.instanceStatus.errorCategory}` as never)
              : undefined
          }
        />
      ) : null}
    </Flexbox>
  );
});

DependencyGrid.displayName = 'AdminSystemDependencyGrid';

export const OidcSummary = memo<{
  snapshot?: SsoAuthSnapshot | null;
  status: AdminSystemStatus;
}>(({ snapshot, status }) => {
  const { t } = useTranslation('admin');
  const presentation = deriveSsoPresentation({ oidc: status.oidc, snapshot });
  const description =
    presentation.kind === 'attention' && presentation.degradedCategory
      ? t(`identityProviders.values.degraded.${presentation.degradedCategory}` as never)
      : t(presentation.descriptionKey);

  return (
    <Flexbox gap={8}>
      <Flexbox horizontal align="center" gap={8}>
        <Icon icon={Waypoints} size={18} />
        <SectionTitle>{t('system.oidc.title')}</SectionTitle>
      </Flexbox>
      <Block padding={16} variant="outlined">
        <Flexbox gap={8}>
          <Tag color={presentation.tone} size="small">
            {t(presentation.labelKey)}
          </Tag>
          <Text type="secondary">{description}</Text>
          {presentation.showSource ? (
            <Text type="secondary">
              {t('system.oidc.source', {
                source: t(`system.values.oidcSource.${status.oidc.source}` as never),
              })}
            </Text>
          ) : null}
        </Flexbox>
      </Block>
    </Flexbox>
  );
});

OidcSummary.displayName = 'AdminSystemOidcSummary';

export const JobsSummary = memo<{ status: AdminSystemStatus }>(({ status }) => {
  const { t } = useTranslation('admin');
  const jobs = status.jobs;
  return (
    <Flexbox gap={8}>
      <SectionTitle>{t('system.jobs.summaryTitle')}</SectionTitle>
      {jobs.status === 'unavailable' ? (
        <Alert
          showIcon
          message={t('system.jobs.summaryUnavailable')}
          type="error"
          description={
            jobs.errorCategory
              ? t(`system.values.availabilityError.${jobs.errorCategory}` as never)
              : undefined
          }
        />
      ) : (
        <div className={styles.flagGrid}>
          {(['total', 'active', 'completed', 'failed'] as const).map((key) => (
            <Block key={key} padding={12} variant="outlined">
              <Flexbox horizontal align="baseline" gap={8} justify="space-between">
                <Text type="secondary">{t(`system.jobs.summary.${key}` as never)}</Text>
                <Text strong className={styles.code}>
                  {jobs[key]}
                </Text>
              </Flexbox>
            </Block>
          ))}
        </div>
      )}
    </Flexbox>
  );
});

JobsSummary.displayName = 'AdminSystemJobsSummary';

export const PublishFailures = memo<{ status: AdminSystemStatus }>(({ status }) => {
  const { t } = useTranslation('admin');
  const failures = status.recentPublishFailures;
  return (
    <Flexbox gap={8}>
      <Flexbox horizontal align="center" gap={8}>
        <Icon icon={CircleAlert} size={18} />
        <SectionTitle>{t('system.publishFailures.title')}</SectionTitle>
      </Flexbox>
      {failures.status === 'unavailable' ? (
        <Alert
          showIcon
          message={t('system.publishFailures.unavailable')}
          type="error"
          description={
            failures.errorCategory
              ? t(`system.values.availabilityError.${failures.errorCategory}` as never)
              : undefined
          }
        />
      ) : failures.items.length === 0 ? (
        <Block padding={16} variant="outlined">
          <Text type="secondary">{t('system.publishFailures.empty')}</Text>
        </Block>
      ) : (
        <Flexbox gap={8}>
          <Text type="secondary">
            {t('system.publishFailures.count', { count: failures.count })}
          </Text>
          {failures.items.map((failure, index) => (
            <Block
              key={`${failure.domain}:${failure.occurredAt.toISOString()}:${index}`}
              padding={12}
              variant="outlined"
            >
              <Flexbox horizontal align="center" gap={8} justify="space-between" wrap="wrap">
                <Flexbox horizontal align="center" gap={8}>
                  <Text strong>{t(`system.values.domain.${failure.domain}` as never)}</Text>
                  <Tag color="error" size="small">
                    {t(`system.values.publishFailure.${failure.category}` as never)}
                  </Tag>
                </Flexbox>
                <Text className={styles.code} type="secondary">
                  {failure.occurredAt.toLocaleString()}
                </Text>
              </Flexbox>
            </Block>
          ))}
        </Flexbox>
      )}
    </Flexbox>
  );
});

PublishFailures.displayName = 'AdminSystemPublishFailures';
