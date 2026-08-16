'use client';

import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import InfoTooltip from '@/components/InfoTooltip';

export const fieldStyles = createStaticStyles(({ css }) => ({
  error: css`
    font-size: 12px;
    color: ${cssVar.colorError};
  `,
  field: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  `,
  label: css`
    font-weight: 600;
  `,
  /**
   * Label and its help icon share one line so a hint never pushes the input down —
   * neighbouring grid columns keep their inputs on the same baseline.
   */
  labelRow: css`
    display: flex;
    gap: 4px;
    align-items: center;
    min-height: 22px;
  `,
  meta: css`
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
}));

interface FieldHintProps {
  /** Names the field this help belongs to, so the icon has an accessible name of its own. */
  field: string;
  title: string;
}

/**
 * Static guidance for a field or section: a hover/focus target beside the label instead of a
 * paragraph between the label and the control it explains. `tabIndex` keeps it keyboard
 * reachable — Base UI opens the tooltip on focus.
 */
export const FieldHint = memo<FieldHintProps>(({ field, title }) => {
  const { t } = useTranslation('admin');
  return (
    <InfoTooltip
      size={14}
      title={title}
      triggerProps={{ 'aria-label': t('branding.fields.helpFor', { field }), 'tabIndex': 0 }}
    />
  );
});

FieldHint.displayName = 'BrandingFieldHint';
