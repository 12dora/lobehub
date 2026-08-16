import { Block, Flexbox, Icon, Text } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';
import { ShieldAlert } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { getModerationCategoryLabel } from '@/utils/locale/moderationCategory';

const styles = createStaticStyles(({ css, cssVar }) => ({
  category: css`
    color: ${cssVar.colorTextTertiary};
  `,
  icon: css`
    padding-block-start: 2px;
    color: ${cssVar.colorTextTertiary};
  `,
  message: css`
    white-space: pre-wrap;
  `,
}));

interface ModerationBlockedErrorProps {
  /** Raw category from the error body — unknown values are ignored. */
  category?: unknown;
  /** Admin-configured block copy (`blockMessage`). Rendered as plain text, never markdown. */
  message?: string;
}

/**
 * 内容审计 block card: the request never reached the model, so this is a calm, final statement
 * rather than a failure report — no trace id, no diagnostics dump. Retry stays where every other
 * message keeps it (the message action bar). Design: docs/enterprise/content-moderation.md §3.6.
 */
const ModerationBlockedError = memo<ModerationBlockedErrorProps>(({ category, message }) => {
  const { t } = useTranslation(['error', 'common']);

  const categoryLabel = getModerationCategoryLabel(t, category);

  return (
    <Block
      horizontal
      align={'flex-start'}
      gap={12}
      padding={16}
      style={{ overflow: 'hidden', position: 'relative', width: '100%' }}
      variant={'outlined'}
    >
      <Icon className={styles.icon} icon={ShieldAlert} size={20} />
      <Flexbox gap={4} style={{ flex: 1, minWidth: 0 }}>
        <Text weight={500}>
          {t(`response.${PLATFORM_ERROR_CODES.PLATFORM_CONTENT_MODERATION_BLOCKED}`, {
            ns: 'error',
          })}
        </Text>
        {!!message && (
          <Text
            className={styles.message}
            ellipsis={{ rows: 4, tooltipWhenOverflow: true }}
            fontSize={12}
            type={'secondary'}
          >
            {message}
          </Text>
        )}
        {!!categoryLabel && (
          <Text className={styles.category} fontSize={12}>
            {categoryLabel}
          </Text>
        )}
      </Flexbox>
    </Block>
  );
});

ModerationBlockedError.displayName = 'ModerationBlockedError';

export default ModerationBlockedError;
