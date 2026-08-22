'use client';

import { Center, Flexbox, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import NeuralNetworkLoading from '@/components/NeuralNetworkLoading';

interface PreparingProps {
  /** We stopped waiting — tell the user and hand them the next move. */
  onRetry?: () => void;
  timedOut?: boolean;
}

/**
 * Conversion is running (or has been running for a while). Always says what is
 * happening, never a bare spinner.
 */
const Preparing = memo<PreparingProps>(({ timedOut, onRetry }) => {
  const { t } = useTranslation('file');

  return (
    <Center height={'100%'} id={'msdoc-preview-preparing'} width={'100%'}>
      <Flexbox align={'center'} gap={12}>
        {!timedOut && <NeuralNetworkLoading size={36} />}
        <Flexbox align={'center'} gap={4} style={{ textAlign: 'center' }}>
          <Text>{timedOut ? t('preview.document.slow') : t('preview.document.preparing')}</Text>
          <Text style={{ fontSize: 12 }} type={'secondary'}>
            {timedOut ? t('preview.document.slowDesc') : t('preview.document.preparingDesc')}
          </Text>
        </Flexbox>
        {timedOut && onRetry && <Button onClick={onRetry}>{t('preview.document.retry')}</Button>}
      </Flexbox>
    </Center>
  );
});

export default Preparing;
