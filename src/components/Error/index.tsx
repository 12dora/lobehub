'use client';

import {
  Accordion,
  AccordionItem,
  Block,
  Button,
  Flexbox,
  FluentEmoji,
  Highlighter,
} from '@lobehub/ui';
import type { Key } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { MAX_WIDTH } from '@/const/layoutTokens';
import { useWorkspaceAwareNavigate } from '@/features/Workspace/useWorkspaceAwareNavigate';

export type ErrorType = Error & { digest?: string };

interface ErrorCaptureProps {
  error: ErrorType;
  /** Where "back home" navigates; defaults to `/`. */
  resetPath?: string;
}

const ErrorCapture = ({ error, resetPath = '/' }: ErrorCaptureProps) => {
  const { t } = useTranslation('error');
  // Only rendered as a router `errorElement`, so react-router context exists.
  // Workspace-aware so an absolute `resetPath` keeps the active workspace;
  // relative ones (`..`, `../tasks`) are passed through untouched by
  // `buildWorkspaceAwarePath` and still resolve against the current route.
  const navigate = useWorkspaceAwareNavigate();
  const hasStack = !!error?.stack;
  const defaultExpandedKeys: Key[] = typeof __CI__ !== 'undefined' && __CI__ ? ['stack'] : [];
  const [expandedKeys, setExpandedKeys] = useState<Key[]>(defaultExpandedKeys);
  const isExpanded = expandedKeys.includes('stack');

  return (
    <Flexbox align={'center'} justify={'center'} style={{ minHeight: '100dvh', width: '100%' }}>
      <h1
        style={{
          filter: 'blur(8px)',
          fontSize: `min(${MAX_WIDTH / 6}px, 25vw)`,
          fontWeight: 900,
          margin: 0,
          opacity: 0.12,
          position: 'absolute',
          zIndex: 0,
        }}
      >
        ERROR
      </h1>
      <FluentEmoji emoji={'🤧'} size={64} />
      <h2 style={{ fontWeight: 'bold', marginTop: '1em', textAlign: 'center' }}>
        {t('error.title')}
      </h2>
      <p style={{ marginBottom: '2em' }}>{t('error.desc')}</p>
      <Flexbox horizontal gap={12} style={{ marginBottom: '2em' }}>
        {/* Retry stays a hard reload on purpose: the most common cause here is a
            chunk-load failure after a deploy (see `utils/chunkError`), which only
            a document load can recover from. "Back home" is an ordinary
            in-app hop, so it navigates client-side. */}
        <Button onClick={() => window.location.reload()}>{t('error.retry')}</Button>
        <Button type={'primary'} onClick={() => navigate(resetPath)}>
          {t('error.backHome')}
        </Button>
      </Flexbox>
      {hasStack && (
        <Block
          variant={isExpanded ? 'outlined' : 'filled'}
          style={{
            marginBottom: '1em',
            maxWidth: '90vw',
            overflow: 'hidden',
            transition: 'background 0.2s, border-color 0.2s',
            width: 560,
          }}
        >
          <Accordion
            expandedKeys={expandedKeys}
            variant={'borderless'}
            onExpandedChange={setExpandedKeys}
          >
            <AccordionItem indicatorPlacement={'start'} itemKey={'stack'} title={t('error.stack')}>
              <Highlighter language={'plaintext'} padding={12} variant={'borderless'}>
                {error.stack!}
              </Highlighter>
            </AccordionItem>
          </Accordion>
        </Block>
      )}
    </Flexbox>
  );
};

export default ErrorCapture;
