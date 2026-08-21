'use client';

import { Center, Flexbox, Icon, Text } from '@lobehub/ui';
import { LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * The inline loader used by every route / Suspense fallback.
 *
 * `role="status"` lives here rather than on the caller: `BrandTextLoading`'s
 * fullscreen brand branch announces itself, and its inline (and custom-branding)
 * branches render this instead — without the role they were silent to screen
 * readers. The visible label doubles as the accessible name.
 */
const CircleLoading = () => {
  const { t } = useTranslation('common');
  return (
    <Center aria-label={t('loading')} height={'100%'} role={'status'} width={'100%'}>
      <Flexbox align={'center'} gap={8}>
        <div>
          <Icon spin icon={LoaderCircle} size={'large'} />
        </div>
        <Text style={{ letterSpacing: '0.1em' }} type={'secondary'}>
          {t('loading')}
        </Text>
      </Flexbox>
    </Center>
  );
};

export default CircleLoading;
