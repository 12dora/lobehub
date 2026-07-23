'use client';

import { Empty, Flexbox, Text } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { computeJsonDiff, formatJsonValue, type JsonDiffKind } from './jsonDiff';

const styles = createStaticStyles(({ css }) => ({
  code: css`
    overflow: auto;

    max-height: 320px;
    margin: 0;
    padding: 12px;
    border-radius: ${cssVar.borderRadius};

    font-family: ${cssVar.fontFamilyCode};
    font-size: 12px;
    line-height: 1.5;
    word-break: break-word;
    white-space: pre-wrap;

    background: ${cssVar.colorFillQuaternary};
  `,
  col: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 8px;

    min-width: 0;
  `,
  line: css`
    padding-block: 6px;
    padding-inline: 10px;
    border-inline-start: 3px solid transparent;
    border-radius: ${cssVar.borderRadiusSM};

    font-family: ${cssVar.fontFamilyCode};
    font-size: 12px;
  `,
  lineAdded: css`
    border-inline-start-color: ${cssVar.colorSuccess};
    background: ${cssVar.colorSuccessBg};
  `,
  lineChanged: css`
    border-inline-start-color: ${cssVar.colorWarning};
    background: ${cssVar.colorWarningBg};
  `,
  lineRemoved: css`
    border-inline-start-color: ${cssVar.colorError};
    background: ${cssVar.colorErrorBg};
  `,
  lineSame: css`
    border-inline-start-color: ${cssVar.colorBorderSecondary};
    background: ${cssVar.colorFillQuaternary};
  `,
  panels: css`
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;

    @media (width <= 900px) {
      grid-template-columns: 1fr;
    }
  `,
  path: css`
    font-weight: 600;
    color: ${cssVar.colorTextSecondary};
  `,
  root: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
  `,
}));

const kindClass = (kind: JsonDiffKind): string => {
  switch (kind) {
    case 'added': {
      return styles.lineAdded;
    }
    case 'removed': {
      return styles.lineRemoved;
    }
    case 'changed': {
      return styles.lineChanged;
    }
    default: {
      return styles.lineSame;
    }
  }
};

export interface JsonDiffViewProps {
  after: Record<string, unknown> | null | undefined;
  before: Record<string, unknown> | null | undefined;
}

const JsonDiffView = memo<JsonDiffViewProps>(({ before, after }) => {
  const { t } = useTranslation('admin');
  const empty = before == null && after == null;

  const lines = useMemo(() => {
    if (empty) return [];
    return computeJsonDiff(before ?? null, after ?? null).filter((l) => l.kind !== 'same');
  }, [after, before, empty]);

  if (empty) {
    return <Empty description={t('audit.logs.diff.empty')} style={{ paddingBlock: 24 }} />;
  }

  return (
    <div className={styles.root}>
      <div className={styles.panels}>
        <div className={styles.col}>
          <Text type="secondary">{t('audit.logs.diff.before')}</Text>
          <pre className={styles.code}>{formatJsonValue(before ?? null)}</pre>
        </div>
        <div className={styles.col}>
          <Text type="secondary">{t('audit.logs.diff.after')}</Text>
          <pre className={styles.code}>{formatJsonValue(after ?? null)}</pre>
        </div>
      </div>
      {lines.length > 0 ? (
        <Flexbox gap={6}>
          <Text type="secondary">{t('audit.logs.diff.changes')}</Text>
          {lines.map((line) => (
            <div
              className={`${styles.line} ${kindClass(line.kind)}`}
              key={`${line.path}-${line.kind}`}
            >
              <div className={styles.path}>
                {line.path} · {t(`audit.logs.diff.kind.${line.kind}` as never)}
              </div>
              {line.kind === 'changed' ? (
                <div>
                  − {formatJsonValue(line.before)}
                  <br />+ {formatJsonValue(line.after)}
                </div>
              ) : null}
              {line.kind === 'added' ? <div>+ {formatJsonValue(line.after)}</div> : null}
              {line.kind === 'removed' ? <div>− {formatJsonValue(line.before)}</div> : null}
            </div>
          ))}
        </Flexbox>
      ) : null}
    </div>
  );
});

JsonDiffView.displayName = 'AuditJsonDiffView';

export default JsonDiffView;
