// @vitest-environment happy-dom
import { MotionProvider } from '@lobehub/ui';
import { render, screen } from '@testing-library/react';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import AdminAccessProvider from '@/enterprise/client/providers/AdminAccessProvider';
import type { AdminAccessSnapshot } from '@/enterprise/client/services/adminAuth';
import { ServerConfigStoreProvider } from '@/store/serverConfig/Provider';

import ConnectorSettingsPage from './ConnectorSettingsPage';

const mocks = vi.hoisted(() => ({
  connectors: {
    applyImmediate: vi.fn(),
    archiveImmediate: vi.fn(),
    deleteDraft: vi.fn(),
    discover: vi.fn(),
    get: vi.fn(),
    getGovernance: vi.fn(async () => ({
      doc: { builtinToolPolicies: {}, sharedAuthorization: { ownerUserId: null } },
      managedActive: false,
      revision: 0,
    })),
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
  },
  skills: {
    applyImmediate: vi.fn(),
    archiveImmediate: vi.fn(),
    get: vi.fn(),
    getVersion: vi.fn(),
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
    parseImportSource: vi.fn(),
  },
}));

vi.mock('@/enterprise/client/services/adminSkills', () => ({
  adminSkillsService: mocks.skills,
}));

vi.mock('@/enterprise/client/services/adminConnectors', () => ({
  adminConnectorsService: mocks.connectors,
}));

/** Explicit admin-access fixture — page tree uses useAdminAccess via useAdminGlobalToolScope. */
const fetchAdminAccessFixture = async (): Promise<AdminAccessSnapshot> => ({
  authMethod: 'better-auth',
  hasAdminAccess: true,
  permissions: [
    PLATFORM_PERMISSIONS.ADMIN_ACCESS,
    PLATFORM_PERMISSIONS.CONNECTOR_READ,
    PLATFORM_PERMISSIONS.CONNECTOR_CREATE,
    PLATFORM_PERMISSIONS.CONNECTOR_UPDATE,
    PLATFORM_PERMISSIONS.CONNECTOR_DELETE,
    PLATFORM_PERMISSIONS.CONNECTOR_PUBLISH,
    PLATFORM_PERMISSIONS.SKILL_READ,
    PLATFORM_PERMISSIONS.SKILL_CREATE,
    PLATFORM_PERMISSIONS.SKILL_UPDATE,
    PLATFORM_PERMISSIONS.SKILL_DELETE,
    PLATFORM_PERMISSIONS.SKILL_PUBLISH,
  ],
  roles: [{ displayName: 'ai_admin', name: 'ai_admin' }],
});

const AppProviders = ({ children }: { children: ReactNode }) => (
  <MotionProvider motion={motion}>
    <MemoryRouter initialEntries={['/admin/ai/connectors']}>
      <ServerConfigStoreProvider>
        <AdminAccessProvider fetchAccess={fetchAdminAccessFixture}>
          <SWRConfig value={{ provider: () => new Map() }}>{children}</SWRConfig>
        </AdminAccessProvider>
      </ServerConfigStoreProvider>
    </MemoryRouter>
  </MotionProvider>
);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.skills.list.mockResolvedValue({ items: [], nextCursor: null });
  mocks.connectors.list.mockResolvedValue({ items: [], nextCursor: null });
});

describe('Admin ConnectorSettingsPage', () => {
  it(
    'renders the user-parity connector surface without the per-user caveat notice',
    { timeout: 30_000 },
    async () => {
      render(<ConnectorSettingsPage />, { wrapper: AppProviders });

      // Built-in tools section from the shared SkillList surface (defaultValue fallback).
      expect(
        await screen.findByText('Built-in Tools', {}, { timeout: 10_000 }),
      ).toBeInTheDocument();

      // The per-user caveat notice is gone: org governance now makes builtin
      // permissions and shared OAuth genuinely global.
      expect(screen.queryByText(/Changes here apply to every user/)).toBeNull();

      // Left header: "Connectors" title plus the add-custom-connector + store buttons.
      expect(screen.getByText('Connectors')).toBeInTheDocument();
      expect(screen.getAllByRole('button').length).toBeGreaterThanOrEqual(2);

      // Platform connector catalog was fetched through the admin connectors service.
      expect(mocks.connectors.list).toHaveBeenCalled();
    },
  );
});
