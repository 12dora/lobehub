'use client';

import { Alert, Empty } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import SkeletonList from '@/features/NavPanel/components/SkeletonList';

export interface CursorPage<TItem> {
  items: TItem[];
  nextCursor?: string | null;
}

export interface CursorPagedListLabels {
  empty: string;
  error: string;
  loading: string;
  pageError: string;
}

export interface UseCursorStackResult {
  cursor: string | undefined;
  goNext: (nextCursor: string) => void;
  goPrevious: () => void;
  hasPrevious: boolean;
}

/**
 * Cursor stack for SWR list hooks that page via opaque nextCursor tokens.
 * Stack holds visited cursors; the top is the active page cursor (undefined = first page).
 *
 * Pass `resetKey` (e.g. `${skillId}:${versionId}`) so scope changes return to page 1 —
 * otherwise a mid-list cursor can stick across version switches and look empty/wrong.
 */
export const useCursorStack = (resetKey?: string | number | null): UseCursorStackResult => {
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([]);
  const cursor = cursorStack.at(-1) ?? null;

  useEffect(() => {
    setCursorStack([]);
  }, [resetKey]);

  return {
    cursor: cursor ?? undefined,
    goNext: (nextCursor) => {
      setCursorStack((current) => {
        // Idempotent: ignore duplicate Next while the same cursor is already active/pending.
        if (current.at(-1) === nextCursor) return current;
        return [...current, nextCursor];
      });
    },
    goPrevious: () => {
      setCursorStack((current) => current.slice(0, -1));
    },
    hasPrevious: cursorStack.length > 0,
  };
};

const styles = createStaticStyles(({ css }) => ({
  pager: css`
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    padding-block-start: 12px;
  `,
}));

export interface CursorPagedListSurfaceProps<TItem> {
  data?: CursorPage<TItem>;
  error?: unknown;
  isLoading: boolean;
  labels: CursorPagedListLabels;
  onNext: (nextCursor: string) => void;
  onPrevious: () => void;
  onRetry: () => void;
  pagination: {
    hasPrevious: boolean;
  };
  renderItems: (items: TItem[]) => ReactNode;
  skeletonRows?: number;
}

/**
 * Shared loading / error / empty / pager surface for skill detail sub-lists.
 *
 * Error priority (must stay stable for existing tests + UX):
 * 1. first-load error (`error && !data`) → full-surface error + retry
 * 2. first-load loading (`isLoading && !data`) → skeleton
 * 3. non-empty page → items + pager
 * 4. empty → Empty
 * 5. background/page error while data is retained (`error && data`) → inline pageError + retry
 *    (keeps prior rows; Next is disabled while error is present)
 */
export function CursorPagedListSurface<TItem>({
  data,
  error,
  isLoading,
  labels,
  onNext,
  onPrevious,
  onRetry,
  pagination,
  renderItems,
  skeletonRows = 3,
}: CursorPagedListSurfaceProps<TItem>) {
  const { t } = useTranslation('admin');

  return (
    <>
      {error && !data ? (
        <Alert
          showIcon
          extra={<Button onClick={onRetry}>{t('skillCatalog.actions.retry')}</Button>}
          message={labels.error}
          type="error"
        />
      ) : isLoading && !data ? (
        <div aria-label={labels.loading} role="status">
          <SkeletonList rows={skeletonRows} />
        </div>
      ) : data?.items.length ? (
        <>
          {renderItems(data.items)}
          <div aria-label={t('skillCatalog.pagination.label')} className={styles.pager}>
            <Button disabled={!pagination.hasPrevious || isLoading} onClick={onPrevious}>
              {t('skillCatalog.pagination.previous')}
            </Button>
            <Button
              disabled={!data.nextCursor || Boolean(error) || isLoading}
              onClick={() => {
                const next = data.nextCursor;
                if (next && !isLoading) onNext(next);
              }}
            >
              {t('skillCatalog.pagination.next')}
            </Button>
          </div>
        </>
      ) : (
        <Empty description={labels.empty} />
      )}
      {error && data ? (
        <Alert
          showIcon
          extra={<Button onClick={onRetry}>{t('skillCatalog.actions.retry')}</Button>}
          message={labels.pageError}
          type="error"
        />
      ) : null}
    </>
  );
}

// Keep section chrome styles co-located so Versions/Dependents can share a single
// border/padding contract without re-declaring createStaticStyles.
export const skillDetailSectionStyles = createStaticStyles(({ css }) => ({
  identityGrid: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 16px;
  `,
  section: css`
    display: flex;
    flex-direction: column;
    gap: 12px;

    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};
  `,
}));
