import { Avatar, Block, Flexbox, Text } from '@lobehub/ui';
import { cssVar } from 'antd-style';
import { memo } from 'react';

export interface ExampleItemProps {
  avatar?: string | null;
  backgroundColor?: string | null;
  description: string;
  onClick: (prompt: string) => void;
  prompt: string;
  title: string;
}

/** One example card. Clicking it prefills the modal's chat input with `prompt`. */
const ExampleItem = memo<ExampleItemProps>(
  ({ avatar, backgroundColor, title, description, onClick, prompt }) => {
    return (
      <Block
        clickable
        variant={'outlined'}
        style={{
          borderRadius: cssVar.borderRadiusLG,
          cursor: 'pointer',
        }}
        onClick={() => onClick(prompt)}
      >
        <Flexbox horizontal align={'flex-start'} gap={10} paddingBlock={12} paddingInline={14}>
          {avatar ? (
            <Avatar
              alt={title}
              avatar={avatar}
              background={backgroundColor ?? undefined}
              size={28}
            />
          ) : null}
          <Flexbox flex={1} gap={4} style={{ minWidth: 0 }}>
            <Text ellipsis fontSize={14} style={{ fontWeight: 500 }}>
              {title}
            </Text>
            <Text color={cssVar.colorTextTertiary} ellipsis={{ rows: 2 }} fontSize={12}>
              {description}
            </Text>
          </Flexbox>
        </Flexbox>
      </Block>
    );
  },
);

ExampleItem.displayName = 'CreateAgentExampleItem';

export default ExampleItem;
