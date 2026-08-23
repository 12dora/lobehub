'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { formatIdentityProviderAutoSavedAt } from './persist';

export interface IdentityProviderWizardFooterProps {
  atFirstStep: boolean;
  busy: string | null;
  canCreate: boolean;
  canUpdate: boolean;
  conflictRefreshFailed: boolean;
  dirty: boolean;
  editing: boolean;
  invalidJson: boolean;
  isLastStep: boolean;
  lastAutoSavedAt: Date | null;
  onNext: () => void;
  onPrevious: () => void;
  onPublish: () => void;
  onSave: () => void;
  publishReady: boolean;
}

/**
 * The wizard's action row: where it is in the sequence on the left, and what it can do about the
 * draft on the right.
 *
 * 保存 stops being the primary action on the last step because 发布 takes over there — the operator
 * is done editing and the one thing left to do is publish. The save button stays enabled while the
 * draft is merely incomplete (a half-filled draft is a legitimate thing to keep); it is only the
 * two states that make a write impossible — malformed claim JSON and a conflict we could not
 * re-read — plus the missing permission itself that take it away.
 */
export const IdentityProviderWizardFooter = memo<IdentityProviderWizardFooterProps>(
  ({
    atFirstStep,
    busy,
    canCreate,
    canUpdate,
    conflictRefreshFailed,
    dirty,
    editing,
    invalidJson,
    isLastStep,
    lastAutoSavedAt,
    onNext,
    onPrevious,
    onPublish,
    onSave,
    publishReady,
  }) => {
    const { t } = useTranslation('admin');

    return (
      <Flexbox horizontal align="center" justify="space-between">
        <Button disabled={atFirstStep} onClick={onPrevious}>
          {t('identityProviders.actions.previous')}
        </Button>
        <Flexbox horizontal align="center" gap={8}>
          {lastAutoSavedAt ? (
            <Text type="secondary">
              {t('identityProviders.save.autoSaved', {
                time: formatIdentityProviderAutoSavedAt(lastAutoSavedAt),
              })}
            </Text>
          ) : dirty ? (
            <Text type="secondary">{t('identityProviders.unsaved')}</Text>
          ) : null}
          <Button
            disabled={invalidJson || conflictRefreshFailed || (editing ? !canUpdate : !canCreate)}
            loading={busy === 'save'}
            type={isLastStep ? 'default' : 'primary'}
            onClick={onSave}
          >
            {t('identityProviders.actions.save')}
          </Button>
          {isLastStep ? (
            <Button
              disabled={!publishReady}
              loading={busy === 'publish'}
              type="primary"
              onClick={onPublish}
            >
              {t('identityProviders.actions.publish')}
            </Button>
          ) : (
            <Button disabled={invalidJson} onClick={onNext}>
              {t('identityProviders.actions.next')}
            </Button>
          )}
        </Flexbox>
      </Flexbox>
    );
  },
);

IdentityProviderWizardFooter.displayName = 'IdentityProviderWizardFooter';
