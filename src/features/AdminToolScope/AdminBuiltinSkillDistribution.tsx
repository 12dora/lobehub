'use client';

import { Text } from '@lobehub/ui';
import { Segmented, toast } from '@lobehub/ui/base-ui';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isAdminAiInfraErrorToasted } from '@/enterprise/client/services/adminAiInfraAdapter/errors';

import type { AdminSkillDistribution, AdminToolScope } from './index';

const ORDERED: AdminSkillDistribution[] = ['optional', 'default', 'mandatory'];

/**
 * Admin-only affordance under the builtin-skill header: sets the org-wide
 * distribution (optional / default / mandatory) for a builtin skill. Rendered
 * exclusively when the AdminToolScope is active.
 */
const AdminBuiltinSkillDistribution = memo<{
  identifier: string;
  scope: AdminToolScope;
}>(({ identifier, scope }) => {
  const { t } = useTranslation('admin');
  const [busy, setBusy] = useState(false);
  const value = scope.getBuiltinSkillDistribution(identifier);
  const canSet = scope.canSetBuiltinSkillDistribution(identifier);

  return (
    <div
      style={{
        alignItems: 'center',
        borderBlockEnd: '1px solid var(--ant-color-border-secondary)',
        display: 'flex',
        gap: 12,
        justifyContent: 'space-between',
        paddingBlock: 10,
        paddingInline: 24,
      }}
    >
      <Text type="secondary">{t('skillCatalog.detail.identity.distribution')}</Text>
      <Segmented<AdminSkillDistribution>
        disabled={busy || !canSet}
        size="small"
        value={value}
        options={ORDERED.map((d) => ({
          label: t(`skillCatalog.distribution.${d}` as never),
          value: d,
        }))}
        onChange={(next) => {
          if (next === value || !canSet) return;
          setBusy(true);
          void scope
            .setBuiltinSkillDistribution(identifier, next)
            .catch((err: unknown) => {
              // applyImmediate already toasts via withAdminAiInfraErrorToast — skip double toast.
              // Local denials / pre-read failures still need a control-boundary message.
              if (!isAdminAiInfraErrorToasted(err)) {
                toast.error(t('skillCatalog.toast.distributionFailed'));
              }
            })
            .finally(() => setBusy(false));
        }}
      />
    </div>
  );
});

AdminBuiltinSkillDistribution.displayName = 'AdminBuiltinSkillDistribution';

export default AdminBuiltinSkillDistribution;
