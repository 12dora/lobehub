'use client';

import { Alert, Skeleton } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { Fingerprint } from 'lucide-react';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  AdminBrowserProfileOptions,
  AdminBrowserProfileSummary,
} from '@/enterprise/client/services/adminSystem';

import { InfraFieldRows, InfraSettingsCard } from '../InfraSettingsCard';
import { BrowserProfileFields } from './BrowserProfileFields';
import type { BrowserProfileSaveInput } from './browserProfileSelection';
import { buildBrowserProfileSummary } from './browserProfileSummary';
import { infraFormStyles as formStyles } from './styles';
import { useBrowserProfileEditor } from './useBrowserProfileEditor';

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

/** Installation-wide identity shared by every browser-impersonating transport. */
export const BrowserProfileCard = memo<BrowserProfileCardProps>(
  ({ canOperate, data, error, isLoading, onRegenerate, onRetry, onSave, options }) => {
    const { t } = useTranslation('admin');

    const editor = useBrowserProfileEditor({
      canOperate,
      data,
      onRegenerate,
      onRetry,
      onSave,
      options,
      t,
    });

    const generatedAt = useMemo(() => {
      if (!data) return undefined;
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(data.updatedAt);
    }, [data]);

    const { detailsFields, generatedAtField, installationIdField, summaryFields } = useMemo(
      () => buildBrowserProfileSummary({ data, generatedAt, options, t }),
      [data, generatedAt, options, t],
    );

    /**
     * One state at a time, in the order that decides what the operator can do next: a failed read
     * offers 重试, a write refused on a moved revision offers the reload that makes a retry
     * meaningful, and only a settled card with nothing in it says there is no fingerprint yet.
     */
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
    ) : editor.stale ? (
      <Alert
        showIcon
        description={t('systemGeneral.conflict.description')}
        message={t('systemGeneral.conflict.title')}
        type="warning"
        action={
          <Button size="small" onClick={editor.requestReload}>
            {t('systemGeneral.conflict.reload')}
          </Button>
        }
      />
    ) : !data && !isLoading ? (
      <Alert showIcon message={t('browserProfile.states.empty')} type="info" />
    ) : undefined;

    return (
      <InfraSettingsCard
        banner={banner}
        canTest={false}
        detailsFields={detailsFields}
        editOpen={editor.editModal.open}
        fields={summaryFields}
        icon={Fingerprint}
        probing={false}
        // The same binary the neighbouring infra cards report, through the same tag: this card
        // used to be the only one with an empty header-right, so its title row read as a
        // different component. `unknown` is the presentation the env-sourced cards land on too
        // (已配置), not the 正常 that a probed dependency earns.
        status={data ? 'unknown' : 'disabled'}
        title={t('browserProfile.title')}
        editActions={
          editor.editing ? (
            <>
              {!editor.complete ? (
                <span className={formStyles.hint}>{t('systemGeneral.edit.invalidDraft')}</span>
              ) : editor.dirty ? (
                <span className={formStyles.hint}>{t('browserProfile.states.dirty')}</span>
              ) : null}
              <Button disabled={editor.saving} size="small" onClick={editor.editModal.requestClose}>
                {t('systemGeneral.edit.cancel')}
              </Button>
              <Button
                disabled={!editor.dirty || !editor.complete || editor.regenerating}
                loading={editor.saving}
                size="small"
                type="primary"
                onClick={() => void editor.requestSave()}
              >
                {t('browserProfile.actions.save')}
              </Button>
            </>
          ) : undefined
        }
        editor={
          editor.editing ? (
            <div className={formStyles.stack}>
              <InfraFieldRows fields={[installationIdField, generatedAtField]} />
              <BrowserProfileFields
                disabled={editor.saving || editor.regenerating}
                options={editor.visible!}
                selection={editor.selection!}
                onChange={editor.patch}
              />
            </div>
          ) : undefined
        }
        extraActions={
          canOperate ? (
            <Button
              // Regenerating is destructive and irreversible: never offered over a card that
              // has not resolved what it is about to replace.
              disabled={isLoading || Boolean(error)}
              loading={editor.regenerating}
              size="small"
              onClick={editor.requestRegenerate}
            >
              {t(data ? 'browserProfile.actions.regenerate' : 'browserProfile.actions.generate')}
            </Button>
          ) : null
        }
        summary={
          isLoading && !data ? <Skeleton active paragraph={{ rows: 5 }} title={false} /> : undefined
        }
        onEditOpenChange={editor.editModal.onOpenChange}
        onTest={noop}
      />
    );
  },
);

BrowserProfileCard.displayName = 'AdminBrowserProfileCard';
