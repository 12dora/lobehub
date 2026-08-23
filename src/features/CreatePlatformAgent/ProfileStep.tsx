'use client';

import { Flexbox } from '@lobehub/ui';
import { Input } from 'antd';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { styles } from './style';

interface ProfileStepProps {
  agentDescription: string;
  agentName: string;
  avatar: string | undefined;
  fetchingProfile: boolean;
  onDescriptionChange: (value: string) => void;
  onNameChange: (value: string) => void;
  onSubmit: () => void;
}

const ProfileStep = memo<ProfileStepProps>(
  ({
    agentDescription,
    agentName,
    avatar,
    fetchingProfile,
    onDescriptionChange,
    onNameChange,
    onSubmit,
  }) => {
    const { t } = useTranslation('chat');

    return (
      <Flexbox gap={12}>
        {avatar && (
          <Flexbox horizontal align="center" gap={12}>
            <div className={styles.avatarPreview}>{avatar}</div>
          </Flexbox>
        )}
        <Input
          maxLength={60}
          value={agentName}
          placeholder={
            fetchingProfile
              ? t('platformAgent.create.fetchingProfile')
              : t('platformAgent.create.namePlaceholder')
          }
          onChange={(e) => onNameChange(e.target.value)}
          onPressEnter={onSubmit}
        />
        <Input.TextArea
          autoSize={{ maxRows: 4, minRows: 2 }}
          maxLength={200}
          placeholder={t('platformAgent.create.descriptionPlaceholder')}
          value={agentDescription}
          onChange={(e) => onDescriptionChange(e.target.value)}
        />
      </Flexbox>
    );
  },
);

ProfileStep.displayName = 'ProfileStep';

export default ProfileStep;
