'use client';

import { Icon, Tag } from '@lobehub/ui';
import { AlertTriangle, CheckCircle2, CircleDashed, PauseCircle, XCircle } from 'lucide-react';
import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

type OperationalTone = 'default' | 'error' | 'info' | 'success' | 'warning';

const STATUS_TONE: Record<string, OperationalTone> = {
  cancelled: 'default',
  converged: 'success',
  dead: 'error',
  degraded: 'warning',
  disabled: 'default',
  diverged: 'error',
  failed: 'error',
  healthy: 'success',
  not_applicable: 'default',
  pending: 'info',
  reserved: 'info',
  running: 'info',
  succeeded: 'success',
  unavailable: 'error',
  unknown: 'default',
  unreported: 'warning',
};

const STATUS_ICON = {
  default: CircleDashed,
  error: XCircle,
  info: PauseCircle,
  success: CheckCircle2,
  warning: AlertTriangle,
} as const;

export interface OperationalStatusProps {
  status: string;
}

export const OperationalStatus = memo<OperationalStatusProps>(({ status }) => {
  const { t } = useTranslation('admin');
  const reduceMotion = useReducedMotion();
  const tone = STATUS_TONE[status] ?? 'default';
  const tag = (
    <Tag color={tone} icon={<Icon icon={STATUS_ICON[tone]} size={12} />} size="small">
      {t(`system.values.status.${status}` as never)}
    </Tag>
  );

  if (reduceMotion) return tag;

  return (
    <AnimatePresence initial={false} mode="wait">
      <m.span
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.98 }}
        initial={{ opacity: 0, scale: 0.98 }}
        key={status}
        style={{ display: 'inline-flex' }}
        transition={{ duration: 0.12 }}
      >
        {tag}
      </m.span>
    </AnimatePresence>
  );
});

OperationalStatus.displayName = 'AdminSystemOperationalStatus';
