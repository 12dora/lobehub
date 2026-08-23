import { type MenuProps } from '@lobehub/ui';
import { ActionIcon, DropdownMenu } from '@lobehub/ui';
import { confirmModal, toast } from '@lobehub/ui/base-ui';
import { Trash2Icon } from 'lucide-react';
import { memo, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { usePermission } from '@/hooks/usePermission';
import { type TopicTimeRange } from '@/services/topic';
import { useChatStore } from '@/store/chat';

const RANGES: TopicTimeRange[] = ['24h', '7d', '30d', 'all'];

const DeleteRecents = memo(() => {
  const { t } = useTranslation('common');
  const removeTopicsByTimeRange = useChatStore((s) => s.removeTopicsByTimeRange);

  // Viewers may read recents but not delete them — keep the entries
  // visible-but-disabled per the disabled-not-hidden UX rule.
  const { allowed: canEdit } = usePermission('edit_own_content');

  const handleDelete = useCallback(
    (range: TopicTimeRange) => {
      confirmModal({
        cancelText: t('cancel'),
        content: t(`recentsDelete.confirm.desc.${range}`),
        okButtonProps: { danger: true },
        okText: t('delete'),
        onOk: async () => {
          try {
            const removed = await removeTopicsByTimeRange(range);
            toast.success(t('recentsDelete.success', { count: removed.length }));
          } catch {
            toast.error(t('recentsDelete.error'));
          }
        },
        title: t('recentsDelete.confirm.title'),
      });
    },
    [t, removeTopicsByTimeRange],
  );

  const items = useMemo(
    () =>
      RANGES.map((range) => ({
        danger: range === 'all',
        disabled: !canEdit,
        key: range,
        label: t(`recentsDelete.range.${range}`),
        onClick: () => handleDelete(range),
      })) as MenuProps['items'],
    [canEdit, t, handleDelete],
  );

  return (
    <DropdownMenu items={items} nativeButton={false}>
      <ActionIcon
        icon={Trash2Icon}
        size={'small'}
        style={{ flex: 'none' }}
        title={t('recentsDelete.trigger')}
      />
    </DropdownMenu>
  );
});

export default DeleteRecents;
