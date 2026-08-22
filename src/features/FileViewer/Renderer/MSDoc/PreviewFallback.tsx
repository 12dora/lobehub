'use client';

import { Center, Flexbox, FluentEmoji, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { type CSSProperties, memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { downloadFile } from '@/utils/client/downloadFile';

const styles = createStaticStyles(({ css, cssVar }) => ({
  page: css`
    width: 100%;
    margin: 12px;
    padding: 24px;
    border-radius: 4px;

    background: ${cssVar.colorBgContainer};
    box-shadow: ${cssVar.boxShadowTertiary};
  `,
}));

interface PreviewFallbackProps {
  /** Short, non-sensitive reason from the server, shown as secondary text. */
  description?: string;
  fileName?: string;
  style?: CSSProperties;
  title: string;
  /** Original office file URL — the download always stays available. */
  url?: string | null;
}

/**
 * Calm empty state for the cases where no rendition exists: it explains why and
 * still lets the user take the file with them.
 */
const PreviewFallback = memo<PreviewFallbackProps>(
  ({ title, description, fileName, url, style }) => {
    const { t } = useTranslation('file');
    const [loading, setLoading] = useState(false);

    return (
      <Flexbox className={styles.page} id={'msdoc-preview-fallback'} style={style}>
        <Center height={'100%'}>
          <Flexbox align={'center'} gap={12}>
            <FluentEmoji emoji={'👀'} size={64} />
            <Flexbox align={'center'} gap={4} style={{ textAlign: 'center' }}>
              <Text>{title}</Text>
              {description && (
                <Text style={{ fontSize: 12 }} type={'secondary'}>
                  {description}
                </Text>
              )}
            </Flexbox>
            {url && (
              <Button
                loading={loading}
                onClick={async () => {
                  setLoading(true);
                  await downloadFile(url, fileName || 'download');
                  setLoading(false);
                }}
              >
                {t('preview.downloadFile')}
              </Button>
            )}
          </Flexbox>
        </Center>
      </Flexbox>
    );
  },
);

export default PreviewFallback;
