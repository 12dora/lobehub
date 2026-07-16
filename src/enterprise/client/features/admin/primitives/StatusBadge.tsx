'use client';

import { Icon, Tag } from '@lobehub/ui';
import {
  AlertCircle,
  Archive,
  Ban,
  CheckCircle2,
  Clock3,
  FileText,
  HelpCircle,
} from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { type AdminResourceStatus, getAdminStatusPresentation } from './statusBadge.utils';

const ICONS = {
  alert: AlertCircle,
  archive: Archive,
  ban: Ban,
  check: CheckCircle2,
  clock: Clock3,
  file: FileText,
  help: HelpCircle,
} as const;

export interface StatusBadgeProps {
  status: AdminResourceStatus | string | null | undefined;
}

/**
 * Semantic status label + icon for admin resources (draft/published/…).
 * Uses design-token Tag colors — no hard-coded hex.
 */
const StatusBadge = memo<StatusBadgeProps>(({ status }) => {
  const { t } = useTranslation('admin');
  const presentation = getAdminStatusPresentation(status);
  const icon = ICONS[presentation.icon];

  return (
    <Tag color={presentation.color} icon={<Icon icon={icon} size={12} />} size="small">
      {t(presentation.labelKey)}
    </Tag>
  );
});

StatusBadge.displayName = 'AdminStatusBadge';

export default StatusBadge;
