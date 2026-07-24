'use client';

import { Button } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

export interface SkillDetailActionsProps {
  /** Combined busy / conflict / refresh-lock gate for non-archive actions. */
  actionsDisabled: boolean;
  /** Archive also blocks when the identity editor is dirty. */
  archiveDisabled: boolean;
  canArchive: boolean;
  canPublish: boolean;
  canPublishSelected: boolean;
  canUpdate: boolean;
  /** When true, validate/publish hide; save identity may appear instead. */
  dirty: boolean;
  identityDirty: boolean;
  isArchived: boolean;
  onArchive: () => void;
  onCreateVersion: () => void;
  onPublish: () => void;
  onSaveIdentity: () => void;
  onValidate: () => void;
  saveFailed: boolean;
  selectedVersionId?: string;
}

/**
 * Header action matrix for the skill detail page.
 * Visibility is permission- and state-gated; disabled state is owned by the parent.
 */
const SkillDetailActions = memo<SkillDetailActionsProps>(
  ({
    actionsDisabled,
    archiveDisabled,
    canArchive,
    canPublish,
    canPublishSelected,
    canUpdate,
    dirty,
    identityDirty,
    isArchived,
    onArchive,
    onCreateVersion,
    onPublish,
    onSaveIdentity,
    onValidate,
    saveFailed,
    selectedVersionId,
  }) => {
    const { t } = useTranslation('admin');
    const navigate = useNavigate();

    return (
      <>
        <Button onClick={() => navigate('/admin/skills')}>{t('skillCatalog.detail.back')}</Button>
        {canUpdate && !isArchived ? (
          <Button disabled={actionsDisabled} onClick={onCreateVersion}>
            {t('skillCatalog.version.create')}
          </Button>
        ) : null}
        {canUpdate && !isArchived && identityDirty ? (
          <Button disabled={actionsDisabled} type="primary" onClick={onSaveIdentity}>
            {saveFailed
              ? t('skillCatalog.actions.save.retry')
              : t('skillCatalog.actions.save.label')}
          </Button>
        ) : null}
        {canUpdate && !isArchived && selectedVersionId && !dirty ? (
          <Button disabled={actionsDisabled} onClick={onValidate}>
            {t('skillCatalog.actions.validate.label')}
          </Button>
        ) : null}
        {canPublish && !isArchived && selectedVersionId && canPublishSelected && !dirty ? (
          <Button disabled={actionsDisabled} type="primary" onClick={onPublish}>
            {t('skillCatalog.actions.publish.label')}
          </Button>
        ) : null}
        {canArchive && !isArchived ? (
          <Button danger disabled={archiveDisabled} onClick={onArchive}>
            {t('skillCatalog.actions.archive.label')}
          </Button>
        ) : null}
      </>
    );
  },
);

SkillDetailActions.displayName = 'SkillDetailActions';

export default SkillDetailActions;
