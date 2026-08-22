import { Block, Flexbox, Tag, Text } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';
import { memo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import FileIcon from '@/components/FileIcon';
import { useChatStore } from '@/store/chat';
import { useFileStore } from '@/store/file';
import { type DocumentRenderStatus, readFileRenderMetadata } from '@/types/files/render';
import { type ChatFileItem } from '@/types/index';
import { formatSize } from '@/utils/format';

const styles = createStaticStyles(({ css }) => ({
  meta: css`
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  `,
}));

/** Only office documents and PDFs ever get page images, so only they can carry the badge. */
const RENDERABLE_EXTENSIONS = new Set([
  'doc',
  'docx',
  'odp',
  'ods',
  'odt',
  'pdf',
  'ppt',
  'pptx',
  'rtf',
  'xls',
  'xlsx',
]);

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
};

const isRenderableDocument = (name: string, fileType: string): boolean =>
  RENDERABLE_EXTENSIONS.has(extensionOf(name)) || RENDERABLE_EXTENSIONS.has(fileType.toLowerCase());

/** The four things a reader can be told; `partial` still means there are pages to look at. */
const BADGE = {
  failed: { key: 'render.failed', tone: 'error' },
  partial: { key: 'render.ready', tone: 'success' },
  pending: { key: 'render.pending', tone: 'info' },
  ready: { key: 'render.ready', tone: 'success' },
  skipped: { key: 'render.textOnly', tone: 'default' },
} as const satisfies Record<
  DocumentRenderStatus,
  { key: string; tone: 'default' | 'error' | 'info' | 'success' }
>;

const RENDER_POLL_MS = 5000;

/**
 * Page-render state for one attachment (design §6.4).
 *
 * Deliberately silent until the pipeline says something: a deployment without the `documentRender`
 * module writes no `metadata.render` at all, and a badge reading "unknown" on every attachment
 * would be noise rather than feedback. It polls only while a render is actually in flight, and
 * stops the moment the status turns terminal.
 */
const RenderStatusTag = memo<{ id: string }>(({ id }) => {
  const { t } = useTranslation('file');
  const useFetchKnowledgeItem = useFileStore((s) => s.useFetchKnowledgeItem);
  const { data, mutate } = useFetchKnowledgeItem(id);
  const status = readFileRenderMetadata(data?.metadata)?.status;
  const pending = status === 'pending';

  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void mutate(), RENDER_POLL_MS);
    return () => clearInterval(timer);
  }, [mutate, pending]);

  if (!status) return null;

  const badge = BADGE[status];
  return (
    <Tag color={badge.tone} size="small">
      {t(badge.key as never)}
    </Tag>
  );
});

RenderStatusTag.displayName = 'FileListViewerRenderStatusTag';

const FileItem = memo<ChatFileItem>(({ id, fileType, size, name }) => {
  const openFilePreview = useChatStore((s) => s.openFilePreview);

  return (
    <Block
      clickable
      horizontal
      align={'center'}
      gap={12}
      key={id}
      paddingBlock={8}
      paddingInline={'12px 16px'}
      variant={'outlined'}
      onClick={() => {
        openFilePreview({ fileId: id });
      }}
    >
      <FileIcon fileName={name} fileType={fileType} size={32} />
      <Flexbox style={{ overflow: 'hidden' }}>
        <Text ellipsis>{name}</Text>
        <div className={styles.meta}>
          <Text fontSize={12} type={'secondary'}>
            {formatSize(size)}
          </Text>
          {isRenderableDocument(name, fileType) ? <RenderStatusTag id={id} /> : null}
        </div>
      </Flexbox>
    </Block>
  );
});
export default FileItem;
