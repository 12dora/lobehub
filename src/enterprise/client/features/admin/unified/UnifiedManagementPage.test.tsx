import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlatformModuleId } from '@/const/platform/modules';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import UnifiedManagementPage from './UnifiedManagementPage';

const access = { permissions: Object.values(PLATFORM_PERMISSIONS) as string[] };
let disabledModules = new Set<PlatformModuleId>();
let searchParams = new URLSearchParams();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('react-router', () => ({
  useSearchParams: () => [searchParams, (next: URLSearchParams) => (searchParams = next)],
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Tabs: ({ activeKey, items }: { activeKey: string; items: { key: string; label: string }[] }) => (
    <div data-active={activeKey} role="tablist">
      {items.map((item) => (
        <span key={item.key} role="tab">
          {item.label}
        </span>
      ))}
    </div>
  ),
}));

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => access,
}));

vi.mock('@/enterprise/client/hooks/useModuleEnabled', () => ({
  useModuleEnabled: (id: PlatformModuleId) => !disabledModules.has(id),
}));

vi.mock('../settings/SettingsPolicyPage', () => ({
  default: () => <div>settings-policy-body</div>,
}));

vi.mock('../managedResources/ManagedResourcesPolicyPage', () => ({
  default: () => <div>managed-resources-body</div>,
}));

const activeTab = () => screen.getByRole('tablist').dataset.active;
const tabLabels = () => screen.queryAllByRole('tab').map((node) => node.textContent);

beforeEach(() => {
  access.permissions = Object.values(PLATFORM_PERMISSIONS);
  disabledModules = new Set();
  searchParams = new URLSearchParams();
});

describe('UnifiedManagementPage module gating', () => {
  it('offers both tabs when both modules are on', () => {
    render(<UnifiedManagementPage />);
    expect(tabLabels()).toEqual(['settingsPolicy.title', 'managedResources.title']);
  });

  it('drops the 设置策略 tab and lands on 受管资源 when settingsPolicy is off', () => {
    // Gating only the hidden /admin/settings deep link would leave the identical surface
    // reachable here, where every request degrades to PLATFORM_MODULE_DISABLED.
    disabledModules = new Set<PlatformModuleId>(['settingsPolicy']);
    render(<UnifiedManagementPage />);

    expect(tabLabels()).toEqual(['managedResources.title']);
    expect(activeTab()).toBe('managed');
    expect(screen.getByText('managed-resources-body')).toBeTruthy();
  });

  it('drops the 受管资源 tab when managedAi is off', () => {
    disabledModules = new Set<PlatformModuleId>(['managedAi']);
    searchParams = new URLSearchParams('tab=managed');
    render(<UnifiedManagementPage />);

    expect(tabLabels()).toEqual(['settingsPolicy.title']);
    // Never leave the admin on a tab that is no longer offered, even via a deep link.
    expect(activeTab()).toBe('settings');
    expect(screen.getByText('settings-policy-body')).toBeTruthy();
  });

  it('shows the forbidden copy rather than an empty shell when both modules are off', () => {
    disabledModules = new Set<PlatformModuleId>(['settingsPolicy', 'managedAi']);
    render(<UnifiedManagementPage />);

    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByText('page.forbidden.desc')).toBeTruthy();
  });

  it('still gates on permissions independently of the modules', () => {
    access.permissions = [PLATFORM_PERMISSIONS.SETTINGS_READ];
    render(<UnifiedManagementPage />);
    expect(tabLabels()).toEqual(['settingsPolicy.title']);
  });
});
