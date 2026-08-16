'use client';

import { Icon, Tag, Tooltip } from '@lobehub/ui';
import { AlertCircle, Ban, CheckCircle2, Clock3, FileText } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import {
  getIdentityProviderStatusPresentation,
  type IdentityProviderConfiguredRow,
  type IdentityProviderStatusPresentation,
} from './statusPresentation';

const ICONS = {
  alert: AlertCircle,
  ban: Ban,
  check: CheckCircle2,
  clock: Clock3,
  file: FileText,
} as const;

export interface IdentityProviderStatusBadgeProps {
  presentation?: IdentityProviderStatusPresentation;
  provider?: IdentityProviderConfiguredRow & { status?: string | null };
  status?: string | null;
}

const IdentityProviderStatusBadge = memo<IdentityProviderStatusBadgeProps>(
  ({ presentation, provider, status }) => {
    const { t } = useTranslation('admin');
    const resolved = presentation ?? getIdentityProviderStatusPresentation(provider ?? { status });
    const icon = ICONS[resolved.icon];
    const tag = (
      <Tag color={resolved.color} icon={<Icon icon={icon} size={12} />} size="small">
        {t(resolved.labelKey)}
      </Tag>
    );

    if (!resolved.descriptionKey) return tag;

    return <Tooltip title={t(resolved.descriptionKey)}>{tag}</Tooltip>;
  },
);

IdentityProviderStatusBadge.displayName = 'IdentityProviderStatusBadge';

export default IdentityProviderStatusBadge;
