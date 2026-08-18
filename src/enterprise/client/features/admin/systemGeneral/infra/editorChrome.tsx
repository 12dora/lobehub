'use client';

import { Alert, Tag } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { InfraSettingsSource } from './types';

/** Where the effective configuration comes from — the precedence rule is per card, all-or-nothing. */
export const InfraSourceTag = memo<{ source: InfraSettingsSource }>(({ source }) => {
  const { t } = useTranslation('admin');
  return (
    <Tag color={source === 'db' ? 'primary' : 'default'} size="small">
      {t(source === 'db' ? 'systemGeneral.source.db' : 'systemGeneral.source.env')}
    </Tag>
  );
});

InfraSourceTag.displayName = 'AdminInfraSourceTag';

/**
 * Folding a card hides its 保存 along with the form. The header is what stays, so it is where an
 * edit that has not been written yet has to be visible — the navigation guard only speaks up when
 * the operator leaves the page, which is far too late to notice a card they folded away.
 */
export const InfraUnsavedTag = memo(() => {
  const { t } = useTranslation('admin');
  return (
    <Tag color="warning" size="small">
      {t('systemGeneral.unsaved.title')}
    </Tag>
  );
});

InfraUnsavedTag.displayName = 'AdminInfraUnsavedTag';

export interface InfraEditorAlertsProps {
  /** CAS mismatch on save — the other admin's version has to be loaded first. */
  conflict: boolean;
  onReload: () => void;
  /** The server snapshot moved while this draft was dirty. */
  stale: boolean;
}

/** Both states end in the same offer: load the current server version, then re-apply the change. */
export const InfraEditorAlerts = memo<InfraEditorAlertsProps>(({ conflict, onReload, stale }) => {
  const { t } = useTranslation('admin');
  if (!conflict && !stale) return null;

  return (
    <Alert
      showIcon
      message={t(conflict ? 'systemGeneral.conflict.title' : 'systemGeneral.stale.title')}
      type="warning"
      action={
        <Button size="small" onClick={onReload}>
          {t('systemGeneral.conflict.reload')}
        </Button>
      }
      description={t(
        conflict ? 'systemGeneral.conflict.description' : 'systemGeneral.stale.description',
      )}
    />
  );
});

InfraEditorAlerts.displayName = 'AdminInfraEditorAlerts';

/**
 * The saved override exists (`enabled`) but is not what the platform is running (`source: 'env'`) —
 * the server could not decrypt or load it and failed open to the environment. Left unlabelled this
 * looks like an ordinary environment-owned card, and the next 保存 would quietly overwrite a
 * configuration the admin never saw.
 */
export const isInfraFailOpen = (view: { enabled: boolean; source: InfraSettingsSource }): boolean =>
  view.enabled && view.source === 'env';

export const InfraFailOpenAlert = memo(() => {
  const { t } = useTranslation('admin');
  return (
    <Alert
      showIcon
      description={t('systemGeneral.failOpen.description')}
      message={t('systemGeneral.failOpen.title')}
      type="warning"
    />
  );
});

InfraFailOpenAlert.displayName = 'AdminInfraFailOpenAlert';

export interface InfraEditorActionsProps {
  /** Abandon the takeover — only offered while the environment still owns the card. */
  canCancel: boolean;
  /** Hand the dependency back to the environment — needs a saved override to switch off. */
  canRevert: boolean;
  dirty: boolean;
  /** A credential must be re-entered before anything can be written. */
  invalid: boolean;
  /** Conflict / stale — a reload has to happen first. */
  locked: boolean;
  onCancel: () => void;
  onRevert: () => void;
  onSave: () => void;
  saving: boolean;
  source: InfraSettingsSource;
}

/**
 * 保存 plus the way back: an environment-sourced card can abandon the switch, a card that is
 * already managed here (or one whose saved override failed to load) can hand the dependency back
 * to the environment.
 */
export const InfraEditorActions = memo<InfraEditorActionsProps>(
  ({
    canCancel,
    canRevert,
    dirty,
    invalid,
    locked,
    onCancel,
    onRevert,
    onSave,
    saving,
    source,
  }) => {
    const { t } = useTranslation('admin');

    return (
      <>
        <Button
          disabled={locked || invalid || (source === 'db' && !dirty)}
          loading={saving}
          size="small"
          type="primary"
          onClick={onSave}
        >
          {t('systemGeneral.edit.save')}
        </Button>
        {canRevert ? (
          <Button danger disabled={locked || saving} size="small" onClick={onRevert}>
            {t('systemGeneral.edit.revert')}
          </Button>
        ) : null}
        {canCancel ? (
          <Button disabled={saving} size="small" onClick={onCancel}>
            {t('systemGeneral.edit.cancel')}
          </Button>
        ) : null}
      </>
    );
  },
);

InfraEditorActions.displayName = 'AdminInfraEditorActions';
