'use client';

import { Flexbox, Text, TextArea } from '@lobehub/ui';
import { Checkbox } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { IdentityProviderCallbackUrls } from '../controller';
import { identityProviderStyles as styles } from '../styles';
import { DingTalkAllowedCorpsField } from './DingTalkAllowedCorpsField';
import type { EditableDraft, PatchDraft } from './types';

interface PolicyStepProps {
  callbacks?: IdentityProviderCallbackUrls;
  captureBlockedReason?: string | null;
  captureError?: string | null;
  capturing?: boolean;
  draft: EditableDraft;
  onCaptureCorp?: () => void;
  onCopyUrl?: (url: string) => void;
  patch: PatchDraft;
}

/**
 * Group-to-role mapping is enforced at login via `reconcileIdentityProviderGroupRoles`.
 * The editor UI remains deferred (separate product surface); drafts may still carry
 * a persisted `groupRoleMapping` from the API without editing it here.
 */
export const PolicyStep = memo<PolicyStepProps>(
  ({
    callbacks,
    capturing,
    captureBlockedReason,
    captureError,
    draft,
    onCaptureCorp,
    onCopyUrl,
    patch,
  }) => {
    const { t } = useTranslation('admin');

    return (
      <Flexbox gap={16}>
        {draft.type === 'dingtalk' ? (
          <DingTalkAllowedCorpsField
            callbacks={callbacks}
            captureBlockedReason={captureBlockedReason ?? null}
            captureError={captureError}
            capturing={Boolean(capturing)}
            draft={draft}
            patch={patch}
            onCapture={() => onCaptureCorp?.()}
            onCopyUrl={onCopyUrl}
          />
        ) : null}
        <label>
          <Checkbox
            checked={draft.autoProvision}
            onChange={(checked) => patch('autoProvision', checked)}
          />{' '}
          {t('identityProviders.fields.autoProvision')}
        </label>
        <label className={styles.field}>
          <Text>{t('identityProviders.fields.domains')}</Text>
          {draft.type === 'dingtalk' ? (
            <Text type="secondary">{t('identityProviders.dingtalk.domainsWarning')}</Text>
          ) : null}
          <TextArea
            rows={4}
            value={draft.domainAllowlist.join('\n')}
            onChange={(e) =>
              patch(
                'domainAllowlist',
                e.target.value
                  .split(/[,\n]/)
                  .map((value) => value.trim())
                  .filter(Boolean),
              )
            }
          />
        </label>
      </Flexbox>
    );
  },
);

PolicyStep.displayName = 'PolicyStep';
