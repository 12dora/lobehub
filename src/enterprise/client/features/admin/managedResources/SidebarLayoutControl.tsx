'use client';

import { Flexbox, Icon, Text } from '@lobehub/ui';
import { Button, Select, toast } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { MonitorCog } from 'lucide-react';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { adminSidebarLayoutService } from '@/enterprise/client/services/adminSidebarLayout';
import { openCustomizeSidebarModal } from '@/routes/(main)/home/_layout/Body/CustomizeSidebarModal';
import {
  DEFAULT_SIDEBAR_ITEMS,
  getDefaultHiddenSections,
} from '@/store/global/selectors/systemStatus';
import type { PlatformSidebarLayout, SidebarLayoutMode } from '@/types/platform/sidebarLayout';

import { useFetchAdminSidebarLayout } from './hooks/useAdminSidebarLayout';

const MODE_VALUES = ['user', 'platform'] as const satisfies readonly SidebarLayoutMode[];

// Card/row styles mirror the sibling resource boxes on ManagedResourcesPolicyPage
// so the "侧边栏排序" box renders as a compact grid card, not a full-width strip.
const styles = createStaticStyles(({ css }) => ({
  card: css`
    display: flex;
    flex-direction: column;
    gap: 12px;

    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};
  `,
  row: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px 20px;
    align-items: center;
    justify-content: space-between;

    min-width: 0;
  `,
}));

/**
 * "侧边栏排序" — a platform-vs-user policy for the home sidebar layout, direct-save.
 * When set to "平台托管", the Configure button opens the same "自定义侧边栏" dialog the
 * user sees, but writes the chosen layout to the platform policy; user clients then hide
 * their own sidebar-customization controls and apply this layout.
 */
const SidebarLayoutControl = memo<{ disabled?: boolean }>(({ disabled }) => {
  const { t } = useTranslation('admin');
  const { data, isLoading, mutate } = useFetchAdminSidebarLayout();
  const [saving, setSaving] = useState(false);

  const mode: SidebarLayoutMode = data?.mode ?? 'user';
  const busy = disabled || saving || isLoading;

  const persist = async (next: PlatformSidebarLayout) => {
    setSaving(true);
    try {
      const saved = await adminSidebarLayoutService.update(next);
      await mutate(saved, { revalidate: false });
      toast.success(t('sidebarLayout.saved'));
    } catch {
      toast.error(t('sidebarLayout.saveError'));
    } finally {
      setSaving(false);
    }
  };

  const handleModeChange = (nextMode: SidebarLayoutMode) => {
    if (!data || nextMode === mode) return;
    void persist({ layout: data.layout, mode: nextMode });
  };

  const handleConfigure = () => {
    if (!data) return;
    const layout = data.layout ?? {
      hiddenSidebarSections: getDefaultHiddenSections(false),
      sidebarItems: DEFAULT_SIDEBAR_ITEMS,
    };
    openCustomizeSidebarModal({
      initialHiddenSections: layout.hiddenSidebarSections,
      initialItems: layout.sidebarItems,
      isWorkspaceMode: false,
      onConfirm: (next) => {
        void persist({
          layout: {
            hiddenSidebarSections: next.hiddenSidebarSections,
            sidebarExpandedKeys: next.sidebarExpandedKeys,
            sidebarItems: next.sidebarItems,
          },
          mode: 'platform',
        });
      },
    });
  };

  return (
    <section className={styles.card}>
      <div className={styles.row}>
        <Text strong>{t('sidebarLayout.title')}</Text>
        <Flexbox horizontal align="center" gap={8}>
          {mode === 'platform' ? (
            <Button disabled={busy} icon={<Icon icon={MonitorCog} />} onClick={handleConfigure}>
              {t('sidebarLayout.configure')}
            </Button>
          ) : null}
          <Select
            disabled={busy}
            style={{ minWidth: 140 }}
            value={mode}
            options={MODE_VALUES.map((m) => ({
              label: t(`sidebarLayout.mode.${m}` as const),
              value: m,
            }))}
            onChange={(value) => handleModeChange(value as SidebarLayoutMode)}
          />
        </Flexbox>
      </div>
      <Text type="secondary">{t('sidebarLayout.desc')}</Text>
    </section>
  );
});

SidebarLayoutControl.displayName = 'SidebarLayoutControl';

export default SidebarLayoutControl;
