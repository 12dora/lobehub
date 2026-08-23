'use client';

import { Flexbox } from '@lobehub/ui';
import { Button as BaseButton } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

interface StepFooterProps {
  creating: boolean;
  deviceStepNextDisabled: boolean;
  onBack: () => void;
  onCreate: () => void;
  onNext: () => void;
  step: number;
}

const StepFooter = memo<StepFooterProps>(
  ({ creating, deviceStepNextDisabled, onBack, onCreate, onNext, step }) => {
    const { t } = useTranslation('chat');

    const buttons = [];

    if (step > 0) {
      buttons.push(
        <BaseButton key="back" onClick={onBack}>
          {t('platformAgent.create.back')}
        </BaseButton>,
      );
    }

    if (step < 2) {
      const nextDisabled = step === 1 && deviceStepNextDisabled;
      buttons.push(
        <BaseButton disabled={nextDisabled} key="next" type="primary" onClick={onNext}>
          {t('platformAgent.create.next')}
        </BaseButton>,
      );
    }

    if (step === 2) {
      buttons.push(
        <BaseButton key="create" loading={creating} type="primary" onClick={onCreate}>
          {creating ? t('platformAgent.create.creating') : t('platformAgent.create.create')}
        </BaseButton>,
      );
    }

    return (
      <Flexbox horizontal gap={8} justify={'flex-end'}>
        {buttons}
      </Flexbox>
    );
  },
);

StepFooter.displayName = 'StepFooter';

export default StepFooter;
