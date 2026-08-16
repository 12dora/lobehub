import { type MessageModerationMetadata } from '@lobechat/types';
import { Flexbox, Icon } from '@lobehub/ui';
import { Tooltip } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { ShieldCheck } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { aiModelSelectors, useAiInfraStore } from '@/store/aiInfra';
import { getModerationCategoryLabel } from '@/utils/locale/moderationCategory';

const styles = createStaticStyles(({ css, cssVar }) => ({
  container: css`
    width: fit-content;
    font-size: 12px;
    line-height: 20px;
    color: ${cssVar.colorTextSecondary};
  `,
}));

interface ModerationNoticeProps {
  moderation?: MessageModerationMetadata;
}

/**
 * Substitute every `{{model}}` occurrence in the admin-configured override.
 *
 * Deliberately NOT routed through i18next interpolation: the text is operator input travelling on a
 * response header, and i18next would treat other `{{…}}` sequences in it as keys / nesting. A plain
 * string replace keeps it inert — React renders the result as text, so no escaping is required.
 *
 * The replacement is a FUNCTION, not a string: a string replacement would interpret `$&`, `` $` ``
 * and `$'` inside a model display name and re-inject the surrounding text.
 */
const applyModelPlaceholder = (message: string, model: string): string =>
  message.replaceAll('{{model}}', () => model);

/**
 * 内容审计 downgrade notice: the reply the user is reading came from a fallback model. It sits
 * above the reply text (not in the extra area below it) so the reader knows before reading, and
 * it renders from persisted message metadata so it survives a reload.
 * Design: docs/enterprise/content-moderation.md §3.6.
 */
const ModerationNotice = memo<ModerationNoticeProps>(({ moderation }) => {
  const { t } = useTranslation(['chat', 'common']);

  const model = moderation?.model ?? '';
  const provider = moderation?.provider ?? '';
  const modelCard = useAiInfraStore(aiModelSelectors.getModelCard(model, provider));

  if (moderation?.action !== 'downgrade') return null;

  const categoryLabel = getModerationCategoryLabel(t, moderation.category);
  const modelName = modelCard?.displayName || model;
  const override = moderation.message?.trim();

  // Admin copy (settings `downgradeMessage`) wins over the locale default when configured.
  const text = override
    ? applyModelPlaceholder(override, modelName)
    : t('moderation.downgraded', { model: modelName, ns: 'chat' });

  const notice = (
    <Flexbox horizontal align={'center'} className={styles.container} gap={6}>
      <Icon icon={ShieldCheck} size={14} />
      <span>{text}</span>
    </Flexbox>
  );

  if (!categoryLabel) return notice;

  return <Tooltip title={categoryLabel}>{notice}</Tooltip>;
});

ModerationNotice.displayName = 'ModerationNotice';

export default ModerationNotice;
