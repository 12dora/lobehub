import { createStaticStyles } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

const styles = createStaticStyles(({ css, cssVar }) => ({
  container: css`
    padding-block: 4px;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
}));

interface TruncationNoticeProps {
  finishReason?: string;
}

const TruncationNotice = memo<TruncationNoticeProps>(({ finishReason }) => {
  const { t } = useTranslation('chat');

  if (finishReason !== 'length') return null;

  return (
    <div className={styles.container}>
      {t('messageAction.truncated')} · {t('messageAction.truncatedHint')}
    </div>
  );
});

TruncationNotice.displayName = 'TruncationNotice';

export default TruncationNotice;
