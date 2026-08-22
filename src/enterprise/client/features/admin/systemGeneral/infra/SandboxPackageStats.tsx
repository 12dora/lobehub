'use client';

import { Alert, Skeleton, Tag, Text, Tooltip } from '@lobehub/ui';
import { Button, Select } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';

import type {
  AdminSandboxSettingsService,
  AdminSystemSandboxPackageStat,
} from '@/enterprise/client/services/adminSystem';
import { adminSystemService } from '@/enterprise/client/services/adminSystem';

import { EM_DASH, formatAbsolute, relativeLabel } from './documentRenderMaintenanceFormat';

const styles = createStaticStyles(({ css }) => ({
  cell: css`
    padding-block: 6px;
    padding-inline: 0;

    font-size: ${cssVar.fontSizeSM};
    text-align: start;
    vertical-align: middle;
  `,
  code: css`
    font-family: ${cssVar.fontFamilyCode};
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  `,
  controls: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  `,
  /* Sticky, so a scrolled ledger still says which column is which. */
  headCell: css`
    position: sticky;
    z-index: 1;
    inset-block-start: 0;

    padding-block: 4px;
    padding-inline: 0;

    font-size: ${cssVar.fontSizeSM};
    font-weight: ${cssVar.fontWeightStrong};
    color: ${cssVar.colorTextSecondary};
    text-align: start;

    background: ${cssVar.colorBgElevated};
  `,
  header: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
  `,
  hint: css`
    font-size: ${cssVar.fontSizeSM};
    line-height: 1.5;
    color: ${cssVar.colorTextTertiary};
  `,
  /* The package cell carries its manager as a prefix, so the two must not wrap apart. */
  packageCell: css`
    display: flex;
    gap: 6px;
    align-items: center;
    min-width: 0;
  `,
  /* Twenty rows of package names: scroll the table, never the modal. */
  scroller: css`
    overflow: auto;
    min-width: 0;
    max-block-size: 320px;
  `,
  /* Sits under the read-only rows; a hairline keeps the ledger from reading as another setting. */
  section: css`
    display: flex;
    flex-direction: column;
    gap: 8px;

    min-width: 0;
    padding-block-start: 12px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  row: css`
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  /* Right-aligned numbers compare down the column instead of jittering with digit count. */
  numberCell: css`
    padding-block: 6px;
    padding-inline: 0;

    font-family: ${cssVar.fontFamilyCode};
    font-size: ${cssVar.fontSizeSM};
    font-variant-numeric: tabular-nums;
    text-align: start;
    vertical-align: middle;
  `,
  table: css`
    border-collapse: collapse;
    width: 100%;
  `,
}));

/** The three windows an operator actually reasons in; anything finer is noise for a bake decision. */
const WINDOW_OPTIONS = [7, 30, 90] as const;
const DEFAULT_WINDOW_DAYS = 30;
/** One screenful of candidates — the ledger is a shortlist, not a package inventory. */
const PACKAGE_LIMIT = 20;

/** superjson hands back a `Date`; a hand-rolled fixture may still carry the ISO string. */
const toIso = (value: Date | string | null | undefined): string | null => {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
};

const PackageRow = memo<{ stat: AdminSystemSandboxPackageStat }>(({ stat }) => {
  const { t } = useTranslation('admin');
  const iso = toIso(stat.lastInstalledAt);
  const relative = relativeLabel(iso);

  return (
    <tr className={styles.row}>
      <td className={styles.cell}>
        <div className={styles.packageCell}>
          <Tag size="small">{stat.manager}</Tag>
          <span className={styles.code}>{stat.package}</span>
        </div>
      </td>
      <td className={styles.numberCell}>{stat.installs}</td>
      <td className={styles.numberCell}>{stat.users}</td>
      <td className={styles.cell}>
        {relative ? (
          <Tooltip title={formatAbsolute(iso)}>
            <span>
              {t(
                `systemGeneral.sandbox.packages.relative.${relative.key}` as never,
                relative.count === undefined ? undefined : { count: relative.count },
              )}
            </span>
          </Tooltip>
        ) : (
          EM_DASH
        )}
      </td>
      <td className={styles.cell}>
        {stat.preinstalled ? (
          <Tag color="success" size="small">
            {t('systemGeneral.sandbox.packages.status.preinstalled')}
          </Tag>
        ) : (
          <Tag size="small">{t('systemGeneral.sandbox.packages.status.candidate')}</Tag>
        )}
      </td>
    </tr>
  );
});

PackageRow.displayName = 'AdminSandboxPackageRow';

export interface SandboxPackageStatsProps {
  service?: AdminSandboxSettingsService;
}

/**
 * What users install by hand inside the sandbox, counted over a window.
 *
 * It answers the one question the sandbox image raises after it ships — "what should have been in
 * it?" — with evidence instead of guesswork, and stays read-only: baking a package in is a
 * Dockerfile change, not a button.
 */
export const SandboxPackageStats = memo<SandboxPackageStatsProps>(
  ({ service = adminSystemService }) => {
    const { t } = useTranslation('admin');
    const [days, setDays] = useState<number>(DEFAULT_WINDOW_DAYS);

    const { data, error, isLoading, isValidating, mutate } = useSWR(
      ['admin-sandbox-package-stats', days],
      () => service.getSandboxPackageStats({ days, limit: PACKAGE_LIMIT }),
      { keepPreviousData: true, revalidateOnFocus: false },
    );

    const windowOptions = useMemo(
      () =>
        WINDOW_OPTIONS.map((value) => ({
          label: t('systemGeneral.sandbox.packages.window', { days: value }),
          value: String(value),
        })),
      [t],
    );

    return (
      <div className={styles.section}>
        <div className={styles.header}>
          <Text strong>{t('systemGeneral.sandbox.packages.title')}</Text>
          <div className={styles.controls}>
            <Select
              options={windowOptions}
              value={String(days)}
              onChange={(next) => setDays(Number(next))}
            />
            <Button
              disabled={isValidating}
              loading={isValidating}
              size="small"
              onClick={() => void mutate()}
            >
              {t('systemGeneral.sandbox.packages.refresh')}
            </Button>
          </div>
        </div>

        <Text type="secondary">{t('systemGeneral.sandbox.packages.description')}</Text>

        {error ? (
          <Alert
            showIcon
            message={t('systemGeneral.sandbox.packages.error')}
            type="warning"
            action={
              <Button size="small" onClick={() => void mutate()}>
                {t('systemGeneral.sandbox.packages.retry')}
              </Button>
            }
          />
        ) : null}

        {!data && isLoading ? <Skeleton active paragraph={{ rows: 4 }} title={false} /> : null}

        {data ? (
          <>
            <Text type="secondary">
              {t('systemGeneral.sandbox.packages.summary', {
                days: data.windowDays,
                preinstalled: data.preinstalled.length,
                total: data.totalPackages,
              })}
            </Text>

            {data.items.length === 0 ? (
              <Text type="secondary">{t('systemGeneral.sandbox.packages.empty')}</Text>
            ) : (
              <div className={styles.scroller}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th className={styles.headCell} scope="col">
                        {t('systemGeneral.sandbox.packages.columns.package')}
                      </th>
                      <th className={styles.headCell} scope="col">
                        {t('systemGeneral.sandbox.packages.columns.installs')}
                      </th>
                      <th className={styles.headCell} scope="col">
                        {t('systemGeneral.sandbox.packages.columns.users')}
                      </th>
                      <th className={styles.headCell} scope="col">
                        {t('systemGeneral.sandbox.packages.columns.lastInstalled')}
                      </th>
                      <th className={styles.headCell} scope="col">
                        {t('systemGeneral.sandbox.packages.columns.status')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((stat) => (
                      <PackageRow key={`${stat.manager}:${stat.package}`} stat={stat} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {data.items.length > 0 ? (
              <span className={styles.hint}>
                {t('systemGeneral.card.showingLatest', { count: data.items.length })}
              </span>
            ) : null}

            <span className={styles.hint}>{t('systemGeneral.sandbox.packages.hint')}</span>
          </>
        ) : null}
      </div>
    );
  },
);

SandboxPackageStats.displayName = 'AdminSandboxPackageStats';
