'use client';

import { CopyButton, Flexbox, Tooltip } from '@lobehub/ui';
import type { TFunction } from 'i18next';

import type {
  AdminBrowserProfileOptions,
  AdminBrowserProfileSummary,
} from '@/enterprise/client/services/adminSystem';

import type { Field } from '../InfraSettingsCard';
import { infraSettingsStyles as styles } from '../styles';

/**
 * What an operator calls the operating system, from what the profile reports as a UA client
 * hint.
 *
 * Windows reports its `Sec-CH-UA-Platform-Version` on a scale of its own: Windows 11 is 13+,
 * Windows 10 is 1–12, and printing it raw put "Windows 15.0.0" on the card — a release that
 * does not exist. macOS and the rest already report their marketing version, so they are
 * joined verbatim; a profile without a version prints the platform alone rather than a
 * dangling separator.
 */
export const formatPlatform = (platform: string, platformVersion: string): string => {
  const major = Number.parseInt(platformVersion, 10);
  if (platform === 'Windows' && Number.isFinite(major))
    return major >= 13 ? 'Windows 11' : 'Windows 10';
  return platformVersion ? `${platform} ${platformVersion}` : platform;
};

export interface BrowserProfileSummaryInput {
  data?: AdminBrowserProfileSummary;
  generatedAt?: string;
  options?: AdminBrowserProfileOptions;
  t: TFunction<'admin'>;
}

export interface BrowserProfileFieldSet {
  /** 详情 spells out the three dimensions the summary has no room for. */
  detailsFields: Field[];
  /** Minted, not chosen: regenerating is the only thing that moves either of them. */
  generatedAtField: Field;
  installationIdField: Field;
  summaryFields: Field[];
}

/** The identity itself, then the four dimensions upstream actually fingerprints on. */
export const buildBrowserProfileSummary = ({
  data,
  generatedAt,
  options,
  t,
}: BrowserProfileSummaryInput): BrowserProfileFieldSet => {
  const installationIdField: Field = {
    label: t('browserProfile.fields.installationId'),
    /**
     * In full, and copyable. It is not a secret — it identifies this deployment to upstream and
     * is what an operator quotes in a support thread — and the 8-char mask it used to carry
     * could neither be read nor copied.
     */
    value: data ? (
      <Flexbox horizontal align={'center'} gap={4} justify={'flex-end'}>
        <span className={styles.code}>{data.installationId}</span>
        <CopyButton content={data.installationId} size={'small'} />
      </Flexbox>
    ) : undefined,
  };
  const generatedAtField: Field = {
    label: t('browserProfile.fields.generatedAt'),
    value: generatedAt,
  };

  const summaryFields: Field[] = data
    ? [
        installationIdField,
        {
          label: t('browserProfile.fields.chrome'),
          /**
           * The version, once. The curl-impersonate target name next to it repeated the
           * same major version in jargon; it stays reachable on hover for the operator
           * who is diagnosing a transport, and off the card for everyone else.
           */
          value: (
            <Tooltip
              title={t('browserProfile.values.impersonateProfile', {
                profile: data.impersonateProfile,
              })}
            >
              <span>{data.chromeVersion}</span>
            </Tooltip>
          ),
        },
        {
          label: t('browserProfile.fields.platform'),
          value: `${formatPlatform(data.platform, data.platformVersion)} · ${data.arch}`,
        },
        {
          label: t('browserProfile.fields.localeTimezone'),
          value: `${data.locale} · ${data.timezone}`,
        },
        generatedAtField,
      ]
    : [];

  return {
    detailsFields: data
      ? [
          ...summaryFields.slice(0, 4),
          {
            label: t('browserProfile.fields.screen'),
            value: t('browserProfile.values.screen', data.screen),
          },
          {
            label: t('browserProfile.fields.compute'),
            value: t('browserProfile.values.compute', {
              cores: data.cores,
              memory: data.memoryGiB,
            }),
          },
          {
            label: t('browserProfile.fields.webgl'),
            // The summary reports the GPU only as the option it was chosen from.
            value: options?.webgl.find((entry) => entry.id === data.webglId)?.label,
          },
          generatedAtField,
        ]
      : [],
    generatedAtField,
    installationIdField,
    summaryFields,
  };
};
