'use client';

import { Tag } from '@lobehub/ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

type TagColor = 'default' | 'success' | 'warning' | 'error' | 'info';

const RESULT_COLOR: Record<string, TagColor> = {
  denied: 'warning',
  failure: 'error',
  success: 'success',
};

const EXPORT_COLOR: Record<string, TagColor> = {
  cancelled: 'default',
  completed: 'success',
  expired: 'warning',
  failed: 'error',
  pending: 'info',
  running: 'info',
};

const HOLD_COLOR: Record<string, TagColor> = {
  active: 'success',
  released: 'default',
};

const RETENTION_COLOR: Record<string, TagColor> = {
  cancelled: 'default',
  completed: 'success',
  failed: 'error',
  pending: 'info',
  running: 'info',
};

export type AuditStatusKind = 'result' | 'export' | 'hold' | 'retention' | 'mode';

export interface AuditStatusTagProps {
  kind: AuditStatusKind;
  value: string | null | undefined;
}

const AuditStatusTag = memo<AuditStatusTagProps>(({ kind, value }) => {
  const { t } = useTranslation('admin');
  if (!value) return <Tag size="small">—</Tag>;

  let color: TagColor = 'default';
  let labelKey = `audit.status.${kind}.${value}`;

  if (kind === 'result') color = RESULT_COLOR[value] ?? 'default';
  else if (kind === 'export') color = EXPORT_COLOR[value] ?? 'default';
  else if (kind === 'hold') color = HOLD_COLOR[value] ?? 'default';
  else if (kind === 'retention') color = RETENTION_COLOR[value] ?? 'default';
  else if (kind === 'mode') {
    color = value === 'dry_run' ? 'info' : 'warning';
    labelKey = `audit.status.mode.${value}`;
  }

  return (
    <Tag color={color} size="small">
      {t(labelKey as never, { defaultValue: value })}
    </Tag>
  );
});

AuditStatusTag.displayName = 'AuditStatusTag';

export default AuditStatusTag;
