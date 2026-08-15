'use client';

import { Tooltip } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';
import isEqual from 'fast-deep-equal';
import type { KeyboardEvent } from 'react';
import { memo, useCallback } from 'react';

import FileIcon from '@/components/FileIcon';
import { useChatStore } from '@/store/chat';
import { formatSize } from '@/utils/format';

import { dataSelectors, useConversationStore } from '../../../store';
import type { MarkdownElementProps } from '../type';
import { matchSandboxFile } from './parse';

interface SandboxFileLinkProperties {
  fileName?: string;
  filePath?: string;
  linkLabel?: string;
}

const styles = createStaticStyles(({ css, cssVar }) => ({
  icon: css`
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
  `,
  link: css`
    cursor: pointer;

    display: inline-flex;
    gap: 4px;
    align-items: center;

    margin-inline: -2px;
    padding-inline: 2px;
    border-radius: ${cssVar.borderRadiusSM};

    color: ${cssVar.colorLink};
    text-decoration: none;
    vertical-align: -0.16em;

    transition:
      color 0.2s ${cssVar.motionEaseOut},
      background 0.2s ${cssVar.motionEaseOut},
      box-shadow 0.2s ${cssVar.motionEaseOut};

    &:hover {
      color: ${cssVar.colorLinkHover};
      text-decoration: underline;
      text-underline-offset: 2px;

      background: ${cssVar.colorFillSecondary};
      box-shadow: inset 0 0 0 1px ${cssVar.colorPrimaryBorder};
    }

    &:active {
      color: ${cssVar.colorLinkActive};
      background: ${cssVar.colorFill};
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimaryBorder};
      outline-offset: 2px;
    }
  `,
}));

const Render = memo<MarkdownElementProps<SandboxFileLinkProperties>>(({ id, node }) => {
  const { fileName, filePath, linkLabel } = node?.properties || {};
  const label = linkLabel || fileName || filePath || '';

  // The generated file is attached to the very message this markdown belongs to,
  // so resolve the link against that message's own attachments.
  const fileList = useConversationStore(
    (s) => dataSelectors.getDbMessageById(id)(s)?.fileList,
    isEqual,
  );
  const openFilePreview = useChatStore((s) => s.openFilePreview);

  const file = matchSandboxFile(fileName, fileList);

  const handleOpen = useCallback(() => {
    if (!file) return;
    openFilePreview({ fileId: file.id });
  }, [file, openFilePreview]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLSpanElement>) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;

      event.preventDefault();
      handleOpen();
    },
    [handleOpen],
  );

  // The attachment never arrived (or the model invented the path): keep the
  // label readable as plain text instead of offering a link that goes nowhere.
  if (!file) return <span>{label}</span>;

  return (
    <Tooltip
      mouseEnterDelay={0.1}
      placement={'topLeft'}
      title={file.size ? `${file.name} · ${formatSize(file.size)}` : file.name}
    >
      <span
        className={styles.link}
        role={'button'}
        tabIndex={0}
        onClick={handleOpen}
        onKeyDown={handleKeyDown}
      >
        <span aria-hidden className={styles.icon}>
          <FileIcon fileName={file.name} fileType={file.fileType} size={16} variant={'raw'} />
        </span>
        <span>{label}</span>
      </span>
    </Tooltip>
  );
});

Render.displayName = 'SandboxFileLinkRender';

export default Render;
