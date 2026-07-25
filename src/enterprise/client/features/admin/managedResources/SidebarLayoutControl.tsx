'use client';

import { Flexbox, Icon, Text } from '@lobehub/ui';
import { Button, Select, toast } from '@lobehub/ui/base-ui';
import debug from 'debug';
import { MonitorCog } from 'lucide-react';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import { adminSidebarLayoutService } from '@/enterprise/client/services/adminSidebarLayout';
import { openCustomizeSidebarModal } from '@/routes/(main)/home/_layout/Body/CustomizeSidebarModal';
import {
  DEFAULT_SIDEBAR_ITEMS,
  getDefaultHiddenSections,
} from '@/store/global/selectors/systemStatus';
import type { PlatformSidebarLayout, SidebarLayoutMode } from '@/types/platform/sidebarLayout';

import { useFetchAdminSidebarLayout } from './hooks/useAdminSidebarLayout';
import { managedResourcePolicyCardStyles, POLICY_MODE_SELECT_WIDTH } from './policyCardStyles';

const log = debug('lobe-client:admin:sidebar-layout');

const MODE_VALUES = ['user', 'platform'] as const satisfies readonly SidebarLayoutMode[];

interface SidebarLayoutControlProps {
  /** POLICY_UPDATE — gates mode changes and configure. */
  canUpdate?: boolean;
  /** Parent busy (e.g. policy save in flight). */
  disabled?: boolean;
}

/**
 * Reload the authoritative sidebar layout after a CAS conflict.
 * Exported for unit tests — production path must not swallow a failed revalidation.
 */
export const reloadSidebarLayoutAfterConflict = async (params: {
  mutate: () => Promise<unknown>;
}): Promise<{ refreshFailed: boolean }> => {
  try {
    await params.mutate();
    return { refreshFailed: false };
  } catch (refreshError) {
    log('post-conflict refresh failed: %O', refreshError);
    return { refreshFailed: true };
  }
};

/**
 * "侧边栏排序" — a platform-vs-user policy for the home sidebar layout, direct-save.
 * When set to "平台托管", the Configure button opens the same "自定义侧边栏" dialog the
 * user sees, but writes the chosen layout to the platform policy; user clients then hide
 * their own sidebar-customization controls and apply this layout.
 *
 * CAS: last-loaded `revision` is sent as `expectedRevision`; conflict reloads and warns
 * (same pattern as general auth-settings). A failed post-conflict revalidation is a
 * benign refresh-error / reload-needed state — never a silent stale view.
 */
const SidebarLayoutControl = memo<SidebarLayoutControlProps>(({ canUpdate = false, disabled }) => {
  const { t } = useTranslation('admin');
  const { data, error, isLoading, mutate } = useFetchAdminSidebarLayout();
  const [saving, setSaving] = useState(false);
  /**
   * True when a CAS conflict was detected but the follow-up revalidation failed.
   * Mirrors auth-settings: block writes until the admin reloads the latest revision.
   */
  const [reloadNeeded, setReloadNeeded] = useState(false);

  const busy = disabled || saving || isLoading || !data;
  const controlsDisabled = busy || !canUpdate || reloadNeeded;

  const persist = async (next: Pick<PlatformSidebarLayout, 'layout' | 'mode'>) => {
    if (!canUpdate || !data || reloadNeeded) return;
    setSaving(true);
    try {
      const saved = await adminSidebarLayoutService.update({
        expectedRevision: data.revision,
        layout: next.layout,
        mode: next.mode,
      });
      try {
        await mutate(saved, { revalidate: false });
      } catch (refreshError) {
        log('post-update refresh failed: %O', refreshError);
        toast.success(
          t('sidebarLayout.savedRefreshFailed', {
            defaultValue: 'Sidebar layout saved, but the view could not refresh.',
          }),
        );
        return;
      }
      toast.success(t('sidebarLayout.saved'));
    } catch (cause) {
      if (mapEnterpriseError(cause)?.code === 'PLATFORM_REVISION_CONFLICT') {
        toast.error(
          t('sidebarLayout.conflict', {
            defaultValue:
              'Sidebar layout was changed elsewhere. Reloading the latest version before you can save again.',
          }),
        );
        // Pull latest so the next save uses the current revision — no silent overwrite.
        // Do NOT swallow a failed revalidation: surface reload-needed like auth-settings.
        const { refreshFailed } = await reloadSidebarLayoutAfterConflict({
          mutate: () => mutate(),
        });
        if (refreshFailed) {
          setReloadNeeded(true);
          toast.error(
            t('sidebarLayout.reloadNeeded', {
              defaultValue: 'Could not load the latest sidebar layout. Reload to continue editing.',
            }),
          );
        } else {
          setReloadNeeded(false);
        }
      } else {
        toast.error(t('sidebarLayout.saveError'));
      }
    } finally {
      setSaving(false);
    }
  };

  const handleReload = () => {
    void (async () => {
      const { refreshFailed } = await reloadSidebarLayoutAfterConflict({
        mutate: () => mutate(),
      });
      if (refreshFailed) {
        setReloadNeeded(true);
        toast.error(
          t('sidebarLayout.reloadNeeded', {
            defaultValue: 'Could not load the latest sidebar layout. Reload to continue editing.',
          }),
        );
        return;
      }
      setReloadNeeded(false);
    })();
  };

  const handleModeChange = (nextMode: SidebarLayoutMode) => {
    if (!data || nextMode === data.mode || !canUpdate || reloadNeeded) return;
    void persist({ layout: data.layout, mode: nextMode });
  };

  const handleConfigure = () => {
    if (!data || !canUpdate || reloadNeeded) return;
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
    <section className={managedResourcePolicyCardStyles.card}>
      <div className={managedResourcePolicyCardStyles.row}>
        <Text
          strong
          ellipsis={{ tooltip: true, tooltipWhenOverflow: true }}
          style={{ flex: 1, minWidth: 0 }}
        >
          {t('sidebarLayout.title')}
        </Text>
        {error && !data ? (
          <Flexbox horizontal align="center" gap={8} role="alert" style={{ flexShrink: 0 }}>
            <Text style={{ fontSize: 12 }} type="danger">
              {t('sidebarLayout.loadError', {
                defaultValue: 'Could not load sidebar layout.',
              })}
            </Text>
            <Button size="small" type="default" onClick={() => void mutate()}>
              {t('primitives.dataTable.retry')}
            </Button>
          </Flexbox>
        ) : reloadNeeded ? (
          <Flexbox horizontal align="center" gap={8} role="alert" style={{ flexShrink: 0 }}>
            <Text style={{ fontSize: 12 }} type="danger">
              {t('sidebarLayout.reloadNeeded', {
                defaultValue:
                  'Could not load the latest sidebar layout. Reload to continue editing.',
              })}
            </Text>
            <Button size="small" type="default" onClick={handleReload}>
              {t('sidebarLayout.reload', { defaultValue: 'Reload' })}
            </Button>
          </Flexbox>
        ) : (
          <Flexbox horizontal align="center" gap={8} style={{ flexShrink: 0 }}>
            {data?.mode === 'platform' ? (
              <Button
                disabled={controlsDisabled}
                icon={<Icon icon={MonitorCog} />}
                onClick={handleConfigure}
              >
                {t('sidebarLayout.configure')}
              </Button>
            ) : null}
            <Select
              disabled={controlsDisabled || !data}
              style={{ flexShrink: 0, width: POLICY_MODE_SELECT_WIDTH }}
              // Never invent a mode from missing data — leave empty until load succeeds.
              value={data?.mode}
              options={MODE_VALUES.map((m) => ({
                label: t(`sidebarLayout.mode.${m}` as const),
                value: m,
              }))}
              placeholder={
                isLoading ? t('primitives.dataTable.loading') : t('sidebarLayout.mode.user')
              }
              onChange={(value) => handleModeChange(value as SidebarLayoutMode)}
            />
          </Flexbox>
        )}
      </div>
    </section>
  );
});

SidebarLayoutControl.displayName = 'SidebarLayoutControl';

export default SidebarLayoutControl;
