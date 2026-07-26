'use client';

import { Button, toast } from '@lobehub/ui/base-ui';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface ManagedSkillRetryButtonProps {
  disabled?: boolean;
  onRetry: () => Promise<unknown>;
}

export const ManagedSkillRetryButton = memo<ManagedSkillRetryButtonProps>(
  ({ disabled = false, onRetry }) => {
    const { t } = useTranslation('setting');
    const [retrying, setRetrying] = useState(false);

    return (
      <Button
        disabled={disabled || retrying}
        loading={retrying}
        size="small"
        type="text"
        onClick={async (event) => {
          event.stopPropagation();
          setRetrying(true);
          try {
            await onRetry();
          } catch {
            toast.error(t('platformSkills.runtime.refreshFailed'));
          } finally {
            setRetrying(false);
          }
        }}
      >
        {t('retry', { ns: 'common' })}
      </Button>
    );
  },
);

ManagedSkillRetryButton.displayName = 'ManagedSkillRetryButton';
