'use client';

import { Alert, CopyButton, Flexbox, Skeleton, Tooltip } from '@lobehub/ui';
import { Button, confirmModal, toast } from '@lobehub/ui/base-ui';
import { Fingerprint } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import type {
  AdminBrowserProfileOptions,
  AdminBrowserProfileSummary,
} from '@/enterprise/client/services/adminSystem';

import { InfraFieldRows, InfraSettingsCard } from '../InfraSettingsCard';
import { infraSettingsStyles as styles } from '../styles';
import { BrowserProfileFields } from './BrowserProfileFields';
import {
  adoptBrowserProfileSelection,
  type BrowserProfileDraft,
  type BrowserProfileSaveInput,
  browserProfileSelectionKey,
  completeBrowserProfileSelection,
  isBrowserProfileSelectionDirty,
  repairBrowserProfileSelection,
  visibleBrowserProfileOptions,
} from './browserProfileSelection';
import { infraFormStyles as formStyles } from './styles';

export interface BrowserProfileCardProps {
  canOperate: boolean;
  data?: AdminBrowserProfileSummary;
  error: unknown;
  isLoading: boolean;
  onRegenerate: () => Promise<void>;
  onRetry: () => void;
  onSave: (input: BrowserProfileSaveInput) => Promise<void>;
  /** The curated pools each field may be chosen from; absent until the options query answers. */
  options?: AdminBrowserProfileOptions;
}

const noop = () => undefined;

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
const formatPlatform = (platform: string, platformVersion: string): string => {
  const major = Number.parseInt(platformVersion, 10);
  if (platform === 'Windows' && Number.isFinite(major))
    return major >= 13 ? 'Windows 11' : 'Windows 10';
  return platformVersion ? `${platform} ${platformVersion}` : platform;
};

/** Installation-wide identity shared by every browser-impersonating transport. */
export const BrowserProfileCard = memo<BrowserProfileCardProps>(
  ({ canOperate, data, error, isLoading, onRegenerate, onRetry, onSave, options }) => {
    const { t } = useTranslation('admin');
    const [regenerating, setRegenerating] = useState(false);
    const [saving, setSaving] = useState(false);
    const [stale, setStale] = useState(false);
    const [draft, setDraft] = useState<BrowserProfileDraft>();

    // The summary reports the option ids alongside the values they resolved to.
    const storedKey = browserProfileSelectionKey(data);
    /**
     * A same-revision revalidation of the same six ids must leave an edit in progress
     * alone. A regeneration can land on those same ids (the pools are finite) while
     * minting a new revision and a new installation identity — that is a choice the
     * platform made, so it re-seeds too.
     */
    useEffect(() => setDraft(undefined), [data?.installationId, data?.revision, storedKey]);
    // Any revision the card has now caught up with is no longer the one it was refused on.
    useEffect(() => setStale(false), [data?.revision]);

    const settled = useMemo(() => adoptBrowserProfileSelection(options, data), [options, data]);
    const selection = draft ?? settled;
    const complete = useMemo(() => completeBrowserProfileSelection(selection), [selection]);
    const dirty = isBrowserProfileSelectionDirty(data, selection);

    const visible = useMemo(
      () => (options ? visibleBrowserProfileOptions(options, selection?.systemId) : undefined),
      [options, selection?.systemId],
    );

    /** Every change goes back through the settle step: a new machine invalidates its own hardware. */
    const patch = useCallback(
      (next: Partial<BrowserProfileDraft>) =>
        setDraft(repairBrowserProfileSelection(options, { ...selection, ...next })),
      [options, selection],
    );

    const generatedAt = useMemo(() => {
      if (!data) return undefined;
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(data.updatedAt);
    }, [data]);

    const requestRegenerate = useCallback(() => {
      confirmModal({
        // The shared cancel label, not a private copy of the same word.
        cancelText: t('cancel', { ns: 'common' }),
        content: t('browserProfile.confirm.description'),
        okButtonProps: { danger: true },
        okText: t('browserProfile.actions.regenerate'),
        title: t('browserProfile.confirm.title'),
        onOk: async () => {
          setRegenerating(true);
          try {
            await onRegenerate();
            // Even if the new summary reused the previous six ids, this click
            // produced a new fingerprint — drop the operator's unsaved draft.
            setDraft(undefined);
            toast.success(t('browserProfile.toast.regenerated'));
          } catch (cause) {
            toast.error(t('browserProfile.toast.failed'));
            throw cause;
          } finally {
            setRegenerating(false);
          }
        },
      });
    }, [onRegenerate, t]);

    const requestSave = useCallback(async () => {
      if (!complete || !data) return;
      setSaving(true);
      try {
        await onSave({ ...complete, expectedRevision: data.revision });
        toast.success(t('browserProfile.toast.saved'));
      } catch (cause) {
        // A refused save is not a failed one. The fingerprint moved under this form, so the six ids
        // on screen would reinstate what the other operator just replaced — say so, and offer the
        // reload, instead of inviting a retry of the same payload.
        if (mapEnterpriseError(cause)?.code === 'PLATFORM_REVISION_CONFLICT') {
          setStale(true);
          toast.error(t('systemGeneral.conflict.title'));
        } else {
          // The draft stays: the operator's choice is still on screen to retry or amend.
          toast.error(t('browserProfile.toast.saveFailed'));
        }
      } finally {
        setSaving(false);
      }
    }, [complete, data, onSave, t]);

    const requestReload = useCallback(() => {
      setStale(false);
      setDraft(undefined);
      onRetry();
    }, [onRetry]);

    const banner = error ? (
      <Alert
        showIcon
        description={t('browserProfile.states.errorDescription')}
        message={t('browserProfile.states.error')}
        type="error"
        action={
          <Button size="small" onClick={onRetry}>
            {t('browserProfile.actions.retry')}
          </Button>
        }
      />
    ) : stale ? (
      <Alert
        showIcon
        description={t('systemGeneral.conflict.description')}
        message={t('systemGeneral.conflict.title')}
        type="warning"
        action={
          <Button size="small" onClick={requestReload}>
            {t('systemGeneral.conflict.reload')}
          </Button>
        }
      />
    ) : !data && !isLoading ? (
      <Alert showIcon message={t('browserProfile.states.empty')} type="info" />
    ) : undefined;

    /** Minted, not chosen: regenerating is the only thing that moves either of them. */
    const installationIdField = {
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
    const generatedAtField = {
      label: t('browserProfile.fields.generatedAt'),
      value: generatedAt,
    };

    // Nothing to amend before there is a fingerprint: that card offers 生成 instead.
    const editing = canOperate && Boolean(data) && Boolean(selection) && Boolean(visible);

    return (
      <InfraSettingsCard
        banner={banner}
        canTest={false}
        icon={Fingerprint}
        notice={t('browserProfile.description')}
        probing={false}
        // The same binary the neighbouring infra cards report, through the same tag: this card
        // used to be the only one with an empty header-right, so its title row read as a
        // different component. `unknown` is the presentation the env-sourced cards land on too
        // (已配置), not the 正常 that a probed dependency earns.
        status={data ? 'unknown' : 'disabled'}
        title={t('browserProfile.title')}
        editor={
          isLoading && !data ? (
            <Skeleton active paragraph={{ rows: 5 }} title={false} />
          ) : editing ? (
            <div className={formStyles.stack}>
              <InfraFieldRows fields={[installationIdField, generatedAtField]} />
              <BrowserProfileFields
                disabled={saving || regenerating}
                options={visible!}
                selection={selection!}
                onChange={patch}
              />
            </div>
          ) : undefined
        }
        extraActions={
          canOperate ? (
            <>
              <Button
                // Regenerating is destructive and irreversible: never offered over a card that
                // has not resolved what it is about to replace.
                disabled={isLoading || Boolean(error)}
                loading={regenerating}
                size="small"
                onClick={requestRegenerate}
              >
                {t(data ? 'browserProfile.actions.regenerate' : 'browserProfile.actions.generate')}
              </Button>
              {editing ? (
                <Button
                  disabled={!dirty || !complete || regenerating}
                  loading={saving}
                  size="small"
                  type="primary"
                  onClick={() => void requestSave()}
                >
                  {t('browserProfile.actions.save')}
                </Button>
              ) : null}
              {editing && !complete ? (
                <span className={formStyles.hint}>{t('systemGeneral.edit.invalidDraft')}</span>
              ) : dirty && editing ? (
                <span className={formStyles.hint}>{t('browserProfile.states.dirty')}</span>
              ) : null}
            </>
          ) : null
        }
        fields={
          data
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
            : undefined
        }
        onTest={noop}
      />
    );
  },
);

BrowserProfileCard.displayName = 'AdminBrowserProfileCard';
