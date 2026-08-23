'use client';

import { Flexbox } from '@lobehub/ui';
import { createModal, type ModalInstance } from '@lobehub/ui/base-ui';
import { Steps } from 'antd';
import { t as i18nT } from 'i18next';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import DeviceStep from './DeviceStep';
import PlatformStep from './PlatformStep';
import ProfileStep from './ProfileStep';
import StepFooter from './StepFooter';
import { useCreatePlatformAgentForm } from './useCreatePlatformAgentForm';

interface CreatePlatformAgentContentProps {
  groupId?: string;
  visibility?: 'private' | 'public';
}

const CreatePlatformAgentContent = memo<CreatePlatformAgentContentProps>(
  ({ groupId, visibility }) => {
    const { t } = useTranslation('chat');
    const form = useCreatePlatformAgentForm({ groupId, visibility });

    return (
      <Flexbox gap={24} paddingBlock={'16px 8px'}>
        <Steps
          current={form.step}
          size="small"
          items={[
            { title: t('platformAgent.create.step1') },
            { title: t('platformAgent.create.step2') },
            { title: t('platformAgent.create.step3') },
          ]}
        />
        {form.step === 0 && (
          <PlatformStep platform={form.platform} onSelect={form.handlePlatformChange} />
        )}
        {form.step === 1 && (
          <DeviceStep
            capabilityResult={form.capabilityResult}
            checkingCapability={form.checkingCapability}
            deviceId={form.deviceId}
            devices={form.devices}
            isRefreshing={form.isRefreshingDevices}
            platformName={form.selectedPlatformName}
            restrictToWorkspaceDevices={form.restrictToWorkspaceDevices}
            onDeviceChange={form.handleDeviceChange}
            onRefresh={() => void form.refetchDevices()}
          />
        )}
        {form.step === 2 && (
          <ProfileStep
            agentDescription={form.agentDescription}
            agentName={form.agentName}
            avatar={form.agentProfile?.avatar}
            fetchingProfile={form.fetchingProfile}
            onDescriptionChange={form.setAgentDescription}
            onNameChange={form.setAgentName}
            onSubmit={() => void form.handleCreate()}
          />
        )}
        <StepFooter
          creating={form.creating}
          deviceStepNextDisabled={form.deviceStepNextDisabled}
          step={form.step}
          onBack={form.handleBack}
          onCreate={() => void form.handleCreate()}
          onNext={form.handleNext}
        />
      </Flexbox>
    );
  },
);

CreatePlatformAgentContent.displayName = 'CreatePlatformAgentContent';

interface OpenCreatePlatformAgentModalOptions {
  groupId?: string;
  visibility?: 'private' | 'public';
}

export const openCreatePlatformAgentModal = (
  options?: OpenCreatePlatformAgentModalOptions,
): ModalInstance =>
  createModal({
    content: (
      <CreatePlatformAgentContent groupId={options?.groupId} visibility={options?.visibility} />
    ),
    footer: null,
    maskClosable: true,
    title: i18nT('platformAgent.create.title', { ns: 'chat' }),
    width: 480,
  });
