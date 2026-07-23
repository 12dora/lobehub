'use client';

import { Flexbox, Text, TextArea } from '@lobehub/ui';
import { Checkbox } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { identityProviderStyles as styles } from '../styles';
import type { EditableDraft, PatchDraft } from './types';

interface PolicyStepProps {
  draft: EditableDraft;
  patch: PatchDraft;
}

/**
 * Policy step intentionally omits group-to-role mapping until runtime enforcement
 * exists. Publishing an unenforced map would create a false security guarantee.
 */
export const PolicyStep = memo<PolicyStepProps>(({ draft, patch }) => {
  const { t } = useTranslation('admin');

  return (
    <Flexbox gap={12}>
      <label>
        <Checkbox
          checked={draft.autoProvision}
          onChange={(checked) => patch('autoProvision', checked)}
        />{' '}
        {t('identityProviders.fields.autoProvision')}
      </label>
      <label className={styles.field}>
        <Text>{t('identityProviders.fields.domains')}</Text>
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
});

PolicyStep.displayName = 'PolicyStep';
