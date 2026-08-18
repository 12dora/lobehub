import { ProviderIcon } from '@lobehub/icons';
import { Avatar, Flexbox, SortableList } from '@lobehub/ui';
import { memo } from 'react';

import { useProviderName } from '@/hooks/useProviderName';
import { type AiProviderListItem } from '@/types/aiProvider';

import { isBuiltinProviderRow } from '../builtinProvider';

interface GroupItemProps extends AiProviderListItem {
  disabled?: boolean;
}

const GroupItem = memo<GroupItemProps>(({ id, name, source, logo, disabled }) => {
  // Same rule as the sidebar row this dialog reorders: a builtin is named by its card, so a
  // stale stored name cannot make the two lists disagree about what a provider is called —
  // and anything else keeps the name its operator gave it, empty `source` column included.
  const isCustom = !isBuiltinProviderRow(id, source);
  const displayName = useProviderName(id, isCustom ? name || id : undefined);

  return (
    <>
      <Flexbox horizontal gap={8}>
        {isCustom && logo ? (
          <Avatar
            alt={displayName}
            avatar={logo}
            shape={'square'}
            size={24}
            style={{ borderRadius: 6 }}
          />
        ) : (
          <ProviderIcon provider={id} size={24} style={{ borderRadius: 6 }} type={'avatar'} />
        )}
        {displayName}
      </Flexbox>
      {!disabled && <SortableList.DragHandle />}
    </>
  );
});

export default GroupItem;
