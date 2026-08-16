import { type MarkdownProps } from '@lobehub/ui';
import { Center, Markdown } from '@lobehub/ui';
import { useTranslation } from 'react-i18next';

import { useBranding } from '@/enterprise/client/providers/RuntimeBrandingProvider';

const ChatPreview = ({ fontSize }: Pick<MarkdownProps, 'fontSize'>) => {
  const { t } = useTranslation('welcome');
  const branding = useBranding();
  return (
    <Center>
      <Markdown fontSize={fontSize} variant={'chat'}>
        {t('guide.defaultMessageWithoutCreate', {
          appName: branding.name,
        })}
      </Markdown>
    </Center>
  );
};

export default ChatPreview;
