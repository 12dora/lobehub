'use client';

import { Text, TextArea } from '@lobehub/ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { identityProviderStyles as styles } from '../styles';

interface ClaimsStepProps {
  claimJson: string;
  invalidJson: boolean;
  onClaimJsonChange: (raw: string) => void;
}

export const ClaimsStep = memo<ClaimsStepProps>(({ claimJson, invalidJson, onClaimJsonChange }) => {
  const { t } = useTranslation('admin');

  return (
    <label className={styles.field}>
      <Text>{t('identityProviders.fields.claimMapping')}</Text>
      <TextArea rows={14} value={claimJson} onChange={(e) => onClaimJsonChange(e.target.value)} />
      {invalidJson ? <Text type="danger">{t('identityProviders.errors.invalidJson')}</Text> : null}
    </label>
  );
});

ClaimsStep.displayName = 'ClaimsStep';
