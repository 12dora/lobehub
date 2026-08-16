'use client';

import { Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { auditActionLabel } from '../shared/format';

export const VISIBLE_ACTION_FACET_COUNT = 8;

export interface ActionFacetItem {
  count: number;
  value: string;
}

export interface ActionFacetChipsProps {
  actions: ActionFacetItem[];
  onToggle: (action: string) => void;
  selected: readonly string[];
}

const styles = createStaticStyles(({ css }) => ({
  chip: css`
    cursor: pointer;

    display: inline-flex;
    align-items: center;

    padding-block: 2px;
    padding-inline: 8px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusXS};

    font-size: 12px;
    line-height: 1.5;
    color: ${cssVar.colorText};

    background: ${cssVar.colorFillTertiary};

    transition:
      background 0.15s ease,
      border-color 0.15s ease,
      color 0.15s ease;

    &:hover {
      background: ${cssVar.colorFillSecondary};
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimaryBorder};
      outline-offset: 2px;
    }

    /* Soft filled selected state — hue-independent, no outline ring. */
    &[data-selected='true'] {
      border-color: transparent;
      font-weight: 600;
      color: ${cssVar.colorText};
      background: ${cssVar.colorFillSecondary};
    }
  `,
  overflow: css`
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;

    margin-block-start: 6px;
  `,
  root: css`
    min-width: 0;
  `,
  row: css`
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  `,
}));

const ActionFacetChips = memo<ActionFacetChipsProps>(({ actions, selected, onToggle }) => {
  const { t } = useTranslation('admin');
  const reduceMotion = useReducedMotion();
  const [expanded, setExpanded] = useState(false);

  if (!actions.length) return null;

  const visible = actions.slice(0, VISIBLE_ACTION_FACET_COUNT);
  const overflow = actions.slice(VISIBLE_ACTION_FACET_COUNT);
  const selectedSet = new Set(selected);

  const renderChip = (item: ActionFacetItem) => {
    const isSelected = selectedSet.has(item.value);
    return (
      <button
        aria-pressed={isSelected}
        className={styles.chip}
        data-selected={isSelected}
        data-testid={`facet-${item.value}`}
        key={item.value}
        type="button"
        onClick={() => onToggle(item.value)}
      >
        {auditActionLabel(t, item.value)} ({item.count})
      </button>
    );
  };

  const overflowBody = <div className={styles.overflow}>{overflow.map(renderChip)}</div>;

  return (
    <div className={styles.root}>
      <div className={styles.row}>
        <Text type="secondary">{t('audit.logs.facets.actions')}</Text>
        {visible.map(renderChip)}
        {overflow.length > 0 ? (
          <Button size="small" type="text" onClick={() => setExpanded((prev) => !prev)}>
            {expanded
              ? t('audit.logs.facets.collapse')
              : t('audit.logs.facets.expand', { count: overflow.length })}
          </Button>
        ) : null}
      </div>
      {overflow.length > 0 ? (
        reduceMotion ? (
          expanded ? (
            overflowBody
          ) : null
        ) : (
          <AnimatePresence initial={false}>
            {expanded ? (
              <m.div
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                initial={{ height: 0, opacity: 0 }}
                key="overflow"
                style={{ overflow: 'hidden' }}
                transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              >
                {overflowBody}
              </m.div>
            ) : null}
          </AnimatePresence>
        )
      ) : null}
    </div>
  );
});

ActionFacetChips.displayName = 'AuditActionFacetChips';

export default ActionFacetChips;
